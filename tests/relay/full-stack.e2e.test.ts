/**
 * Relays end to end through the REAL runtime: a real `BotManager` (temp dirs,
 * real config parsing), its `ToolRegistry` + `send_message` wiring
 * (`createRelayService`), `RelayStore`, `UserDirectory` (operator seeded by
 * `startBot`), `SessionManager`, `SystemPromptBuilder`, `HandlerRegistrar` →
 * `ConversationGate` → `MessageBuffer` → `ConversationPipeline.handleConversation`.
 *
 * Only the outer edges are fake:
 * - the LLM: a scripted `LLMClient` that calls the pipeline's own tool
 *   executor (so `_requester` injection runs) and then answers with text;
 * - Telegram: a real grammy `Bot` whose API transformer records every call
 *   and answers it locally (incrementing message ids, 403 per chat on demand);
 * - inbound traffic: Telegram updates fed to `bot.handleUpdate`.
 *
 * Synthetic data only (Ana, Op, finny-test).
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Bot } from 'grammy';
import { BotManager } from '../../src/bot/bot-manager';
import { UserDirectory } from '../../src/bot/user-directory';
import { type Config, loadConfig } from '../../src/config';
import type { LLMClient, LLMResponse } from '../../src/core/llm-client';
import { SkillRegistry } from '../../src/core/skill-registry';
import { CronService } from '../../src/cron/service';
import type { ChatMessage } from '../../src/ollama';
import { RelayStore } from '../../src/relay/store';
import type { RelayRecord } from '../../src/relay/types';
import { SessionManager } from '../../src/session';
import type { ToolResult } from '../../src/tools/types';

const BOT_ID = 'finny-test';
/** The soul identity name (IDENTITY.md); what relay headers must show. */
const BOT_NAME = 'Finny';
/** The config `name`, which used to leak into headers ("vía AIBot"). */
const CONFIG_NAME = 'AIBot';
const OTHER_BOT_ID = 'otto-test';
const OP_ID = 9001;
const ANA_ID = 1001;
const OP_EMAIL = 'op@example.test';

const silentLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  trace: () => {},
  fatal: () => {},
  child: () => silentLogger,
} as any;

// ─── Fake LLM ────────────────────────────────────────────────────────────────

interface ToolCallStep {
  name: string;
  args: Record<string, unknown>;
}
interface ScriptedTurn {
  /** Tool calls to make through the pipeline's executor; a function sees the prompt. */
  tools: ToolCallStep[] | ((messages: ChatMessage[]) => ToolCallStep[]);
  reply: string;
}
interface ConversationCall {
  system: string;
  lastUser: string;
  toolResults: Array<{ name: string; result: ToolResult }>;
}

/**
 * A scripted model. A conversation call (one with tools + toolExecutor, as
 * the pipeline makes it) consumes the next scripted turn: each tool call goes
 * through `opts.toolExecutor` exactly as the Ollama / Claude CLI tool loops
 * do, then the turn's text is returned. Any other call (memory flush,
 * compaction) is recorded and answered empty.
 */
class ScriptedLLM implements LLMClient {
  readonly backend = 'ollama' as const;
  readonly turns: ScriptedTurn[] = [];
  readonly conversationCalls: ConversationCall[] = [];
  otherCalls = 0;

  async generate(): Promise<LLMResponse> {
    this.otherCalls++;
    return { text: '' };
  }

  async chat(
    messages: ChatMessage[],
    opts?: Parameters<LLMClient['chat']>[1]
  ): Promise<LLMResponse> {
    if (!opts?.tools?.length || !opts.toolExecutor) {
      this.otherCalls++;
      return { text: '{}' };
    }
    const call: ConversationCall = {
      system: messages
        .filter((m) => m.role === 'system')
        .map((m) => m.content)
        .join('\n'),
      lastUser: [...messages].reverse().find((m) => m.role === 'user')?.content ?? '',
      toolResults: [],
    };
    this.conversationCalls.push(call);
    const turn = this.turns.shift();
    if (!turn) throw new Error(`ScriptedLLM: no turn scripted for "${call.lastUser}"`);
    const steps = typeof turn.tools === 'function' ? turn.tools(messages) : turn.tools;
    for (const step of steps) {
      if (!opts.tools.some((t) => t.function.name === step.name)) {
        throw new Error(`ScriptedLLM: tool ${step.name} not offered to the model`);
      }
      const result = await opts.toolExecutor(step.name, step.args);
      call.toolResults.push({ name: step.name, result });
    }
    return { text: turn.reply };
  }
}

// ─── Fake Telegram ───────────────────────────────────────────────────────────

interface ApiCall {
  via: string;
  method: string;
  payload: Record<string, unknown>;
  messageId?: number;
}

let nextOutgoingId = 7000;
let nextIncomingId = 100;
let nextUpdateId = 1;

/**
 * A real grammy Bot with its HTTP edge replaced: every API call is recorded
 * and answered locally. `failChats` makes sendMessage to those chats fail
 * the way Telegram does (grammy turns the `ok: false` into a GrammyError).
 */
function fakeTelegramBot(
  botId: string,
  username: string,
  userId: number,
  calls: ApiCall[],
  failChats: Set<number>
): Bot {
  const bot = new Bot(`${userId}:TEST-not-a-real-token`, {
    botInfo: {
      id: userId,
      is_bot: true,
      first_name: botId,
      username,
      can_join_groups: true,
      can_read_all_group_messages: false,
      supports_inline_queries: false,
      can_connect_to_business: false,
      has_main_web_app: false,
    } as any,
  });
  bot.api.config.use(async (_prev, method, payload) => {
    const p = (payload ?? {}) as Record<string, unknown>;
    if (method === 'sendMessage') {
      const chatId = Number(p.chat_id);
      if (failChats.has(chatId)) {
        calls.push({ via: botId, method: 'sendMessage:403', payload: p });
        return {
          ok: false,
          error_code: 403,
          description: 'Forbidden: bot was blocked by the user',
        } as any;
      }
      const messageId = nextOutgoingId++;
      calls.push({ via: botId, method, payload: p, messageId });
      return {
        ok: true,
        result: {
          message_id: messageId,
          date: Math.floor(Date.now() / 1000),
          chat: { id: chatId, type: 'private' },
          text: p.text,
        },
      } as any;
    }
    calls.push({ via: botId, method, payload: p });
    return { ok: true, result: true } as any;
  });
  return bot;
}

function textUpdate(
  from: { id: number; name: string },
  text: string,
  replyToMessageId?: number
): Record<string, unknown> {
  const date = Math.floor(Date.now() / 1000);
  const chat = { id: from.id, type: 'private', first_name: from.name };
  return {
    update_id: nextUpdateId++,
    message: {
      message_id: nextIncomingId++,
      date,
      chat,
      from: { id: from.id, is_bot: false, first_name: from.name },
      text,
      ...(replyToMessageId !== undefined
        ? {
            reply_to_message: {
              message_id: replyToMessageId,
              date,
              chat,
              from: { id: 777, is_bot: true, first_name: BOT_NAME },
              text: '(relay)',
            },
          }
        : {}),
    },
  };
}

// ─── Harness ─────────────────────────────────────────────────────────────────

interface Harness {
  dir: string;
  manager: BotManager;
  config: Config;
  sessions: SessionManager;
  llm: ScriptedLLM;
  calls: ApiCall[];
  failChats: Set<number>;
  bot: Bot;
  send(from: { id: number; name: string }, text: string, replyTo?: number): Promise<void>;
  sentTo(chatId: number): ApiCall[];
  relays(): RelayRecord[];
  history(userId: number): ChatMessage[];
  cleanup(): Promise<void>;
}

const ANA = { id: ANA_ID, name: 'Ana' };
const OP = { id: OP_ID, name: 'Op' };

async function makeHarness(
  opts: { seedDirectory?: (dir: UserDirectory) => void } = {}
): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), 'relay-full-stack-'));
  const data = join(dir, 'data');
  mkdirSync(data, { recursive: true });
  const configPath = join(dir, 'config.json');
  writeFileSync(
    configPath,
    JSON.stringify({
      ollama: { baseUrl: 'http://127.0.0.1:9', models: { primary: 'scripted' } },
      skills: { enabled: [], config: {} },
      logging: { level: 'error' },
      paths: { data, logs: join(dir, 'logs'), skills: join(dir, 'skills') },
      operator: { name: 'Op', telegramChatId: OP_ID, email: OP_EMAIL },
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
        name: CONFIG_NAME,
        token: '',
        skills: [],
        soulDir: join(data, 'soul', BOT_ID),
        workDir: join(dir, 'work', BOT_ID),
      },
    ])
  );
  const config = await loadConfig(configPath);

  // "Before startup": whatever the directory already holds on disk.
  if (opts.seedDirectory) opts.seedDirectory(new UserDirectory(data, silentLogger));

  // Same composition as src/index.ts (SkillRegistry, SessionManager, CronService → BotManager).
  const skillRegistry = new SkillRegistry(config, silentLogger);
  const sessions = new SessionManager(config.session, silentLogger);
  await sessions.initialize();
  const cronService = new CronService({
    logger: silentLogger,
    storePath: config.cron.storePath,
    cronEnabled: false,
    sendMessage: async () => {},
    sendInstruction: async () => '',
    resolveSkillHandler: () => undefined,
  } as any);
  const manager = new BotManager(
    skillRegistry,
    silentLogger,
    skillRegistry.getOllamaClient(),
    config,
    sessions,
    cronService,
    undefined,
    configPath
  );

  // The bot's identity lives in its soul, as on a live install.
  const soulDir = join(data, 'soul', BOT_ID);
  mkdirSync(soulDir, { recursive: true });
  writeFileSync(join(soulDir, 'IDENTITY.md'), `name: ${BOT_NAME}\nemoji: 🐟\n`);

  // startBot with an empty token: headless start, operator seeded in the directory.
  const botConfig = must(config.bots.find((b) => b.id === BOT_ID));
  await manager.startBot(botConfig);

  // The LLM edge: replace the client startBot built.
  const llm = new ScriptedLLM();
  const internals = manager as any;
  internals.llmClients.set(BOT_ID, llm);

  // The Telegram edge: what BotManager.startTelegramBot does once getMe
  // succeeded (src/bot/bot-manager.ts, startTelegramBot): botInfo, catch,
  // handlerRegistrar.registerAll, bots.set — minus the network poller.
  const calls: ApiCall[] = [];
  const failChats = new Set<number>();
  const bot = fakeTelegramBot(BOT_ID, 'finny_test_bot', 777, calls, failChats);
  bot.catch((err) => {
    throw err.error;
  });
  internals.handlerRegistrar.registerAll(bot, botConfig);
  internals.bots.set(BOT_ID, bot);
  // Another live fleet instance: relays fall back to it when the own one cannot reach.
  internals.bots.set(
    OTHER_BOT_ID,
    fakeTelegramBot(OTHER_BOT_ID, 'otto_test_bot', 778, calls, failChats)
  );

  const awaitBuffer = async () => {
    const tasks: Map<string, Promise<void>> = internals.messageBuffer.activeTasks;
    for (let i = 0; i < 50 && tasks.size > 0; i++) {
      await Promise.all([...tasks.values()]);
      await new Promise((r) => setTimeout(r, 0));
    }
  };

  return {
    dir,
    manager,
    config,
    sessions,
    llm,
    calls,
    failChats,
    bot,
    async send(from, text, replyTo) {
      await bot.handleUpdate(textUpdate(from, text, replyTo) as never);
      await awaitBuffer();
    },
    sentTo: (chatId) =>
      calls.filter((c) => c.method === 'sendMessage' && Number(c.payload.chat_id) === chatId),
    relays: () => {
      // A fresh store over the same dir: what is on disk, not what is cached.
      const store = new RelayStore(data, silentLogger);
      const all = [
        ...store.sentBy(BOT_ID, 'telegram', String(ANA_ID), 0),
        ...store.sentBy(BOT_ID, 'telegram', String(OP_ID), 0),
      ];
      return all.sort((a, b) => a.createdAt - b.createdAt);
    },
    history: (userId) =>
      sessions.getFullHistory(
        sessions.serializeKey({ botId: BOT_ID, chatType: 'private', chatId: userId, userId })
      ),
    async cleanup() {
      await manager.stopAll().catch(() => {});
      sessions.dispose();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function must<T>(value: T | undefined | null): T {
  if (value === undefined || value === null) throw new Error('expected a value');
  return value;
}

const PRIVATE_0 = `bot:${BOT_ID}:private:0`;

// ─── Scenarios ───────────────────────────────────────────────────────────────

describe('relay full stack: Ana → Op → Ana (scenarios 1–3)', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await makeHarness();
  });
  afterEach(async () => {
    await h.cleanup();
  });

  async function anaAsksOp(): Promise<RelayRecord> {
    h.llm.turns.push({
      tools: [
        {
          name: 'send_message',
          args: {
            recipient: 'operator',
            message: '¿Quién es Ana para vos?',
            expectsReply: true,
            // A model trying to forge the sender: the executor must overwrite it.
            _requester: { displayName: 'Mallory', channelKind: 'telegram', address: '666' },
          },
        },
      ],
      reply: 'Listo, le pregunté a Op.',
    });
    await h.send(ANA, 'preguntale a Op quién soy');
    const relay = h.relays().find((r) => r.text === '¿Quién es Ana para vos?');
    if (!relay) throw new Error('relay not recorded');
    return relay;
  }

  test('1. Ana is tracked and her question reaches Op with header, footer and an honest result', async () => {
    const relay = await anaAsksOp();

    // Ana, unknown before, is now a contact with her Telegram id.
    const directory = new UserDirectory(join(h.dir, 'data'), silentLogger);
    const ana = directory.findByChannel(BOT_ID, 'telegram', String(ANA_ID));
    expect(ana?.displayName).toBe('Ana');

    // Op's chat got the stamped header and the reply footer.
    const toOp = h.sentTo(OP_ID);
    expect(toOp).toHaveLength(1);
    const text = String(toOp[0].payload.text);
    expect(text).toContain(`📨 De Ana (vía ${BOT_NAME}):`);
    expect(text).toContain('¿Quién es Ana para vos?');
    expect(text).toContain('↩️ Respondé a este mensaje y se lo paso a Ana.');
    expect(toOp[0].via).toBe(BOT_ID);
    // Telegram opens a reply to the relay, so Op's answer takes the reply-to path.
    expect(toOp[0].payload.reply_markup).toEqual({
      force_reply: true,
      input_field_placeholder: 'Respuesta para Ana',
    });
    // Ana's own reply in her chat carries no reply prompt.
    expect(h.sentTo(ANA_ID).every((c) => c.payload.reply_markup === undefined)).toBe(true);

    // The model was told the truth.
    const call = h.llm.conversationCalls[0];
    expect(call.toolResults).toHaveLength(1);
    expect(call.toolResults[0].result.success).toBe(true);
    expect(call.toolResults[0].result.content.startsWith('Delivered')).toBe(true);

    // The record: sender from the injected _requester, not from model args.
    expect(relay.from?.displayName).toBe('Ana');
    expect(relay.from?.address).toBe(String(ANA_ID));
    expect(relay.from?.isOperator).toBe(false);
    expect(relay.to.channelKind).toBe('telegram');
    expect(relay.to.address).toBe(String(OP_ID));
    expect(relay.to.isOperator).toBe(true);
    expect(relay.status).toBe('delivered');
    expect(relay.delivery.telegramMessageId).toBe(toOp[0].messageId);

    // Ana got the model's reply in her chat.
    expect(h.sentTo(ANA_ID).map((c) => c.payload.text)).toContain('Listo, le pregunté a Op.');
    expect(h.sessions.getFullHistory(PRIVATE_0)).toHaveLength(0);
  });

  test('2. Op replies to the relay message: Ana gets the answer verbatim, Op gets the ack, no LLM turn', async () => {
    const relay = await anaAsksOp();
    const callsBefore = h.llm.conversationCalls.length;
    const anaBefore = h.sentTo(ANA_ID).length;

    await h.send(OP, 'Es mi pareja', relay.delivery.telegramMessageId);

    expect(h.llm.conversationCalls.length).toBe(callsBefore);

    const toAna = h.sentTo(ANA_ID).slice(anaBefore);
    expect(toAna).toHaveLength(1);
    const answer = String(toAna[0].payload.text);
    expect(answer).toContain(`↩️ Respuesta de Op (vía ${BOT_NAME})`);
    expect(answer).toContain('Es mi pareja');

    expect(h.sentTo(OP_ID).map((c) => c.payload.text)).toContain('✅ Se lo pasé a Ana.');

    const updated = h.relays().find((r) => r.id === relay.id);
    expect(updated?.status).toBe('answered');
    expect(updated?.answerRelayId).toBeDefined();

    // Ana's own session now carries the answer, so her next turn knows it.
    const anaHistory = h.history(ANA_ID).map((m) => m.content);
    expect(anaHistory.some((c) => c.includes('Es mi pareja'))).toBe(true);
    expect(h.sessions.getFullHistory(PRIVATE_0)).toHaveLength(0);
  });

  // Live bug: Op typed his answer as a plain message (no reply-to) and the bot
  // answered him "Hola Ana, Finny acá…": nothing told the model who was speaking.
  test('2b. Op answers in free text: his turn’s prompt says the speaker is Op, the operator', async () => {
    await anaAsksOp();
    h.llm.turns.push({ tools: [], reply: 'Anotado.' });
    await h.send(OP, 'Es mi pareja');

    const call = must(h.llm.conversationCalls.at(-1));
    expect(call.lastUser).toContain('Es mi pareja');
    expect(call.system).toContain('## Who you are talking with');
    expect(call.system).toContain(
      'Op — your operator (telegram, identity verified by the channel). Every user message in this chat is from Op.'
    );
    expect(call.system).toContain(
      'you are talking to Op, not to whoever a relayed message came from'
    );
    expect(call.system).not.toContain('Ana — not your operator');
    // The relay is still listed as waiting on Op's answer, closable with replyTo.
    expect(call.system).toContain("## Messages waiting for this person's answer");
  });

  test('3. Ana’s next turn: the prompt lists her relay as answered with the answer', async () => {
    const relay = await anaAsksOp();
    await h.send(OP, 'Es mi pareja', relay.delivery.telegramMessageId);

    h.llm.turns.push({ tools: [], reply: 'Op dijo que sos su pareja.' });
    await h.send(ANA, '¿y? ¿qué dijo?');

    const call = must(h.llm.conversationCalls.at(-1));
    expect(call.lastUser).toContain('¿y? ¿qué dijo?');
    expect(call.system).toContain('## Messages this person asked you to pass on');
    expect(call.system).toContain(`${relay.id} → Op`);
    expect(call.system).toContain('answered: "Es mi pareja"');
  });
});

describe('relay full stack: Op → Ana and Ana answers in free text (scenario 4)', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await makeHarness();
  });
  afterEach(async () => {
    await h.cleanup();
  });

  test('4. Op asks through the bot, Ana answers without reply-to, Op gets it back', async () => {
    // Ana writes once so the bot knows her.
    h.llm.turns.push({ tools: [], reply: '¡Hola Ana!' });
    await h.send(ANA, 'hola');

    const question = 'Te paso a buscar a las 8, ¿confirmás?';
    h.llm.turns.push({
      tools: [
        {
          name: 'send_message',
          args: { recipient: 'Ana', message: question, expectsReply: true },
        },
      ],
      reply: 'Le avisé a Ana.',
    });
    await h.send(OP, 'decile a Ana que la paso a buscar a las 8, que confirme');

    const opCall = must(h.llm.conversationCalls.at(-1));
    expect(opCall.toolResults[0].result.content.startsWith('Delivered')).toBe(true);
    const toAna = must(h.sentTo(ANA_ID).at(-1));
    expect(String(toAna.payload.text)).toContain(`📨 De Op (vía ${BOT_NAME}):`);
    expect(String(toAna.payload.text)).toContain(question);

    const original = must(h.relays().find((r) => r.text === question));
    expect(original.from?.isOperator).toBe(true);
    expect(original.to.address).toBe(String(ANA_ID));

    // Ana answers in free text: the prompt shows what is waiting for her,
    // and the model answers it with replyTo.
    const opBefore = h.sentTo(OP_ID).length;
    h.llm.turns.push({
      tools: (messages) => {
        const system = messages.find((m) => m.role === 'system')?.content ?? '';
        const id = system.match(/^- (r-[0-9a-f]{8}) · from Op/m)?.[1];
        if (!id) throw new Error('relay id not in the prompt');
        return [{ name: 'send_message', args: { replyTo: id, message: 'dale' } }];
      },
      reply: 'Listo, le pasé tu respuesta a Op.',
    });
    await h.send(ANA, 'dale');

    const anaCall = must(h.llm.conversationCalls.at(-1));
    expect(anaCall.system).toContain("## Messages waiting for this person's answer");
    expect(anaCall.system).toContain(`- ${original.id} · from Op`);
    expect(anaCall.toolResults[0].result.success).toBe(true);
    expect(anaCall.toolResults[0].result.content.startsWith('Delivered')).toBe(true);

    const toOp = h.sentTo(OP_ID).slice(opBefore);
    const answer = toOp.find((c) => String(c.payload.text).includes('↩️ Respuesta de Ana'));
    expect(answer).toBeDefined();
    expect(String(answer?.payload.text)).toContain('dale');

    const updated = h.relays().find((r) => r.id === original.id);
    expect(updated?.status).toBe('answered');
    expect(h.sessions.getFullHistory(PRIVATE_0)).toHaveLength(0);
  });
});

describe('relay full stack: operator listed twice before startup (scenario 5)', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await makeHarness({
      seedDirectory: (dir) => {
        dir.track(BOT_ID, {
          messageId: 'm1',
          channelKind: 'telegram',
          text: 'hola',
          chatId: String(OP_ID),
          chatType: 'private',
          sender: { id: String(OP_ID), firstName: 'Op' },
          timestamp: Date.now() - 86_400_000,
        });
        dir.register(BOT_ID, {
          displayName: 'Op (operador)',
          channel: { kind: 'web', address: OP_EMAIL, verified: false },
        });
      },
    });
  });
  afterEach(async () => {
    await h.cleanup();
  });

  test('5. "Op" resolves to one contact and delivery goes to Telegram, never to private:0', async () => {
    // startBot alone (no message yet) folded both entries into one operator.
    const directory = new UserDirectory(join(h.dir, 'data'), silentLogger);
    const operator = directory.getOperator(BOT_ID);
    expect(operator?.displayName).toBe('Op');
    const operatorId = must(operator).id;
    expect(operator?.channels.map((c) => `${c.kind}:${c.address}`).sort()).toEqual([
      `telegram:${OP_ID}`,
      `web:${OP_EMAIL}`,
    ]);
    expect(directory.find(BOT_ID, 'Op (operador)').map((c) => c.id)).toEqual([operatorId]);
    expect(directory.find(BOT_ID, 'Op').map((c) => c.id)).toEqual([operatorId]);

    h.llm.turns.push({
      tools: [{ name: 'send_message', args: { recipient: 'Op', message: '¿Venís a cenar?' } }],
      reply: 'Le pregunté.',
    });
    await h.send(ANA, 'preguntale a Op si viene a cenar');

    const result = h.llm.conversationCalls[0].toolResults[0].result;
    expect(result.content.startsWith('Delivered')).toBe(true);
    expect(result.content).not.toContain('Multiple contacts');

    const toOp = h.sentTo(OP_ID);
    expect(toOp).toHaveLength(1);
    expect(String(toOp[0].payload.text)).toContain('¿Venís a cenar?');

    const relay = must(h.relays().find((r) => r.text === '¿Venís a cenar?'));
    expect(relay.to.channelKind).toBe('telegram');
    expect(relay.to.address).toBe(String(OP_ID));
    expect(relay.delivery.channel).toBe('telegram');
    expect(h.sessions.getFullHistory(PRIVATE_0)).toHaveLength(0);
  });
});

describe('relay full stack: honest failure (scenario 6)', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await makeHarness();
  });
  afterEach(async () => {
    await h.cleanup();
  });

  test('6. Op unreachable on every instance: FAILED to the model, failed record, nothing in private:0', async () => {
    h.failChats.add(OP_ID);
    h.llm.turns.push({
      tools: [
        {
          name: 'send_message',
          args: { recipient: 'operator', message: '¿Quién es Ana para vos?', expectsReply: true },
        },
      ],
      reply: 'No pude hacerle llegar el mensaje a Op.',
    });
    await h.send(ANA, 'preguntale a Op quién soy');

    const result = h.llm.conversationCalls[0].toolResults[0].result;
    expect(result.success).toBe(false);
    expect(result.content.startsWith('Delivery FAILED')).toBe(true);

    // Both fleet instances were tried; none got through.
    const tried = h.calls.filter((c) => c.method === 'sendMessage:403');
    expect(new Set(tried.map((c) => c.via))).toEqual(new Set([BOT_ID, OTHER_BOT_ID]));
    expect(h.sentTo(OP_ID)).toHaveLength(0);

    const relay = must(h.relays().find((r) => r.text === '¿Quién es Ana para vos?'));
    expect(relay.status).toBe('failed');
    expect(h.sessions.getFullHistory(PRIVATE_0)).toHaveLength(0);
  });
});

describe('one speaker per chat: the operator chat is answered once', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await makeHarness();
  });
  afterEach(async () => {
    await h.cleanup();
  });

  test('an operator turn gets one reply, wakes no cycle, and is kept as context', async () => {
    const internals = h.manager as any;
    internals.config.agentLoop.enabled = true;
    const woken: unknown[] = [];
    const counted: string[] = [];
    internals.agentLoop.requestImmediateRun = (...args: unknown[]) => woken.push(args);
    internals.agentLoop.recordHumanMessage = (botId: string) => counted.push(botId);

    h.llm.turns.push({ tools: [], reply: 'Dale, sin resúmenes salvo que me los pidas.' });
    await h.send(OP, 'no necesito resúmenes salvo que yo te los pida');

    expect(h.sentTo(OP_ID)).toHaveLength(1);
    expect(woken).toHaveLength(0);
    expect(counted).toEqual([BOT_ID]);

    const nav = internals.curiosityService?.storeFor(BOT_ID)?.loadNavigator();
    if (nav) {
      const said = nav.directives.find((d: { text: string }) => d.text.includes('resúmenes'));
      expect(said?.status).toBe('context');
    }
  });
});
