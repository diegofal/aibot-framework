/**
 * ask_human across container restarts.
 *
 * Pending questions used to live only in memory. After a restart the inbox
 * conversations stayed `pending` forever: the 72 h sweep iterates the store,
 * which no longer knew them, and an operator answer in the dashboard fell
 * through to plain chat (or 404'd from the Needs-You card), so it never reached
 * the planner. Live data on 2026-10-03: 31 inbox conversations `pending`, six of
 * them ai-perfectionist's, the oldest from 09-14 — with an operator answer in it.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { type AnsweredQuestion, AskHumanStore } from '../../src/bot/ask-human-store';
import { ConversationsService } from '../../src/conversations/service';
import type { Logger } from '../../src/logger';
import {
  type AskHumanDeps,
  buildAskHumanAnswerNote,
  reconcileAskHumanInbox,
  sweepStaleAskHumanQuestions,
} from '../../src/tools/ask-human';
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
let storeDir: string;
const stores: AskHumanStore[] = [];

function newStore(callbacks?: ConstructorParameters<typeof AskHumanStore>[2]): AskHumanStore {
  const s = new AskHumanStore(makeLogger(), storeDir, callbacks);
  stores.push(s);
  return s;
}

beforeEach(() => {
  dir = createTempDir('ask-human-restart');
  storeDir = join(dir, 'ask-human');
});

afterEach(() => {
  for (const s of stores.splice(0)) s.dispose();
  removeTempDir(dir);
});

describe('AskHumanStore pending persistence', () => {
  test('a pending question survives a restart with all its fields', () => {
    const before = newStore();
    const { id, promise } = before.ask('bot1', 42, 'Ship it?', ['Yes', 'No'], 1_000);
    promise.catch(() => {});
    before.setConversationId(id, 'conv-1');
    before.setMessageId(id, 777);

    const after = newStore();
    const restored = after.getPendingForBot('bot1');
    expect(restored).toEqual([
      {
        id,
        botId: 'bot1',
        chatId: 42,
        question: 'Ship it?',
        conversationId: 'conv-1',
        options: ['Yes', 'No'],
        createdAt: 1_000,
      },
    ]);
    expect(after.hasPending('bot1', 42)).toBe(true);
  });

  test('a restored question can be answered and the answer reaches consumeAnswersForBot', () => {
    const before = newStore();
    const { id, promise } = before.ask('bot1', 0, 'Ship it?');
    promise.catch(() => {});

    const after = newStore();
    expect(after.answerById(id, 'Yes').ok).toBe(true);
    expect(after.consumeAnswersForBot('bot1').map((a) => a.answer)).toEqual(['Yes']);
  });

  test('a restored question still matches a Telegram reply by message id', () => {
    const before = newStore();
    const { id, promise } = before.ask('bot1', 42, 'Ship it?');
    promise.catch(() => {});
    before.setMessageId(id, 777);
    before.ask('bot1', 42, 'Second?').promise.catch(() => {});

    const after = newStore();
    const res = after.handleReply('bot1', 42, 'Yes', 777);
    expect(res).toMatchObject({ matched: true, questionId: id });
  });

  test('answered, dismissed and auto-closed questions are not restored', () => {
    const before = newStore();
    const a = before.ask('bot1', 0, 'A?');
    const b = before.ask('bot1', 0, 'B?');
    const c = before.ask('bot1', 0, 'C?', undefined, 0);
    for (const q of [a, b, c]) q.promise.catch(() => {});
    before.answerById(a.id, 'yes');
    before.dismissById(b.id);
    before.closeStale(HOUR, 10 * HOUR);

    expect(newStore().getPendingCount()).toBe(0);
  });

  test('clearForBot drops that bot from the persisted pending set', () => {
    const before = newStore();
    before.ask('bot1', 0, 'A?').promise.catch(() => {});
    before.ask('bot2', 0, 'B?').promise.catch(() => {});
    before.clearForBot('bot1');

    const after = newStore();
    expect(after.hasPendingForBot('bot1')).toBe(false);
    expect(after.hasPendingForBot('bot2')).toBe(true);
  });

  test('dispose (shutdown) keeps the pending set on disk', () => {
    const before = newStore();
    before.ask('bot1', 0, 'A?').promise.catch(() => {});
    before.dispose();

    expect(newStore().getPendingCount()).toBe(1);
  });

  test('restorePending inserts a question once and reports whether it did', () => {
    const s = newStore();
    const info = { id: 'q-1', botId: 'bot1', chatId: 0, question: 'Old?', createdAt: 5 };
    expect(s.restorePending(info)).toBe(true);
    expect(s.restorePending(info)).toBe(false);
    expect(s.getPendingForBot('bot1')).toEqual([info]);
    // The restored promise has no caller: closing it must not raise an unhandled rejection.
    expect(s.closeStale(1, 10).map((q) => q.id)).toEqual(['q-1']);
  });
});

describe('AskHumanStore onAnswer', () => {
  test('fires for a web answer and for a Telegram reply', () => {
    const seen: AnsweredQuestion[] = [];
    const s = newStore({ onAnswer: (a) => seen.push(a) });
    const web = s.ask('bot1', 0, 'Web?');
    s.answerById(web.id, 'via web');
    s.ask('bot1', 42, 'Telegram?');
    s.handleReply('bot1', 42, 'via telegram');

    expect(seen.map((a) => [a.question, a.answer])).toEqual([
      ['Web?', 'via web'],
      ['Telegram?', 'via telegram'],
    ]);
  });

  test('a throwing onAnswer does not break the answer', () => {
    const s = newStore({
      onAnswer: () => {
        throw new Error('boom');
      },
    });
    const q = s.ask('bot1', 0, 'Q?');
    expect(s.answerById(q.id, 'A').ok).toBe(true);
    expect(s.consumeAnswersForBot('bot1')).toHaveLength(1);
  });
});

describe('buildAskHumanAnswerNote', () => {
  test('names the question and carries the answer', () => {
    expect(buildAskHumanAnswerNote('Ship it?', 'Yes, today')).toBe(
      '[ask_human] Operator answered "Ship it?": Yes, today'
    );
  });

  test('truncates long questions and answers and flattens newlines', () => {
    const note = buildAskHumanAnswerNote('Q'.repeat(200), `line1\n${'a'.repeat(1000)}`);
    expect(note).not.toContain('\n');
    expect(note.length).toBeLessThan(700);
    expect(note).toContain('...');
  });
});

describe('reconcileAskHumanInbox', () => {
  let conversations: ConversationsService;
  let store: AskHumanStore;
  let memoryNotes: Array<[string, string]>;

  function deps(): AskHumanDeps {
    return {
      store,
      getBotInstance: () => undefined,
      getBotName: (id) => id,
      conversationsService: conversations,
      appendDailyMemory: (botId, note) => {
        memoryNotes.push([botId, note]);
      },
    };
  }

  function orphan(botId: string, questionId: string, question: string, options?: string[]) {
    const conv = conversations.createConversation(botId, 'inbox', question.slice(0, 60), {
      askHumanQuestionId: questionId,
      inboxStatus: 'pending',
      askOptions: options,
    });
    conversations.addMessage(botId, conv.id, 'bot', question);
    return conv;
  }

  beforeEach(() => {
    conversations = new ConversationsService(join(dir, 'conversations'));
    store = newStore();
    memoryNotes = [];
  });

  test('a pending inbox conversation the store lost is restored as a pending question', () => {
    const conv = orphan('bot1', 'q-lost', 'Approve 02?', ['Yes', 'No']);

    const result = reconcileAskHumanInbox(deps(), makeLogger());

    expect(result).toEqual({ restored: 1, markedAnswered: 0 });
    expect(store.getPendingForBot('bot1')).toEqual([
      {
        id: 'q-lost',
        botId: 'bot1',
        chatId: 0,
        question: 'Approve 02?',
        conversationId: conv.id,
        options: ['Yes', 'No'],
        createdAt: Date.parse(conv.createdAt),
      },
    ]);
  });

  test('after reconcile the operator can answer it and the answer reaches the planner queue', () => {
    const conv = orphan('bot1', 'q-lost', 'Approve 02?');
    reconcileAskHumanInbox(deps(), makeLogger());

    expect(store.answerById('q-lost', 'Approve').ok).toBe(true);
    const answers = store.consumeAnswersForBot('bot1');
    expect(answers).toMatchObject([{ question: 'Approve 02?', answer: 'Approve' }]);
    expect(answers[0].conversationId).toBe(conv.id);
  });

  test('after reconcile the 72 h sweep closes a stale orphan and tells the bot', () => {
    const conv = orphan('bot1', 'q-old', 'Old question?');
    reconcileAskHumanInbox(deps(), makeLogger());

    const now = Date.parse(conv.createdAt) + 73 * HOUR;
    const closed = sweepStaleAskHumanQuestions({ ...deps(), now: () => now }, makeLogger());

    expect(closed.map((q) => q.id)).toEqual(['q-old']);
    expect(conversations.getConversation('bot1', conv.id)?.inboxStatus).toBe('closed');
    expect(memoryNotes).toHaveLength(1);
    expect(memoryNotes[0][1]).toContain('auto-closed after 72h');
  });

  test('an orphan the operator already replied to in chat is marked answered, not restored', () => {
    const conv = orphan('bot1', 'q-replied', 'Lift the pause?');
    conversations.addMessage('bot1', conv.id, 'human', 'A: lift it');

    const result = reconcileAskHumanInbox(deps(), makeLogger());

    expect(result).toEqual({ restored: 0, markedAnswered: 1 });
    expect(store.getPendingCount()).toBe(0);
    expect(conversations.getConversation('bot1', conv.id)?.inboxStatus).toBe('answered');
  });

  test('a question the store already holds is left alone', () => {
    const { id, promise } = store.ask('bot1', 9, 'Live?', undefined, 123);
    promise.catch(() => {});
    const conv = orphan('bot1', id, 'Live?');
    store.setConversationId(id, conv.id);

    expect(reconcileAskHumanInbox(deps(), makeLogger())).toEqual({
      restored: 0,
      markedAnswered: 0,
    });
    expect(store.getPendingForBot('bot1')[0]).toMatchObject({ chatId: 9, createdAt: 123 });
  });

  test('non-pending inbox conversations and plain chats are ignored', () => {
    const closed = orphan('bot1', 'q-closed', 'Closed?');
    conversations.markInboxStatus('bot1', closed.id, 'closed');
    conversations.createConversation('bot1', 'general', 'chat');

    expect(reconcileAskHumanInbox(deps(), makeLogger())).toEqual({
      restored: 0,
      markedAnswered: 0,
    });
  });

  test('falls back to the title when the conversation has no bot message', () => {
    conversations.createConversation('bot1', 'inbox', 'Title only?', {
      askHumanQuestionId: 'q-title',
      inboxStatus: 'pending',
    });
    reconcileAskHumanInbox(deps(), makeLogger());
    expect(store.getPendingForBot('bot1')[0].question).toBe('Title only?');
  });

  test('without a conversations service it is a no-op', () => {
    expect(
      reconcileAskHumanInbox({ ...deps(), conversationsService: undefined }, makeLogger())
    ).toEqual({ restored: 0, markedAnswered: 0 });
  });
});
