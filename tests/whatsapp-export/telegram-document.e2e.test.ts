/**
 * A WhatsApp export sent as a Telegram document, end to end through the REAL
 * runtime (pattern: tests/relay/full-stack.e2e.test.ts): `BotManager` with
 * media on, `HandlerRegistrar` → media document handler → intake →
 * `MessageBuffer` → `ConversationPipeline` → the pipeline's own tool executor
 * running `whatsapp_export_summary` with the injected `_requester`.
 *
 * Fake edges: the LLM (scripted), Telegram's HTTP API (recorded, answered
 * locally; getFile returns a path) and the file download. Synthetic data only.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Bot } from 'grammy';
import { BotManager } from '../../src/bot/bot-manager';
import { loadConfig } from '../../src/config';
import type { LLMClient, LLMResponse } from '../../src/core/llm-client';
import { SkillRegistry } from '../../src/core/skill-registry';
import { CronService } from '../../src/cron/service';
import type { ChatMessage } from '../../src/ollama';
import { SessionManager } from '../../src/session';
import type { ToolResult } from '../../src/tools/types';
import { makeZip } from './zip-fixture';

const BOT_ID = 'finny-test';
const OP = { id: 9001, name: 'Op' };
const ANA = { id: 1001, name: 'Ana' };

const silentLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  trace: () => {},
  fatal: () => {},
  child: () => silentLogger,
} as any;

interface Step {
  name: string;
  args: Record<string, unknown>;
}
interface Call {
  lastUser: string;
  toolResults: Array<{ name: string; result: ToolResult }>;
}

class ScriptedLLM implements LLMClient {
  readonly backend = 'ollama' as const;
  readonly turns: Array<{ tools: Step[]; reply: string }> = [];
  readonly calls: Call[] = [];
  async generate(): Promise<LLMResponse> {
    return { text: '' };
  }
  async chat(messages: ChatMessage[], opts?: Parameters<LLMClient['chat']>[1]) {
    if (!opts?.tools?.length || !opts.toolExecutor) return { text: '{}' };
    const call: Call = {
      lastUser: [...messages].reverse().find((m) => m.role === 'user')?.content ?? '',
      toolResults: [],
    };
    this.calls.push(call);
    const turn = this.turns.shift();
    if (!turn) throw new Error(`no scripted turn for "${call.lastUser}"`);
    for (const s of turn.tools) {
      if (!opts.tools.some((t) => t.function.name === s.name)) {
        throw new Error(`tool ${s.name} not offered`);
      }
      call.toolResults.push({ name: s.name, result: await opts.toolExecutor(s.name, s.args) });
    }
    return { text: turn.reply } as LLMResponse;
  }
}

const CHAT_V1 = [
  '14/10/26, 09:00 - Laura: Hola a todos',
  '15/10/26, 18:02 - Laura: El viernes no hay clases por jornada docente',
].join('\n');
const CHAT_V2 = [
  CHAT_V1,
  '16/10/26, 08:22 - Pablo: Hay que llevar $500 para la excursión del jueves',
].join('\n');

let nextUpdateId = 1;
let nextMsgId = 100;

describe('WhatsApp export via Telegram document (full stack)', () => {
  let dir: string;
  let data: string;
  let manager: BotManager;
  let sessions: SessionManager;
  let llm: ScriptedLLM;
  let bot: Bot;
  let sent: Array<{ chatId: number; text: string }>;
  const files = new Map<string, Buffer>();

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'wa-e2e-'));
    data = join(dir, 'data');
    mkdirSync(data, { recursive: true });
    const configPath = join(dir, 'config.json');
    writeFileSync(
      configPath,
      JSON.stringify({
        ollama: { baseUrl: 'http://127.0.0.1:9', models: { primary: 'scripted' } },
        skills: { enabled: [], config: {} },
        logging: { level: 'error' },
        paths: { data, logs: join(dir, 'logs'), skills: join(dir, 'skills') },
        operator: { name: 'Op', telegramChatId: OP.id },
        media: { enabled: true },
        session: { dataDir: join(data, 'sessions') },
        soul: { dir: join(dir, 'legacy-soul'), healthCheck: { enabled: false } },
        cron: { enabled: false, storePath: join(data, 'cron') },
        buffer: { inboundDebounceMs: 0 },
        agentLoop: { enabled: false },
        security: { auditOnStartup: false },
        conversation: { streaming: { enabled: false } },
        conversations: { baseDir: join(data, 'conversations') },
        karma: { baseDir: join(data, 'karma') },
        productions: { baseDir: join(dir, 'productions') },
        multiTenant: { dataDir: join(data, 'tenants') },
        dynamicTools: { storePath: join(data, 'tools') },
        agentProposals: { storePath: join(data, 'agent-proposals') },
      })
    );
    writeFileSync(
      join(dir, 'bots.json'),
      JSON.stringify([
        {
          id: BOT_ID,
          name: 'Finny',
          token: '',
          skills: [],
          soulDir: join(data, 'soul', BOT_ID),
          workDir: join(dir, 'work', BOT_ID),
        },
      ])
    );
    const config = await loadConfig(configPath);
    const skillRegistry = new SkillRegistry(config, silentLogger);
    sessions = new SessionManager(config.session, silentLogger);
    await sessions.initialize();
    const cronService = new CronService({
      logger: silentLogger,
      storePath: config.cron.storePath,
      cronEnabled: false,
      sendMessage: async () => {},
      sendInstruction: async () => '',
      resolveSkillHandler: () => undefined,
    } as any);
    manager = new BotManager(
      skillRegistry,
      silentLogger,
      skillRegistry.getOllamaClient(),
      config,
      sessions,
      cronService,
      undefined,
      configPath
    );
    const soulDir = join(data, 'soul', BOT_ID);
    mkdirSync(soulDir, { recursive: true });
    writeFileSync(join(soulDir, 'IDENTITY.md'), 'name: Finny\n');
    const botConfig = config.bots.find((b) => b.id === BOT_ID);
    if (!botConfig) throw new Error('bot config');
    await manager.startBot(botConfig);

    llm = new ScriptedLLM();
    const internals = manager as any;
    internals.llmClients.set(BOT_ID, llm);
    // The download edge: Telegram file URLs → in-memory files.
    internals.mediaHandler.downloadFile = async (url: string) => {
      const path = url.slice(url.lastIndexOf('/') + 1);
      const f = files.get(path);
      if (!f) throw new Error(`no file ${path}`);
      return f;
    };

    sent = [];
    bot = new Bot('777:TEST-not-a-real-token', {
      botInfo: {
        id: 777,
        is_bot: true,
        first_name: 'Finny',
        username: 'finny_test_bot',
        can_join_groups: true,
        can_read_all_group_messages: false,
        supports_inline_queries: false,
        can_connect_to_business: false,
        has_main_web_app: false,
      } as any,
    });
    bot.api.config.use(async (_prev, method, payload) => {
      const p = (payload ?? {}) as Record<string, unknown>;
      if (method === 'getFile') {
        return {
          ok: true,
          result: { file_id: p.file_id, file_unique_id: 'u', file_path: `docs/${p.file_id}` },
        } as any;
      }
      if (method === 'sendMessage') {
        sent.push({ chatId: Number(p.chat_id), text: String(p.text) });
        return {
          ok: true,
          result: { message_id: nextMsgId++, date: 0, chat: { id: p.chat_id, type: 'private' } },
        } as any;
      }
      return { ok: true, result: true } as any;
    });
    bot.catch((err) => {
      throw err.error;
    });
    internals.handlerRegistrar.registerAll(bot, botConfig);
    internals.bots.set(BOT_ID, bot);
  });

  afterEach(async () => {
    await manager.stopAll().catch(() => {});
    sessions.dispose();
    rmSync(dir, { recursive: true, force: true });
  });

  async function sendDocument(
    from: { id: number; name: string },
    fileName: string,
    content: Buffer,
    caption?: string
  ) {
    const fileId = `f${nextUpdateId}`;
    files.set(fileId, content);
    await bot.handleUpdate({
      update_id: nextUpdateId++,
      message: {
        message_id: nextMsgId++,
        date: Math.floor(Date.now() / 1000),
        chat: { id: from.id, type: 'private', first_name: from.name },
        from: { id: from.id, is_bot: false, first_name: from.name },
        document: {
          file_id: fileId,
          file_unique_id: `u${fileId}`,
          file_name: fileName,
          mime_type: fileName.endsWith('.zip') ? 'application/zip' : 'text/plain',
          file_size: content.length,
        },
        ...(caption ? { caption } : {}),
      },
    } as never);
    const tasks: Map<string, Promise<void>> = (manager as any).messageBuffer.activeTasks;
    for (let i = 0; i < 50 && tasks.size > 0; i++) {
      await Promise.all([...tasks.values()]);
      await new Promise((r) => setTimeout(r, 0));
    }
  }

  const history = (userId: number) =>
    sessions
      .getFullHistory(
        sessions.serializeKey({ botId: BOT_ID, chatType: 'private', chatId: userId, userId })
      )
      .map((m) => m.content)
      .join('\n');

  test('operator: export → tool reads new messages → summary; second export only the delta', async () => {
    llm.turns.push({
      tools: [{ name: 'whatsapp_export_summary', args: {} }],
      reply: 'Resumen: el viernes no hay clases.',
    });
    await sendDocument(OP, 'WhatsApp Chat with 3B Padres.txt', Buffer.from(CHAT_V1), 'resumime');

    const first = llm.calls[0];
    expect(first.lastUser).toContain('resumime');
    expect(first.lastUser).toContain('whatsapp_export_summary');
    expect(first.lastUser).not.toContain('jornada docente');
    const r1 = first.toolResults[0].result;
    expect(r1.success).toBe(true);
    expect(r1.content).toContain('Laura: El viernes no hay clases por jornada docente');
    expect(sent.some((s) => s.chatId === OP.id && s.text.includes('Resumen'))).toBe(true);
    expect(existsSync(join(data, 'whatsapp-exports', BOT_ID, '3b-padres.json'))).toBe(true);

    // iOS-style zip of the same group, a day later: only Pablo's message is new.
    llm.turns.push({
      tools: [{ name: 'whatsapp_export_summary', args: { group: '3B Padres' } }],
      reply: 'Nuevo: llevar $500 el jueves.',
    });
    const zip = makeZip([{ name: '_chat.txt', data: CHAT_V2 }]);
    await sendDocument(OP, 'WhatsApp Chat - 3B Padres.zip', zip);
    const r2 = llm.calls[1].toolResults[0].result;
    expect(llm.calls[1].lastUser).toContain('1 new message since the previous export');
    expect(r2.content).toContain('Pablo: Hay que llevar $500');
    expect(r2.content).not.toContain('jornada docente');

    // The raw group messages never land in the session transcript.
    const transcript = history(OP.id);
    expect(transcript).toContain('[WhatsApp export: 3B Padres');
    expect(transcript).not.toContain('jornada docente');
  });

  test('non-operator: the file is an ordinary document and the tool refuses', async () => {
    llm.turns.push({
      tools: [{ name: 'whatsapp_export_summary', args: {} }],
      reply: 'No puedo.',
    });
    await sendDocument(ANA, 'WhatsApp Chat with 3B Padres.txt', Buffer.from(CHAT_V1));
    expect(existsSync(join(data, 'whatsapp-exports', BOT_ID))).toBe(false);
    const call = llm.calls[0];
    expect(call.lastUser).not.toContain('WhatsApp export received');
    expect(call.toolResults[0].result.success).toBe(false);
    expect(call.toolResults[0].result.content).toContain('only answers the operator');
  });
});
