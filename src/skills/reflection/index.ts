import { readFileSync, writeFileSync, existsSync, appendFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Skill, SkillContext } from '../../core/types';
import { buildAnalysisPrompt, buildExplorationPrompt, buildImprovementPrompt, buildJsonFixPrompt } from './prompts';
import { createWebSearchTool } from '../../tools/web-search';
import { createWebFetchTool } from '../../tools/web-fetch';
import type { ChatMessage } from '../../ollama';
import type { Tool, ToolResult } from '../../tools/types';

interface ReflectionConfig {
  soulDir?: string;
  telegramChatId?: number;
  notifyOnReflection?: boolean;
  cronSchedule?: string;
  webSearch?: {
    enabled?: boolean;
    apiKey?: string;
    maxResults?: number;
    maxToolRounds?: number;
    maxDiscoveryChars?: number;
  };
}

interface AnalysisResult {
  consistency: string;
  people: string;
  gaps: string;
  patterns: string;
  alignment: string;
  breadth: string;
}

interface ImprovementResult {
  motivations: string;
  soul_patch: string | null;
  journal_entry: string;
  soul_changed: boolean;
}

// Max chars for context sent to LLM
const MAX_MEMORY_CHARS = 3000;
const MAX_SOUL_CHARS = 1500;
const MAX_MOTIVATIONS_CHARS = 1000;
const MAX_DISCOVERY_CHARS = 2000;

// Soul safety guards
const MIN_SOUL_LENGTH = 50;
const MAX_SOUL_LENGTH = 3000;

const skill: Skill = {
  id: 'reflection',
  name: 'Self-Reflection',
  version: '1.0.0',
  description: 'Nightly self-reflection and evolving motivations system',

  async onLoad(ctx: SkillContext) {
    const config = ctx.config as ReflectionConfig;
    const soulDir = config.soulDir || './config/soul';

    // Ensure MOTIVATIONS.md exists with initial template
    const motivationsPath = join(soulDir, 'MOTIVATIONS.md');
    if (!existsSync(motivationsPath)) {
      writeFileSync(motivationsPath, getInitialMotivations(), 'utf-8');
      ctx.logger.info('Created initial MOTIVATIONS.md');
    }

    ctx.logger.info('Reflection skill loaded');
  },

  commands: {
    reflect: {
      description: 'Run self-reflection on recent conversations',
      async handler(_args: string[], ctx: SkillContext) {
        return await runReflection(ctx, 'manual');
      },
    },
  },

  jobs: [
    {
      id: 'nightly-reflection',
      schedule: '30 3 * * *',
      async handler(ctx: SkillContext) {
        const config = ctx.config as ReflectionConfig;
        ctx.logger.info('Running nightly reflection');

        const result = await runReflection(ctx, 'cron');

        // Send notification if configured
        if (config.notifyOnReflection && config.telegramChatId) {
          try {
            await ctx.telegram.sendMessage(config.telegramChatId, `🪞 Nightly Reflection\n\n${result}`);
          } catch (err) {
            ctx.logger.warn({ err }, 'Failed to send reflection notification');
          }
        }
      },
    },
  ],
};

/**
 * Main reflection pipeline.
 * 1. Gather context (soul, motivations, un-reflected logs)
 * 2. Analyze via LLM ("The Mirror")
 * 3. Improve via LLM ("The Architect")
 * 4. Apply changes (write files, update watermark)
 */
async function runReflection(ctx: SkillContext, trigger: 'manual' | 'cron'): Promise<string> {
  const config = ctx.config as ReflectionConfig;
  const soulDir = config.soulDir || './config/soul';

  // Step 1 — Gather context
  ctx.logger.info({ trigger }, 'Reflection: gathering context');

  const identity = readSoulFile(soulDir, 'IDENTITY.md') || '(no identity configured)';
  const soul = readSoulFile(soulDir, 'SOUL.md') || '(no soul configured)';
  const motivations = readSoulFile(soulDir, 'MOTIVATIONS.md') || '(no motivations yet)';

  // Parse watermark from MOTIVATIONS.md
  const lastReflectionDate = parseLastReflectionDate(motivations);
  ctx.logger.info({ lastReflectionDate }, 'Reflection: watermark parsed');

  // Read daily logs since watermark
  const sinceDate = lastReflectionDate || '2000-01-01';
  const recentLogs = readDailyLogsSince(soulDir, sinceDate);

  if (!recentLogs.trim()) {
    const msg = '🪞 Nothing new to reflect on since last reflection.';
    ctx.logger.info(msg);
    return msg;
  }

  // Cap context sizes
  const cappedSoul = soul.slice(0, MAX_SOUL_CHARS);
  const cappedMotivations = motivations.slice(0, MAX_MOTIVATIONS_CHARS);
  const cappedLogs = recentLogs.slice(0, MAX_MEMORY_CHARS);

  // Step 2 — Analyze ("The Mirror")
  ctx.logger.info('Reflection: running analysis (The Mirror)');
  const analysisInput = buildAnalysisPrompt({
    identity,
    soul: cappedSoul,
    motivations: cappedMotivations,
    recentLogs: cappedLogs,
  });

  const analysisRaw = await ctx.ollama.generate(analysisInput.prompt, {
    system: analysisInput.system,
    temperature: 0.4,
  });

  const analysis = await parseJsonResponse<AnalysisResult>(ctx, analysisRaw);
  if (!analysis) {
    const msg = '🪞 Reflection failed: could not parse analysis output.';
    ctx.logger.error(msg);
    return msg;
  }

  ctx.logger.info({ analysis }, 'Reflection: analysis complete');

  // Step 2.5 — Explore ("The Explorer")
  let discoveries: string | null = null;
  const wsConfig = config.webSearch;
  if (wsConfig?.enabled && wsConfig.apiKey) {
    ctx.logger.info('Reflection: exploring open questions (The Explorer)');
    try {
      const openQuestions = extractOpenQuestions(cappedMotivations);
      discoveries = await runExploration(ctx, {
        openQuestions,
        gaps: analysis.gaps,
        patterns: analysis.patterns,
        apiKey: wsConfig.apiKey,
        maxResults: wsConfig.maxResults,
        maxToolRounds: wsConfig.maxToolRounds,
        maxDiscoveryChars: wsConfig.maxDiscoveryChars,
      });
      ctx.logger.info(
        { discoveryLength: discoveries?.length ?? 0 },
        'Reflection: exploration complete'
      );
    } catch (err) {
      ctx.logger.warn({ err }, 'Reflection: exploration failed, continuing without discoveries');
    }
  } else {
    ctx.logger.info('Reflection: web search not configured, skipping exploration');
  }

  // Step 3 — Improve ("The Architect")
  ctx.logger.info('Reflection: generating improvements (The Architect)');
  const today = new Date().toISOString().slice(0, 10);
  const improvementInput = buildImprovementPrompt({
    identity,
    soul: cappedSoul,
    motivations: cappedMotivations,
    analysis,
    trigger,
    date: today,
    discoveries,
    originalMotivations: getInitialMotivations(),
  });

  const improvementRaw = await ctx.ollama.generate(improvementInput.prompt, {
    system: improvementInput.system,
    temperature: 0.5,
  });

  const improvement = await parseJsonResponse<ImprovementResult>(ctx, improvementRaw);
  if (!improvement) {
    const msg = '🪞 Reflection failed: could not parse improvement output.';
    ctx.logger.error(msg);
    return msg;
  }

  ctx.logger.info(
    { soulChanged: improvement.soul_changed, journalEntry: improvement.journal_entry },
    'Reflection: improvements generated'
  );

  // Step 4 — Apply changes
  ctx.logger.info('Reflection: applying changes');

  // Always update MOTIVATIONS.md
  const motivationsPath = join(soulDir, 'MOTIVATIONS.md');
  writeFileSync(motivationsPath, improvement.motivations, 'utf-8');
  ctx.logger.info('MOTIVATIONS.md updated');

  // Conditionally update SOUL.md (with safety guards)
  let soulUpdated = false;
  if (improvement.soul_changed && improvement.soul_patch) {
    const patchLen = improvement.soul_patch.length;
    if (patchLen >= MIN_SOUL_LENGTH && patchLen <= MAX_SOUL_LENGTH) {
      const soulPath = join(soulDir, 'SOUL.md');
      writeFileSync(soulPath, improvement.soul_patch, 'utf-8');
      soulUpdated = true;
      ctx.logger.info('SOUL.md updated by reflection');
    } else {
      ctx.logger.warn(
        { patchLength: patchLen, min: MIN_SOUL_LENGTH, max: MAX_SOUL_LENGTH },
        'Soul patch rejected: outside size bounds'
      );
    }
  }

  // Append journal entry to daily memory log
  if (improvement.journal_entry) {
    const now = new Date();
    const dateStr = now.toISOString().slice(0, 10);
    const timeStr = now.toTimeString().slice(0, 5);
    const logPath = join(soulDir, 'memory', `${dateStr}.md`);
    appendFileSync(logPath, `- [${timeStr}] [reflection] ${improvement.journal_entry}\n`, 'utf-8');
    ctx.logger.info('Journal entry appended to daily log');
  }

  // Build summary
  const summary = formatSummary(analysis, improvement, soulUpdated, trigger, discoveries);
  ctx.logger.info({ trigger, soulUpdated }, 'Reflection complete');

  return summary;
}

/**
 * Read a file from the soul directory, returning null if missing/empty.
 */
function readSoulFile(soulDir: string, filename: string): string | null {
  const filepath = join(soulDir, filename);
  try {
    const content = readFileSync(filepath, 'utf-8').trim();
    return content || null;
  } catch {
    return null;
  }
}

/**
 * Read daily memory logs from sinceDate onwards.
 */
function readDailyLogsSince(soulDir: string, sinceDate: string): string {
  const memoryDir = join(soulDir, 'memory');
  const parts: string[] = [];

  try {
    const files = (readdirSync(memoryDir) as string[])
      .filter((f: string) => f.endsWith('.md') && f !== 'legacy.md')
      .filter((f: string) => f.replace('.md', '') > sinceDate)
      .sort();

    for (const file of files) {
      const content = readFileSync(join(memoryDir, file), 'utf-8').trim();
      if (content) {
        const date = file.replace('.md', '');
        parts.push(`### ${date}\n${content}`);
      }
    }
  } catch {
    // No memory dir yet
  }

  return parts.join('\n\n');
}

/**
 * Parse the "Last Reflection → date" from MOTIVATIONS.md content.
 * Looks for a line like: `- date: 2025-01-15`
 */
function parseLastReflectionDate(motivations: string): string | null {
  const match = motivations.match(/^- date:\s*(.+)$/m);
  if (!match) return null;
  const dateStr = match[1].trim();
  // Validate it looks like a date (YYYY-MM-DD)
  if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    return dateStr;
  }
  return null;
}

/**
 * Parse a JSON response from the LLM, with one retry on failure.
 */
async function parseJsonResponse<T>(ctx: SkillContext, raw: string): Promise<T | null> {
  // Strip markdown fences if present
  let cleaned = raw.trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
  }

  try {
    return JSON.parse(cleaned) as T;
  } catch {
    ctx.logger.warn('First JSON parse failed, attempting fix');
  }

  // Retry: ask LLM to fix the JSON
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
 * Format a human-readable reflection summary.
 */
function formatSummary(
  analysis: AnalysisResult,
  improvement: ImprovementResult,
  soulUpdated: boolean,
  trigger: 'manual' | 'cron',
  discoveries?: string | null
): string {
  const lines = [
    `🪞 **Reflection Complete** (${trigger})`,
    '',
    '**Analysis:**',
    `- Consistency: ${analysis.consistency}`,
    `- People: ${analysis.people}`,
    `- Gaps: ${analysis.gaps}`,
    `- Patterns: ${analysis.patterns}`,
    '',
  ];

  if (discoveries) {
    lines.push('**Exploration:** Web discoveries incorporated');
    lines.push('');
  }

  lines.push(
    `**Journal:** ${improvement.journal_entry}`,
    '',
    `**Changes:** Motivations updated${soulUpdated ? ', Soul updated' : ''}`,
  );

  return lines.join('\n');
}

/**
 * Initial MOTIVATIONS.md template.
 */
function getInitialMotivations(): string {
  return `## Core Drives
<!-- Stable anchors. Only modified when reflection detects deep misalignment. -->
- Be a genuine friend, not a service. Prioritize emotional connection over correctness.
- Remember what matters to people. Names, dates, preferences, moods.
- Be direct and honest — sugarcoating is disrespect.
- Grow through every conversation.

## Current Focus
<!-- Evolves with each reflection. What to pay attention to right now. -->
- (populated by first reflection)

## Open Questions
<!-- Curiosities to explore. -->
- (populated by first reflection)

## Self-Observations
<!-- Behavioral patterns I've noticed about myself. -->
- (populated by first reflection)

## Last Reflection
- date: (none yet)
- trigger: (none)
- changes: (none)
`;
}

/**
 * Extract the "Open Questions" section from MOTIVATIONS.md content.
 */
function extractOpenQuestions(motivations: string): string {
  const match = motivations.match(/## Open Questions\n([\s\S]*?)(?=\n## |\n*$)/);
  return match ? match[1].trim() : '';
}

/**
 * Step 2.5 — The Explorer: Agentic web research on open questions and gaps.
 * Uses ollama.chat() with web_search + web_fetch in a tool-calling loop.
 */
async function runExploration(
  ctx: SkillContext,
  opts: {
    openQuestions: string;
    gaps: string;
    patterns: string;
    apiKey: string;
    maxResults?: number;
    maxToolRounds?: number;
    maxDiscoveryChars?: number;
  }
): Promise<string | null> {
  const maxChars = opts.maxDiscoveryChars ?? MAX_DISCOVERY_CHARS;

  // Create tool instances
  const searchTool = createWebSearchTool({
    apiKey: opts.apiKey,
    maxResults: opts.maxResults ?? 3,
  });
  const fetchTool = createWebFetchTool();

  const toolMap: Record<string, Tool> = {
    web_search: searchTool,
    web_fetch: fetchTool,
  };

  const toolExecutor = async (name: string, args: Record<string, unknown>): Promise<ToolResult> => {
    const tool = toolMap[name];
    if (!tool) {
      return { success: false, content: `Unknown tool: ${name}` };
    }
    return tool.execute(args, ctx.logger);
  };

  // Build prompt
  const { system, prompt } = buildExplorationPrompt({
    openQuestions: opts.openQuestions,
    gaps: opts.gaps,
    patterns: opts.patterns,
  });

  const messages: ChatMessage[] = [
    { role: 'system', content: system },
    { role: 'user', content: prompt },
  ];

  const response = await ctx.ollama.chat(messages, {
    temperature: 0.4,
    tools: [searchTool.definition, fetchTool.definition],
    toolExecutor,
    maxToolRounds: opts.maxToolRounds ?? 4,
  });

  if (!response || !response.trim()) {
    return null;
  }

  // Cap the output
  return response.slice(0, maxChars);
}

export default skill;
