import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { backupSoulFile } from '../../soul';
import type { CallbackQueryData, Skill, SkillContext, TelegramMessage } from '../../core/types';
import type {
  CalibrateConfig,
  CalibrateScope,
  CalibrationSession,
  ClaimBatch,
  ExtractionResult,
  FileRewrite,
  RewriteResult,
} from './types';
import { createSession, deleteSession, getSession, isSessionExpired, saveSession } from './session';
import { buildExtractionPrompt, buildJsonFixPrompt, buildRewritePrompt } from './prompts';

const VALID_SCOPES: CalibrateScope[] = ['all', 'identity', 'soul', 'motivations', 'memory'];
const DEFAULT_SOUL_DIR = './config/soul';
const DEFAULT_MAX_BATCHES = 10;
const DEFAULT_TIMEOUT_MS = 600_000; // 10 minutes

// Soul files relevant to each scope
const SCOPE_FILES: Record<CalibrateScope, string[]> = {
  all: ['IDENTITY.md', 'SOUL.md', 'MOTIVATIONS.md'],
  identity: ['IDENTITY.md'],
  soul: ['SOUL.md'],
  motivations: ['MOTIVATIONS.md'],
  memory: ['IDENTITY.md', 'SOUL.md', 'MOTIVATIONS.md'], // memory logs are read but only these are rewritten
};

const skill: Skill = {
  id: 'calibrate',
  name: 'Soul Calibration',
  version: '1.0.0',
  description: 'Interactive review and correction of soul memory claims',

  commands: {
    calibrate: {
      description: 'Review and correct soul memory claims interactively',
      async handler(args: string[], ctx: SkillContext) {
        const config = ctx.config as CalibrateConfig;
        const soulDir = config.soulDir || DEFAULT_SOUL_DIR;
        const maxBatches = config.maxBatches || DEFAULT_MAX_BATCHES;
        const timeoutMs = config.sessionTimeoutMs || DEFAULT_TIMEOUT_MS;
        const chatId = ctx.session!.chatId;
        const userId = ctx.session!.userId!;

        // Concurrency guard
        const existing = getSession(ctx.data, chatId, userId);
        if (existing && !isSessionExpired(existing, timeoutMs)) {
          return '⚠️ You already have an active calibration session. Finish or wait for it to expire.';
        }
        // Clean up stale session if any
        if (existing) {
          deleteSession(ctx.data, chatId, userId);
        }

        // Parse scope
        const scopeArg = (args[0] || 'all').toLowerCase() as CalibrateScope;
        if (!VALID_SCOPES.includes(scopeArg)) {
          return `❌ Invalid scope. Valid scopes: ${VALID_SCOPES.join(', ')}`;
        }

        // Send initial "analyzing" message — return empty to suppress the default reply
        await ctx.telegram.sendMessage(chatId, '🔬 Analyzing soul files...');

        try {
          // Read soul files
          const fileNames = SCOPE_FILES[scopeArg];
          const files = readSoulFiles(soulDir, fileNames);

          // Also read recent memory logs for context (but they won't be rewritten)
          if (scopeArg === 'all' || scopeArg === 'memory') {
            const memoryContent = readRecentMemoryLogs(soulDir, 5);
            if (memoryContent) {
              files.push({ filename: 'memory (recent logs)', content: memoryContent });
            }
          }

          if (files.length === 0) {
            return '❌ No soul files found to calibrate.';
          }

          // LLM extraction
          const { system, prompt } = buildExtractionPrompt({
            scope: scopeArg,
            files,
            maxBatches,
          });

          const raw = await ctx.ollama.generate(prompt, { system, temperature: 0.3 });
          const result = await parseJsonResponse<ExtractionResult>(ctx, raw);

          if (!result || !result.batches || result.batches.length === 0) {
            return '❌ Could not extract claims from soul files. Try again.';
          }

          // Convert to ClaimBatch format
          const batches: ClaimBatch[] = result.batches.slice(0, maxBatches).map((b) => ({
            title: b.title,
            sourceFile: b.sourceFile,
            claims: b.claims.map((text) => ({ text, verdict: 'pending' as const })),
          }));

          // Create session
          const session = createSession(ctx.data, chatId, userId, scopeArg, batches);

          // Send first batch
          await sendBatchReview(ctx, session);

          return ''; // suppress default reply
        } catch (error) {
          ctx.logger.error({ error }, 'Calibration extraction failed');
          return '❌ Calibration failed. Please try again.';
        }
      },
    },
  },

  async onCallbackQuery(query: CallbackQueryData, ctx: SkillContext) {
    const config = ctx.config as CalibrateConfig;
    const timeoutMs = config.sessionTimeoutMs || DEFAULT_TIMEOUT_MS;
    const session = getSession(ctx.data, query.chatId, query.userId);

    if (!session) {
      await ctx.telegram.answerCallbackQuery(query.id, { text: 'No active session.' });
      return;
    }

    if (isSessionExpired(session, timeoutMs)) {
      deleteSession(ctx.data, query.chatId, query.userId);
      await ctx.telegram.answerCallbackQuery(query.id, { text: 'Session expired.' });
      return;
    }

    // Parse action:payload
    const [action, ...payloadParts] = query.data.split(':');
    const _payload = payloadParts.join(':');

    await ctx.telegram.answerCallbackQuery(query.id);

    switch (action) {
      case 'ok': // Correct — mark all claims in current batch as correct
        await handleVerdict(ctx, session, 'correct');
        break;
      case 'ed': // Edit — enter awaiting_edit mode
        await handleEditRequest(ctx, session);
        break;
      case 'rm': // Remove — mark all claims in current batch for removal
        await handleVerdict(ctx, session, 'remove');
        break;
      case 'sk': // Skip
        await handleVerdict(ctx, session, 'skip');
        break;
      case 'cn': // Cancel
        await handleCancel(ctx, session);
        break;
      case 'ap': // Apply rewrites
        await handleApply(ctx, session);
        break;
      case 'di': // Discard rewrites
        await handleDiscard(ctx, session);
        break;
      default:
        ctx.logger.warn({ action }, 'Unknown calibrate callback action');
    }
  },

  async onMessage(message: TelegramMessage, ctx: SkillContext) {
    const config = ctx.config as CalibrateConfig;
    const timeoutMs = config.sessionTimeoutMs || DEFAULT_TIMEOUT_MS;
    const chatId = message.chat.id;
    const userId = message.from.id;

    const session = getSession(ctx.data, chatId, userId);
    if (!session || session.phase !== 'awaiting_edit') {
      return; // not consumed
    }

    if (isSessionExpired(session, timeoutMs)) {
      deleteSession(ctx.data, chatId, userId);
      return;
    }

    // Capture the correction text
    const batch = session.batches[session.currentBatchIndex];
    for (const claim of batch.claims) {
      if (claim.verdict === 'pending') {
        claim.verdict = 'edit';
        claim.correction = message.text;
      }
    }

    session.phase = 'reviewing';
    session.currentBatchIndex++;
    saveSession(ctx.data, session);

    // Advance to next batch or finalize
    if (session.currentBatchIndex < session.batches.length) {
      await sendBatchReview(ctx, session);
    } else {
      await finalizeBatches(ctx, session);
    }

    return true; // consumed — skip conversation handler
  },
};

// --- Callback handlers ---

async function handleVerdict(
  ctx: SkillContext,
  session: CalibrationSession,
  verdict: 'correct' | 'remove' | 'skip',
): Promise<void> {
  const batch = session.batches[session.currentBatchIndex];
  for (const claim of batch.claims) {
    claim.verdict = verdict;
  }

  session.currentBatchIndex++;
  saveSession(ctx.data, session);

  if (session.currentBatchIndex < session.batches.length) {
    await sendBatchReview(ctx, session);
  } else {
    await finalizeBatches(ctx, session);
  }
}

async function handleEditRequest(ctx: SkillContext, session: CalibrationSession): Promise<void> {
  session.phase = 'awaiting_edit';
  saveSession(ctx.data, session);

  const batch = session.batches[session.currentBatchIndex];
  const claimsText = batch.claims.map((c, i) => `${i + 1}. ${c.text}`).join('\n');

  await ctx.telegram.sendMessage(
    session.chatId,
    `✏️ ${batch.title}\n\n${claimsText}\n\nType your correction (replaces ALL claims in this batch):`,
  );
}

async function handleCancel(ctx: SkillContext, session: CalibrationSession): Promise<void> {
  deleteSession(ctx.data, session.chatId, session.userId);

  // Edit the review message to show cancelled
  if (session.reviewMessageId) {
    try {
      await ctx.telegram.editMessageText(
        session.chatId,
        session.reviewMessageId,
        '🚫 Calibration cancelled.',
      );
    } catch {
      await ctx.telegram.sendMessage(session.chatId, '🚫 Calibration cancelled.');
    }
  } else {
    await ctx.telegram.sendMessage(session.chatId, '🚫 Calibration cancelled.');
  }
}

async function handleApply(ctx: SkillContext, session: CalibrationSession): Promise<void> {
  const config = ctx.config as CalibrateConfig;
  const soulDir = config.soulDir || DEFAULT_SOUL_DIR;

  for (const rewrite of session.rewrites) {
    // Only allow writing to known soul files (safety guard)
    if (!['IDENTITY.md', 'SOUL.md', 'MOTIVATIONS.md'].includes(rewrite.filename)) {
      ctx.logger.warn({ filename: rewrite.filename }, 'Skipping unknown file in rewrite');
      continue;
    }
    const filepath = join(soulDir, rewrite.filename);
    backupSoulFile(filepath, ctx.logger);
    writeFileSync(filepath, rewrite.content, 'utf-8');
    ctx.logger.info({ filename: rewrite.filename }, 'Soul file updated by calibration');
  }

  deleteSession(ctx.data, session.chatId, session.userId);

  const fileList = session.rewrites.map((r) => r.filename).join(', ');
  await ctx.telegram.sendMessage(
    session.chatId,
    `✅ Calibration applied! Updated: ${fileList}`,
  );
}

async function handleDiscard(ctx: SkillContext, session: CalibrationSession): Promise<void> {
  deleteSession(ctx.data, session.chatId, session.userId);
  await ctx.telegram.sendMessage(session.chatId, '❌ Changes discarded. No files were modified.');
}

// --- Batch review UI ---

async function sendBatchReview(ctx: SkillContext, session: CalibrationSession): Promise<void> {
  const idx = session.currentBatchIndex;
  const total = session.batches.length;
  const batch = session.batches[idx];

  const claimsText = batch.claims.map((c, i) => `  ${i + 1}. ${c.text}`).join('\n');

  const text = `📋 Batch ${idx + 1}/${total}: ${batch.title}\n` +
    `📁 Source: ${batch.sourceFile}\n\n` +
    `${claimsText}`;

  const keyboard = {
    inline_keyboard: [
      [
        { text: '✅ Correct', callback_data: 'calibrate:ok:0' },
        { text: '✏️ Edit', callback_data: 'calibrate:ed:0' },
        { text: '🗑️ Remove', callback_data: 'calibrate:rm:0' },
      ],
      [
        { text: '⏭ Skip', callback_data: 'calibrate:sk:0' },
        { text: '🚫 Cancel', callback_data: 'calibrate:cn:0' },
      ],
    ],
  };

  // Send the review message and track its ID
  // We use sendMessage and parse the response isn't directly available,
  // so we'll just send and not track the message ID for editing.
  // Instead, we just send a new message each time.
  await ctx.telegram.sendMessage(session.chatId, text, {
    reply_markup: keyboard,
  });

  saveSession(ctx.data, session);
}

// --- Finalization ---

async function finalizeBatches(ctx: SkillContext, session: CalibrationSession): Promise<void> {
  // Collect all corrections (edits and removals)
  const corrections: { claim: string; action: 'edit' | 'remove'; correction?: string; sourceFile: string }[] = [];

  for (const batch of session.batches) {
    for (const claim of batch.claims) {
      if (claim.verdict === 'edit') {
        corrections.push({
          claim: claim.text,
          action: 'edit',
          correction: claim.correction,
          sourceFile: batch.sourceFile,
        });
      } else if (claim.verdict === 'remove') {
        corrections.push({
          claim: claim.text,
          action: 'remove',
          sourceFile: batch.sourceFile,
        });
      }
    }
  }

  if (corrections.length === 0) {
    deleteSession(ctx.data, session.chatId, session.userId);
    await ctx.telegram.sendMessage(session.chatId, '✅ All verified, no changes needed!');
    return;
  }

  // Rewrite phase
  session.phase = 'rewriting';
  saveSession(ctx.data, session);

  await ctx.telegram.sendMessage(session.chatId, `🔄 Rewriting ${corrections.length} correction(s)...`);

  try {
    const config = ctx.config as CalibrateConfig;
    const soulDir = config.soulDir || DEFAULT_SOUL_DIR;

    // Read current files that may need rewriting
    const affectedFiles = [...new Set(corrections.map((c) => c.sourceFile))];
    const files = readSoulFiles(soulDir, affectedFiles);

    const { system, prompt } = buildRewritePrompt({ files, corrections });
    const raw = await ctx.ollama.generate(prompt, { system, temperature: 0.3 });
    const result = await parseJsonResponse<RewriteResult>(ctx, raw);

    if (!result || !result.files || result.files.length === 0) {
      deleteSession(ctx.data, session.chatId, session.userId);
      await ctx.telegram.sendMessage(session.chatId, '❌ Rewrite failed. No changes applied.');
      return;
    }

    session.rewrites = result.files;
    session.phase = 'confirming';
    saveSession(ctx.data, session);

    // Show proposed changes
    await sendRewriteProposal(ctx, session);
  } catch (error) {
    ctx.logger.error({ error }, 'Calibration rewrite failed');
    deleteSession(ctx.data, session.chatId, session.userId);
    await ctx.telegram.sendMessage(session.chatId, '❌ Rewrite failed. No changes applied.');
  }
}

async function sendRewriteProposal(ctx: SkillContext, session: CalibrationSession): Promise<void> {
  // Show each proposed rewrite
  for (const rewrite of session.rewrites) {
    const preview = rewrite.content.length > 3500
      ? rewrite.content.slice(0, 3500) + '\n\n... (truncated)'
      : rewrite.content;

    const chunks = splitMessage(`📄 ${rewrite.filename}\n\n${preview}`);
    for (const chunk of chunks) {
      await ctx.telegram.sendMessage(session.chatId, chunk);
    }
  }

  // Confirmation keyboard
  const keyboard = {
    inline_keyboard: [
      [
        { text: '✅ Apply', callback_data: 'calibrate:ap:0' },
        { text: '❌ Discard', callback_data: 'calibrate:di:0' },
      ],
    ],
  };

  await ctx.telegram.sendMessage(
    session.chatId,
    `🔎 Review the proposed changes above.\n\n${session.rewrites.length} file(s) will be modified.`,
    { reply_markup: keyboard },
  );
}

// --- Helpers ---

function readSoulFiles(soulDir: string, filenames: string[]): { filename: string; content: string }[] {
  const files: { filename: string; content: string }[] = [];
  for (const filename of filenames) {
    const filepath = join(soulDir, filename);
    try {
      const content = readFileSync(filepath, 'utf-8').trim();
      if (content) {
        files.push({ filename, content });
      }
    } catch {
      // File doesn't exist, skip
    }
  }
  return files;
}

function readRecentMemoryLogs(soulDir: string, maxDays: number): string | null {
  const memoryDir = join(soulDir, 'memory');
  try {
    const files = (readdirSync(memoryDir) as string[])
      .filter((f: string) => f.endsWith('.md') && f !== 'legacy.md')
      .sort()
      .slice(-maxDays);

    const parts: string[] = [];
    for (const file of files) {
      const content = readFileSync(join(memoryDir, file), 'utf-8').trim();
      if (content) {
        parts.push(`### ${file.replace('.md', '')}\n${content}`);
      }
    }
    return parts.length > 0 ? parts.join('\n\n') : null;
  } catch {
    return null;
  }
}

/**
 * Parse a JSON response from the LLM, with one retry on failure.
 */
async function parseJsonResponse<T>(ctx: SkillContext, raw: string): Promise<T | null> {
  let cleaned = raw.trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
  }

  try {
    return JSON.parse(cleaned) as T;
  } catch {
    ctx.logger.warn('First JSON parse failed, attempting fix');
  }

  try {
    const fixPrompt = buildJsonFixPrompt(cleaned);
    const fixed = await ctx.ollama.generate(fixPrompt, { temperature: 0.1 });

    let fixedCleaned = fixed.trim();
    if (fixedCleaned.startsWith('```')) {
      fixedCleaned = fixedCleaned.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
    }

    return JSON.parse(fixedCleaned) as T;
  } catch {
    ctx.logger.error('JSON fix attempt also failed');
    return null;
  }
}

/**
 * Split a message into chunks that fit within Telegram's 4096-char limit.
 */
function splitMessage(text: string, maxLen = 4096): string[] {
  if (text.length <= maxLen) return [text];

  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }
    const cutAt = remaining.lastIndexOf('\n', maxLen);
    const splitPos = cutAt > 0 ? cutAt : maxLen;
    chunks.push(remaining.slice(0, splitPos));
    remaining = remaining.slice(splitPos + 1);
  }
  return chunks;
}


export default skill;
