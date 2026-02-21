import { describe, expect, test, beforeEach, mock } from 'bun:test';
import { AskHumanStore } from '../src/bot/ask-human-store';
import { createAskHumanTool } from '../src/tools/ask-human';

function makeLogger() {
  return {
    info: mock(() => {}),
    debug: mock(() => {}),
    warn: mock(() => {}),
    error: mock(() => {}),
    child: () => makeLogger(),
  } as any;
}

describe('AskHumanStore', () => {
  let store: AskHumanStore;

  beforeEach(() => {
    store = new AskHumanStore(makeLogger());
  });

  test('getAll() returns empty array when nothing pending', () => {
    expect(store.getAll()).toEqual([]);
  });

  test('getPendingCount() returns 0 initially', () => {
    expect(store.getPendingCount()).toBe(0);
  });

  test('getAll() returns pending questions with correct fields', () => {
    store.ask('bot1', 123, 'What should I do?', 60_000);
    store.ask('bot2', 456, 'Pick a strategy', 120_000);

    const all = store.getAll();
    expect(all).toHaveLength(2);

    const q1 = all.find((q) => q.botId === 'bot1')!;
    expect(q1).toBeDefined();
    expect(q1.chatId).toBe(123);
    expect(q1.question).toBe('What should I do?');
    expect(q1.timeoutMs).toBe(60_000);
    expect(q1.remainingMs).toBeGreaterThan(0);
    expect(q1.remainingMs).toBeLessThanOrEqual(60_000);
    expect(typeof q1.id).toBe('string');
    expect(typeof q1.createdAt).toBe('number');
  });

  test('getPendingCount() tracks additions', () => {
    store.ask('bot1', 100, 'q1', 60_000);
    expect(store.getPendingCount()).toBe(1);

    store.ask('bot2', 200, 'q2', 60_000);
    expect(store.getPendingCount()).toBe(2);
  });

  test('answerById() resolves the promise and cleans up', async () => {
    const { id, promise } = store.ask('bot1', 100, 'q1', 60_000);
    expect(store.getPendingCount()).toBe(1);

    const ok = store.answerById(id, 'my answer');
    expect(ok).toBe(true);
    expect(store.getPendingCount()).toBe(0);
    expect(store.getAll()).toEqual([]);

    const answer = await promise;
    expect(answer).toBe('my answer');
  });

  test('answerById() returns false for unknown ID', () => {
    expect(store.answerById('nonexistent', 'x')).toBe(false);
  });

  test('answerById() returns false for already-answered question', async () => {
    const { id, promise } = store.ask('bot1', 100, 'q1', 60_000);
    store.answerById(id, 'first');
    await promise;

    expect(store.answerById(id, 'second')).toBe(false);
  });

  test('dismissById() rejects the promise and cleans up', async () => {
    const { id, promise } = store.ask('bot1', 100, 'q1', 60_000);
    promise.catch(() => {}); // prevent unhandled rejection
    expect(store.getPendingCount()).toBe(1);

    const ok = store.dismissById(id);
    expect(ok).toBe(true);
    expect(store.getPendingCount()).toBe(0);
    expect(store.getAll()).toEqual([]);

    await expect(promise).rejects.toThrow('Question dismissed');
  });

  test('dismissById() returns false for unknown ID', () => {
    expect(store.dismissById('nonexistent')).toBe(false);
  });

  test('hasPendingForBot() returns true when bot has pending question', () => {
    store.ask('bot1', 100, 'q1', 60_000);
    expect(store.hasPendingForBot('bot1')).toBe(true);
    expect(store.hasPendingForBot('bot2')).toBe(false);
  });

  test('hasPendingForBot() returns false after question is answered', async () => {
    const { id, promise } = store.ask('bot1', 100, 'q1', 60_000);
    store.answerById(id, 'done');
    await promise;
    expect(store.hasPendingForBot('bot1')).toBe(false);
  });

  test('dispose clears all pending questions', async () => {
    const { promise: p1 } = store.ask('bot1', 100, 'q1', 60_000);
    const { promise: p2 } = store.ask('bot2', 200, 'q2', 60_000);
    // Prevent unhandled rejection noise
    p1.catch(() => {});
    p2.catch(() => {});
    expect(store.getPendingCount()).toBe(2);

    store.dispose();
    expect(store.getPendingCount()).toBe(0);
    expect(store.getAll()).toEqual([]);

    // Verify promises were rejected
    await expect(p1).rejects.toThrow('AskHumanStore disposed');
    await expect(p2).rejects.toThrow('AskHumanStore disposed');
  });

  test('answerById stores answer in answered map', () => {
    const { id } = store.ask('bot1', 100, 'What strategy?', 60_000);
    store.answerById(id, 'Go with DeFi');

    const answers = store.consumeAnswersForBot('bot1');
    expect(answers).toHaveLength(1);
    expect(answers[0].id).toBe(id);
    expect(answers[0].botId).toBe('bot1');
    expect(answers[0].question).toBe('What strategy?');
    expect(answers[0].answer).toBe('Go with DeFi');
    expect(typeof answers[0].answeredAt).toBe('number');
  });

  test('consumeAnswersForBot returns and deletes answers', () => {
    const { id: id1 } = store.ask('bot1', 100, 'q1', 60_000);
    const { id: id2 } = store.ask('bot1', 100, 'q2', 60_000);
    store.answerById(id1, 'a1');
    store.answerById(id2, 'a2');

    const first = store.consumeAnswersForBot('bot1');
    expect(first).toHaveLength(2);

    // Second call returns empty — answers were consumed
    const second = store.consumeAnswersForBot('bot1');
    expect(second).toEqual([]);
  });

  test('consumeAnswersForBot returns empty array for unknown bot', () => {
    const { id } = store.ask('bot1', 100, 'q1', 60_000);
    store.answerById(id, 'a1');

    expect(store.consumeAnswersForBot('bot-unknown')).toEqual([]);
  });

  test('handleReply also stores in answered map', () => {
    const { id } = store.ask('bot1', 100, 'What next?', 60_000);
    store.setMessageId(id, 999);

    const matched = store.handleReply(100, 'Do X', 999);
    expect(matched).toBe(true);

    const answers = store.consumeAnswersForBot('bot1');
    expect(answers).toHaveLength(1);
    expect(answers[0].question).toBe('What next?');
    expect(answers[0].answer).toBe('Do X');
  });

  test('getPendingForBot returns only that bot\'s questions', () => {
    store.ask('bot1', 100, 'q1', 60_000);
    store.ask('bot2', 200, 'q2', 60_000);
    store.ask('bot1', 300, 'q3', 60_000);

    const bot1Pending = store.getPendingForBot('bot1');
    expect(bot1Pending).toHaveLength(2);
    expect(bot1Pending.every((q) => q.botId === 'bot1')).toBe(true);

    const bot2Pending = store.getPendingForBot('bot2');
    expect(bot2Pending).toHaveLength(1);
    expect(bot2Pending[0].botId).toBe('bot2');

    expect(store.getPendingForBot('bot-unknown')).toEqual([]);
  });

  test('dispose clears answered map too', () => {
    const { id } = store.ask('bot1', 100, 'q1', 60_000);
    store.answerById(id, 'a1');

    store.dispose();
    expect(store.consumeAnswersForBot('bot1')).toEqual([]);
  });
});

describe('ask_human tool', () => {
  let store: AskHumanStore;

  beforeEach(() => {
    store = new AskHumanStore(makeLogger());
  });

  test('returns immediately (non-blocking) with queued message', async () => {
    const tool = createAskHumanTool({
      store,
      getBotInstance: () => undefined,
      getBotName: () => 'TestBot',
    });

    // Call returns immediately — no need to answer first
    const result = await tool.execute(
      { question: 'Which strategy?', _botId: 'bot1', _chatId: 0 },
      makeLogger(),
    );

    expect(result.success).toBe(true);
    expect(result.content).toContain('queued to the human inbox');
    expect(result.content).toContain('next cycle');
    expect(store.getPendingCount()).toBe(1);

    const pending = store.getAll();
    expect(pending[0].question).toBe('Which strategy?');
    expect(pending[0].botId).toBe('bot1');

    // Dismiss is safe now — the tool attaches .catch() internally
    store.dismissById(pending[0].id);
  });

  test('returns early when bot already has a pending question', async () => {
    const tool = createAskHumanTool({
      store,
      getBotInstance: () => undefined,
      getBotName: () => 'TestBot',
    });

    // First call: queues normally (returns immediately)
    const firstResult = await tool.execute(
      { question: 'First question?', _botId: 'bot1', _chatId: 0 },
      makeLogger(),
    );
    expect(firstResult.success).toBe(true);
    expect(store.getPendingCount()).toBe(1);

    // Second call: should return dedup message without queuing
    const secondResult = await tool.execute(
      { question: 'Second question?', _botId: 'bot1', _chatId: 0 },
      makeLogger(),
    );
    expect(secondResult.success).toBe(true);
    expect(secondResult.content).toContain('already have a pending question');
    expect(store.getPendingCount()).toBe(1); // still only 1

    // Dismiss is safe now — the tool attaches .catch() internally
    const pending = store.getAll();
    store.dismissById(pending[0].id);
  });

  test('dismiss after tool.execute does not cause unhandled rejection', async () => {
    const logger = makeLogger();
    const tool = createAskHumanTool({
      store,
      getBotInstance: () => undefined,
      getBotName: () => 'TestBot',
    });

    await tool.execute(
      { question: 'Will be dismissed', _botId: 'bot1', _chatId: 0 },
      logger,
    );

    const pending = store.getAll();
    store.dismissById(pending[0].id);

    // Let microtasks flush so the .catch() handler runs
    await new Promise((r) => setTimeout(r, 10));

    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ questionId: pending[0].id, botId: 'bot1', reason: 'Question dismissed' }),
      'ask_human: question closed without answer',
    );
  });

  test('fails when _botId is missing', async () => {
    const tool = createAskHumanTool({
      store,
      getBotInstance: () => undefined,
      getBotName: () => 'TestBot',
    });

    const result = await tool.execute(
      { question: 'test?' },
      makeLogger(),
    );
    expect(result.success).toBe(false);
    expect(result.content).toContain('_botId');
  });
});
