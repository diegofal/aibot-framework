import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { AskHumanStore } from '../src/bot/ask-human-store';
import { trackUser } from '../src/bot/media-handlers';
import type { BotContext, SeenUser } from '../src/bot/types';

function makeLogger() {
  return {
    info: mock(() => {}),
    debug: mock(() => {}),
    warn: mock(() => {}),
    error: mock(() => {}),
    child: () => makeLogger(),
  } as any;
}

describe('Cross-bot isolation: seenUsers', () => {
  let seenUsers: Map<string, Map<number, Map<number, SeenUser>>>;
  let ctx: Partial<BotContext>;

  beforeEach(() => {
    seenUsers = new Map();
    ctx = { seenUsers } as any;
  });

  function makeTelegramCtx(chatId: number, userId: number, firstName: string) {
    return {
      chat: { id: chatId },
      from: { id: userId, first_name: firstName, is_bot: false },
    } as any;
  }

  test('trackUser stores users under botId scope', () => {
    trackUser(ctx as BotContext, makeTelegramCtx(100, 1, 'Alice'), 'bot-a');
    trackUser(ctx as BotContext, makeTelegramCtx(100, 2, 'Bob'), 'bot-b');

    // bot-a sees Alice, bot-b sees Bob
    expect(seenUsers.get('bot-a')?.get(100)?.has(1)).toBe(true);
    expect(seenUsers.get('bot-a')?.get(100)?.has(2)).toBeFalsy();
    expect(seenUsers.get('bot-b')?.get(100)?.has(2)).toBe(true);
    expect(seenUsers.get('bot-b')?.get(100)?.has(1)).toBeFalsy();
  });

  test('same user in same chat tracked independently per bot', () => {
    trackUser(ctx as BotContext, makeTelegramCtx(100, 1, 'Alice'), 'bot-a');
    trackUser(ctx as BotContext, makeTelegramCtx(100, 1, 'Alice'), 'bot-b');

    const fromA = seenUsers.get('bot-a')?.get(100)?.get(1);
    const fromB = seenUsers.get('bot-b')?.get(100)?.get(1);
    expect(fromA).toBeDefined();
    expect(fromB).toBeDefined();
    // They are independent objects
    expect(fromA).not.toBe(fromB);
  });

  test("bots cannot see each other's user maps", () => {
    trackUser(ctx as BotContext, makeTelegramCtx(100, 1, 'Alice'), 'bot-a');
    expect(seenUsers.get('bot-b')).toBeUndefined();
  });
});

describe('Cross-bot isolation: AskHumanStore', () => {
  let store: AskHumanStore;

  beforeEach(() => {
    store = new AskHumanStore(makeLogger());
  });

  test('hasPending is scoped by botId', () => {
    store.ask('bot-a', 100, 'Question from A?', 60_000);

    // Same chatId, different bot — should NOT see pending
    expect(store.hasPending('bot-a', 100)).toBe(true);
    expect(store.hasPending('bot-b', 100)).toBe(false);
  });

  test('handleReply only matches questions from same bot', () => {
    const { id } = store.ask('bot-a', 100, 'Q from A', 60_000);
    store.setMessageId(id, 999);

    // bot-b tries to match the reply — should fail
    const resultB = store.handleReply('bot-b', 100, 'answer', 999);
    expect(resultB.matched).toBe(false);

    // bot-a matches the reply — should succeed
    const resultA = store.handleReply('bot-a', 100, 'answer', 999);
    expect(resultA.matched).toBe(true);
    expect(resultA.botId).toBe('bot-a');
  });

  test('single-pending fallback is scoped by bot', () => {
    store.ask('bot-a', 100, 'Q from A', 60_000);

    // bot-b has no pending in chat 100, so single-pending fallback shouldn't trigger
    const resultB = store.handleReply('bot-b', 100, 'answer');
    expect(resultB.matched).toBe(false);

    // bot-a single-pending fallback should work
    const resultA = store.handleReply('bot-a', 100, 'answer');
    expect(resultA.matched).toBe(true);
  });

  test('two bots with pending questions in same chat are independent', () => {
    const { id: idA, promise: pA } = store.ask('bot-a', 100, 'Q from A', 60_000);
    const { id: idB, promise: pB } = store.ask('bot-b', 100, 'Q from B', 60_000);
    pA.catch(() => {});
    pB.catch(() => {});
    store.setMessageId(idA, 900);
    store.setMessageId(idB, 901);

    // Reply to bot-a's message
    const resultA = store.handleReply('bot-a', 100, 'answer for A', 900);
    expect(resultA.matched).toBe(true);
    expect(resultA.questionId).toBe(idA);

    // bot-b still has its pending question
    expect(store.hasPending('bot-b', 100)).toBe(true);
    expect(store.hasPending('bot-a', 100)).toBe(false);

    // Clean up
    store.dismissById(idB);
  });

  test("clearForBot only clears that bot's entries", () => {
    const { promise: pA } = store.ask('bot-a', 100, 'Q from A', 60_000);
    const { promise: pB } = store.ask('bot-b', 100, 'Q from B', 60_000);
    pA.catch(() => {});
    pB.catch(() => {});

    store.clearForBot('bot-a');

    expect(store.hasPending('bot-a', 100)).toBe(false);
    expect(store.hasPending('bot-b', 100)).toBe(true);

    // Clean up
    store.dispose();
  });
});
