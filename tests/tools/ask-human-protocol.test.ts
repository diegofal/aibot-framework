/**
 * ask_human protocol.
 *
 * Ten days of inbox data: 27 questions queued, 20 closed unanswered. The ones
 * that got answered were short (<= 600 chars) and asked exactly one thing; the
 * long ones with file inventories never got a reply. The tool now enforces the
 * shape that works, offers quick-reply options, nudges multi-question asks, and
 * auto-closes stale asks so one forgotten question cannot block a bot forever.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { Hono } from 'hono';
import { AskHumanStore } from '../../src/bot/ask-human-store';
import type { Config, OperatorConfig } from '../../src/config';
import { ConversationsService } from '../../src/conversations/service';
import type { Logger } from '../../src/logger';
import {
  ASK_HUMAN_DEFAULTS,
  type AskHumanDeps,
  OPERATOR_ASK_PREVIEW_CHARS,
  buildOperatorAskNotification,
  createAskHumanTool,
  sweepStaleAskHumanQuestions,
} from '../../src/tools/ask-human';
import { conversationsRoutes } from '../../src/web/routes/conversations';
import { createTempDir, removeTempDir } from '../helpers/temp-dir';

const HOUR = 3_600_000;

function makeLogger(): Logger {
  const logger = {
    info: () => {},
    debug: () => {},
    warn: () => {},
    error: () => {},
    child: () => logger,
  } as unknown as Logger;
  return logger;
}

let dir: string;
let store: AskHumanStore;
let conversations: ConversationsService;
let memoryNotes: Array<[string, string]>;

function makeDeps(overrides: Partial<AskHumanDeps> = {}): AskHumanDeps {
  return {
    store,
    getBotInstance: () => undefined,
    getBotName: (id) => id,
    conversationsService: conversations,
    appendDailyMemory: (botId, note) => {
      memoryNotes.push([botId, note]);
    },
    ...overrides,
  };
}

beforeEach(() => {
  dir = createTempDir('ask-human-protocol');
  store = new AskHumanStore(makeLogger());
  conversations = new ConversationsService(dir);
  memoryNotes = [];
});

afterEach(() => {
  store.dispose();
  removeTempDir(dir);
});

describe('defaults', () => {
  test('600 chars and 72 hours', () => {
    expect(ASK_HUMAN_DEFAULTS).toEqual({ maxChars: 600, autoCloseHours: 72 });
  });
});

describe('question length', () => {
  test('rejects a question over maxChars and tells the bot what to do instead', async () => {
    const tool = createAskHumanTool(makeDeps());
    const result = await tool.execute(
      { question: 'x'.repeat(601), _botId: 'bot1', _chatId: 0 },
      makeLogger()
    );
    expect(result.success).toBe(false);
    expect(result.content).toMatch(/601/);
    expect(result.content).toMatch(/600/);
    expect(result.content).toMatch(/shorten/i);
    expect(result.content).toMatch(/exactly one/i);
    expect(store.getPendingCount()).toBe(0);
    expect(conversations.listConversations('bot1')).toHaveLength(0);
  });

  test('exactly maxChars is accepted', async () => {
    const tool = createAskHumanTool(makeDeps());
    const result = await tool.execute(
      { question: 'x'.repeat(600), _botId: 'bot1', _chatId: 0 },
      makeLogger()
    );
    expect(result.success).toBe(true);
    expect(store.getPendingCount()).toBe(1);
  });

  test('maxChars is configurable per deployment', async () => {
    const tool = createAskHumanTool(makeDeps({ maxChars: 100 }));
    const result = await tool.execute(
      { question: 'y'.repeat(101), _botId: 'bot1', _chatId: 0 },
      makeLogger()
    );
    expect(result.success).toBe(false);
    expect(result.content).toMatch(/100/);
  });

  test('the tool description states the limit so the bot can plan for it', () => {
    const tool = createAskHumanTool(makeDeps());
    expect(tool.definition.function.description).toContain('600');
    expect(tool.definition.function.parameters.properties.options).toBeDefined();
  });
});

describe('options', () => {
  test('valid options are stored on the inbox conversation as askOptions and on the pending question', async () => {
    const tool = createAskHumanTool(makeDeps());
    const result = await tool.execute(
      {
        question: 'Which API should I prioritise?',
        options: ['Stripe', 'MercadoPago', 'Both'],
        _botId: 'bot1',
        _chatId: 0,
      },
      makeLogger()
    );
    expect(result.success).toBe(true);

    const [conv] = conversations.listConversations('bot1', { type: 'inbox' });
    expect(conv.askOptions).toEqual(['Stripe', 'MercadoPago', 'Both']);
    expect(conv.inboxStatus).toBe('pending');

    const [pending] = store.getAll();
    expect(pending.options).toEqual(['Stripe', 'MercadoPago', 'Both']);
  });

  test('askOptions is returned by GET /api/conversations/:botId and /:botId/:id', async () => {
    const tool = createAskHumanTool(makeDeps());
    await tool.execute(
      { question: 'Ship today?', options: ['Yes', 'No'], _botId: 'bot1', _chatId: 0 },
      makeLogger()
    );

    const app = new Hono();
    app.route(
      '/api/conversations',
      conversationsRoutes({
        conversationsService: conversations,
        botManager: {} as any,
        logger: makeLogger(),
        config: { bots: [{ id: 'bot1', name: 'Bot 1' }] } as unknown as Config,
      })
    );

    const listRes = await app.request('/api/conversations/bot1?type=inbox');
    expect(listRes.status).toBe(200);
    const list = (await listRes.json()) as Array<{ id: string; askOptions?: string[] }>;
    expect(list).toHaveLength(1);
    expect(list[0].askOptions).toEqual(['Yes', 'No']);

    const oneRes = await app.request(`/api/conversations/bot1/${list[0].id}`);
    expect(oneRes.status).toBe(200);
    const one = (await oneRes.json()) as { conversation: { askOptions?: string[] } };
    expect(one.conversation.askOptions).toEqual(['Yes', 'No']);
  });

  test('a question without options has no askOptions key at all', async () => {
    const tool = createAskHumanTool(makeDeps());
    await tool.execute({ question: 'Thoughts?', _botId: 'bot1', _chatId: 0 }, makeLogger());
    const [conv] = conversations.listConversations('bot1');
    expect('askOptions' in conv).toBe(false);
  });

  test.each([
    [['only-one'], 'one option'],
    [['a', 'b', 'c', 'd', 'e'], 'five options'],
    [['ok', ''], 'an empty option'],
    [['fine', 'z'.repeat(81)], 'an option over 80 chars'],
    [[1, 2] as unknown as string[], 'non-string options'],
  ])('rejects %p (%s) without queuing anything', async (options) => {
    const tool = createAskHumanTool(makeDeps());
    const result = await tool.execute(
      { question: 'Pick one', options, _botId: 'bot1', _chatId: 0 },
      makeLogger()
    );
    expect(result.success).toBe(false);
    expect(result.content).toMatch(/options/);
    expect(result.content).toMatch(/2.*4/);
    expect(store.getPendingCount()).toBe(0);
  });
});

describe('single-question tip', () => {
  test('more than one "?" is accepted but the result leads with a tip naming the count', async () => {
    const tool = createAskHumanTool(makeDeps());
    const result = await tool.execute(
      {
        question: 'Should I use Stripe? Or MercadoPago? What about fees?',
        _botId: 'bot1',
        _chatId: 0,
      },
      makeLogger()
    );
    expect(result.success).toBe(true);
    expect(result.content.startsWith('Tip: single-question asks get answered; yours has 3')).toBe(
      true
    );
    expect(store.getPendingCount()).toBe(1);
  });

  test('one question mark gets no tip', async () => {
    const tool = createAskHumanTool(makeDeps());
    const result = await tool.execute(
      { question: 'Should I use Stripe?', _botId: 'bot1', _chatId: 0 },
      makeLogger()
    );
    expect(result.success).toBe(true);
    expect(result.content).not.toMatch(/^Tip:/);
  });
});

describe('auto-close', () => {
  test('a pending ask older than autoCloseHours is closed when the tool is next invoked', async () => {
    const t0 = Date.parse('2026-08-10T09:00:00Z');
    let now = t0;
    const deps = makeDeps({ now: () => now });
    const tool = createAskHumanTool(deps);

    const first = await tool.execute(
      { question: 'Approve the Q3 plan?', _botId: 'bot1', _chatId: 0 },
      makeLogger()
    );
    expect(first.success).toBe(true);
    const [staleConv] = conversations.listConversations('bot1');

    // 73 hours later the bot asks something else.
    now = t0 + 73 * HOUR;
    const second = await tool.execute(
      { question: 'Publish the digest?', _botId: 'bot1', _chatId: 0 },
      makeLogger()
    );

    // The stale ask is gone and the new one is queued — no "already pending" block.
    expect(second.success).toBe(true);
    expect(second.content).toMatch(/queued/i);
    const pending = store.getAll();
    expect(pending).toHaveLength(1);
    expect(pending[0].question).toBe('Publish the digest?');

    const closed = conversations.getConversation('bot1', staleConv.id);
    expect(closed?.inboxStatus).toBe('closed');

    expect(memoryNotes).toEqual([
      ['bot1', '[ask_human] Question auto-closed after 72h without answer: Approve the Q3 plan?'],
    ]);
  });

  test('a pending ask younger than the threshold still blocks a second ask', async () => {
    const t0 = Date.parse('2026-08-10T09:00:00Z');
    let now = t0;
    const tool = createAskHumanTool(makeDeps({ now: () => now }));

    await tool.execute({ question: 'First?', _botId: 'bot1', _chatId: 0 }, makeLogger());
    now = t0 + 71 * HOUR;
    const second = await tool.execute(
      { question: 'Second?', _botId: 'bot1', _chatId: 0 },
      makeLogger()
    );

    expect(second.success).toBe(true);
    expect(second.content).toMatch(/already have a pending question/);
    expect(store.getPendingCount()).toBe(1);
    expect(memoryNotes).toEqual([]);
  });

  test('autoCloseHours is configurable and shows up in the memory note', async () => {
    const t0 = Date.parse('2026-08-10T09:00:00Z');
    let now = t0;
    const tool = createAskHumanTool(makeDeps({ now: () => now, autoCloseHours: 1 }));

    await tool.execute({ question: 'Quick one?', _botId: 'bot1', _chatId: 0 }, makeLogger());
    now = t0 + 2 * HOUR;
    await tool.execute({ question: 'Next?', _botId: 'bot1', _chatId: 0 }, makeLogger());

    expect(memoryNotes).toEqual([
      ['bot1', '[ask_human] Question auto-closed after 1h without answer: Quick one?'],
    ]);
  });

  test('sweep only closes the invoking bot when scoped, every bot otherwise', async () => {
    const t0 = Date.parse('2026-08-10T09:00:00Z');
    const a = store.ask('bot-a', 0, 'A?');
    const b = store.ask('bot-b', 0, 'B?');
    a.promise.catch(() => {});
    b.promise.catch(() => {});
    const convA = conversations.createConversation('bot-a', 'inbox', 'A?', {
      askHumanQuestionId: a.id,
      inboxStatus: 'pending',
    });
    const convB = conversations.createConversation('bot-b', 'inbox', 'B?', {
      askHumanQuestionId: b.id,
      inboxStatus: 'pending',
    });
    store.setConversationId(a.id, convA.id);
    store.setConversationId(b.id, convB.id);
    // Backdate both so they are stale.
    store.setCreatedAt(a.id, t0);
    store.setCreatedAt(b.id, t0);

    const deps = makeDeps({ now: () => t0 + 100 * HOUR });
    const closedA = sweepStaleAskHumanQuestions(deps, makeLogger(), 'bot-a');
    expect(closedA.map((q) => q.botId)).toEqual(['bot-a']);
    expect(store.hasPendingForBot('bot-b')).toBe(true);

    const closedRest = sweepStaleAskHumanQuestions(deps, makeLogger());
    expect(closedRest.map((q) => q.botId)).toEqual(['bot-b']);
    expect(conversations.getConversation('bot-b', convB.id)?.inboxStatus).toBe('closed');
    expect(memoryNotes.map(([id]) => id)).toEqual(['bot-a', 'bot-b']);
  });

  test('the stale promise rejects with an auto-close reason, not a dismissal', async () => {
    const t0 = Date.parse('2026-08-10T09:00:00Z');
    const { id, promise } = store.ask('bot1', 0, 'Old?');
    store.setCreatedAt(id, t0);
    const seen = mock((err: Error) => err.message);
    const settled = promise.catch(seen);

    sweepStaleAskHumanQuestions(makeDeps({ now: () => t0 + 80 * HOUR }), makeLogger());
    await settled;

    expect(seen).toHaveBeenCalledTimes(1);
    expect(seen.mock.results[0].value).toMatch(/auto-closed after 72h/);
  });
});

/**
 * config.operator.notifyOnAsk. 20 of 27 asks were closed unanswered because
 * nobody was watching the dashboard inbox: with the flag on, the asking bot
 * also pings the operator's Telegram chat.
 */
describe('operator notification (config.operator.notifyOnAsk)', () => {
  type Sent = { chatId: number; text: string };

  function makeSendingBot(sent: Sent[], fail = false): any {
    return {
      api: {
        sendMessage: async (chatId: number, text: string) => {
          if (fail) throw new Error('telegram is down');
          sent.push({ chatId, text });
          return { message_id: sent.length };
        },
      },
    };
  }

  function operatorDeps(
    sent: Sent[],
    operator: OperatorConfig | undefined,
    opts: { fail?: boolean } = {}
  ): AskHumanDeps {
    return makeDeps({
      getBotInstance: () => makeSendingBot(sent, opts.fail),
      getBotName: () => 'Bot One',
      getOperator: () => operator,
    });
  }

  test('buildOperatorAskNotification names the bot, keeps short questions intact and lists options', () => {
    const text = buildOperatorAskNotification('Bot One', 'Ship the digest today?', ['Yes', 'No']);
    expect(text).toContain('Bot One');
    expect(text).toContain('Ship the digest today?');
    expect(text).toContain('Yes | No');
  });

  test('buildOperatorAskNotification truncates a long question and omits the options line', () => {
    const text = buildOperatorAskNotification('Bot One', 'q'.repeat(600));
    expect(text).toContain('...');
    expect(text).not.toContain('Options:');
    expect(text.length).toBeLessThan(600);
    expect(text).toContain('q'.repeat(OPERATOR_ASK_PREVIEW_CHARS - 3));
  });

  test('notifies the operator when notifyOnAsk is true and telegramChatId is configured', async () => {
    const sent: Sent[] = [];
    const tool = createAskHumanTool(operatorDeps(sent, { telegramChatId: 999, notifyOnAsk: true }));

    const result = await tool.execute(
      { question: 'Approve the plan?', _botId: 'bot1', _chatId: 0 },
      makeLogger()
    );

    expect(result.success).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0].chatId).toBe(999);
    expect(sent[0].text).toContain('Bot One');
    expect(sent[0].text).toContain('Approve the plan?');
    expect(store.getPendingCount()).toBe(1);
  });

  test('includes the options when the ask carries them', async () => {
    const sent: Sent[] = [];
    const tool = createAskHumanTool(operatorDeps(sent, { telegramChatId: 999, notifyOnAsk: true }));

    await tool.execute(
      { question: 'Which one?', options: ['Stripe', 'MercadoPago'], _botId: 'bot1', _chatId: 0 },
      makeLogger()
    );

    expect(sent).toHaveLength(1);
    expect(sent[0].text).toContain('Stripe | MercadoPago');
  });

  test('stays silent when notifyOnAsk is off (default) or the operator is unset', async () => {
    const cases: Array<OperatorConfig | undefined> = [
      undefined,
      {} as OperatorConfig,
      { telegramChatId: 999 },
      { telegramChatId: 999, notifyOnAsk: false },
    ];
    for (const [i, operator] of cases.entries()) {
      const sent: Sent[] = [];
      // One bot per case: a bot may only have one pending question at a time.
      const tool = createAskHumanTool(operatorDeps(sent, operator));
      const result = await tool.execute(
        { question: 'Anything?', _botId: `bot-${i}`, _chatId: 0 },
        makeLogger()
      );
      expect(result.success).toBe(true);
      expect(sent).toEqual([]);
    }
  });

  test('notifyOnAsk without a telegramChatId queues the question and sends nothing', async () => {
    const sent: Sent[] = [];
    const tool = createAskHumanTool(operatorDeps(sent, { notifyOnAsk: true, name: 'Diego' }));

    const result = await tool.execute(
      { question: 'Anyone home?', _botId: 'bot1', _chatId: 0 },
      makeLogger()
    );

    expect(result.success).toBe(true);
    expect(sent).toEqual([]);
    expect(store.getPendingCount()).toBe(1);
  });

  test('does not send twice when the asking chat is already the operator chat', async () => {
    const sent: Sent[] = [];
    const tool = createAskHumanTool(
      operatorDeps(sent, { telegramChatId: 4242, notifyOnAsk: true })
    );

    await tool.execute({ question: 'Same chat?', _botId: 'bot1', _chatId: 4242 }, makeLogger());

    expect(sent).toHaveLength(1);
    expect(sent[0].chatId).toBe(4242);
    // The bot's own notification is the one that carries the reply hint.
    expect(sent[0].text).toContain('Reply to this message');
  });

  test('a throwing notifier never fails the ask — the question stays queued', async () => {
    const sent: Sent[] = [];
    const tool = createAskHumanTool(
      operatorDeps(sent, { telegramChatId: 999, notifyOnAsk: true }, { fail: true })
    );

    const result = await tool.execute(
      { question: 'Still queued?', _botId: 'bot1', _chatId: 0 },
      makeLogger()
    );

    expect(result.success).toBe(true);
    expect(result.content).toMatch(/queued/i);
    expect(store.getPendingCount()).toBe(1);
    expect(conversations.listConversations('bot1', { type: 'inbox' })).toHaveLength(1);
  });

  test('no bot instance means no operator notification and no failure', async () => {
    const tool = createAskHumanTool(
      makeDeps({
        getBotInstance: () => undefined,
        getOperator: () => ({ telegramChatId: 999, notifyOnAsk: true }),
      })
    );
    const result = await tool.execute(
      { question: 'Headless?', _botId: 'bot1', _chatId: 0 },
      makeLogger()
    );
    expect(result.success).toBe(true);
    expect(store.getPendingCount()).toBe(1);
  });
});
