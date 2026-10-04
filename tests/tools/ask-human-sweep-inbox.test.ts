/**
 * The hourly ask_human sweep used to iterate only the in-memory store. A
 * pending inbox conversation whose question the store no longer held (lost
 * store file, an ask that never got a question id) was reconciled only at
 * startup, so between restarts it sat in Needs You forever. The sweep now also
 * closes those conversations once they are older than `autoCloseHours`.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { AskHumanStore } from '../../src/bot/ask-human-store';
import { ConversationsService } from '../../src/conversations/service';
import type { Logger } from '../../src/logger';
import {
  type AskHumanDeps,
  closeStaleInboxConversations,
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
let store: AskHumanStore;
let conversations: ConversationsService;
let notes: Array<[string, string]>;
let clock: number;

function deps(): AskHumanDeps {
  return {
    store,
    getBotInstance: () => undefined,
    getBotName: (id) => id,
    conversationsService: conversations,
    appendDailyMemory: (botId, note) => {
      notes.push([botId, note]);
    },
    autoCloseHours: 72,
    now: () => clock,
  };
}

function pendingConversation(botId: string, title: string, questionId?: string) {
  const conv = conversations.createConversation(botId, 'inbox', title, {
    ...(questionId ? { askHumanQuestionId: questionId } : {}),
    inboxStatus: 'pending',
  });
  conversations.addMessage(botId, conv.id, 'bot', title);
  return conv;
}

function statusOf(botId: string, convId: string) {
  return conversations.getConversation(botId, convId)?.inboxStatus;
}

beforeEach(() => {
  dir = createTempDir('ask-human-sweep-inbox');
  store = new AskHumanStore(makeLogger(), join(dir, 'ask-human'));
  conversations = new ConversationsService(join(dir, 'conversations'));
  notes = [];
  clock = Date.now();
});

afterEach(() => {
  store.dispose();
  removeTempDir(dir);
});

describe('closeStaleInboxConversations', () => {
  test('closes a stale pending conversation the store does not hold', () => {
    const conv = pendingConversation('bot1', 'Old orphan?', 'q-gone');
    clock += 100 * HOUR;

    const closed = closeStaleInboxConversations(deps(), makeLogger());

    expect(closed.map((c) => c.id)).toEqual([conv.id]);
    expect(statusOf('bot1', conv.id)).toBe('closed');
    expect(notes).toHaveLength(1);
    expect(notes[0][0]).toBe('bot1');
    expect(notes[0][1]).toContain('auto-closed after 72h');
  });

  test('closes a stale pending conversation with no question id at all', () => {
    const conv = pendingConversation('bot1', 'No id');
    clock += 73 * HOUR;
    closeStaleInboxConversations(deps(), makeLogger());
    expect(statusOf('bot1', conv.id)).toBe('closed');
  });

  test('leaves young orphans pending', () => {
    const conv = pendingConversation('bot1', 'Fresh orphan', 'q-gone');
    clock += 10 * HOUR;
    expect(closeStaleInboxConversations(deps(), makeLogger())).toEqual([]);
    expect(statusOf('bot1', conv.id)).toBe('pending');
  });

  test('never touches a conversation whose question is still live in the store', () => {
    const { id, promise } = store.ask('bot1', 0, 'Live?', undefined, clock + 99 * HOUR);
    promise.catch(() => {});
    const conv = pendingConversation('bot1', 'Live?', id);
    store.setConversationId(id, conv.id);
    clock += 100 * HOUR;
    expect(closeStaleInboxConversations(deps(), makeLogger())).toEqual([]);
    expect(statusOf('bot1', conv.id)).toBe('pending');
  });

  test('scopes to one bot when botId is given', () => {
    const a = pendingConversation('bot1', 'A', 'qa');
    const b = pendingConversation('bot2', 'B', 'qb');
    clock += 100 * HOUR;
    closeStaleInboxConversations(deps(), makeLogger(), 'bot2');
    expect(statusOf('bot1', a.id)).toBe('pending');
    expect(statusOf('bot2', b.id)).toBe('closed');
  });

  test('marks a stale orphan answered (not closed) when the thread carries a human reply', () => {
    const conv = pendingConversation('bot1', 'Answered in chat?', 'q-gone');
    conversations.addMessage('bot1', conv.id, 'human', 'Yes, go ahead');
    clock += 100 * HOUR;

    const closed = closeStaleInboxConversations(deps(), makeLogger());

    expect(closed).toEqual([]);
    expect(statusOf('bot1', conv.id)).toBe('answered');
    expect(notes.some(([, n]) => n.includes('without answer'))).toBe(false);
  });

  test('is a no-op without a conversations service', () => {
    const d = { ...deps(), conversationsService: undefined };
    expect(closeStaleInboxConversations(d, makeLogger())).toEqual([]);
  });
});

describe('sweepStaleAskHumanQuestions covers orphaned inbox conversations', () => {
  test('the hourly sweep closes both stale store questions and stale orphans', () => {
    const { id, promise } = store.ask('bot1', 0, 'Stored?', undefined, clock);
    promise.catch(() => {});
    const stored = pendingConversation('bot1', 'Stored?', id);
    store.setConversationId(id, stored.id);
    const orphan = pendingConversation('bot1', 'Orphan?', 'q-lost');
    clock += 100 * HOUR;

    const closed = sweepStaleAskHumanQuestions(deps(), makeLogger());

    expect(closed.map((q) => q.id)).toEqual([id]);
    expect(statusOf('bot1', stored.id)).toBe('closed');
    expect(statusOf('bot1', orphan.id)).toBe('closed');
    // One memory note per closed ask, no double note for the stored one.
    expect(notes).toHaveLength(2);
  });
});
