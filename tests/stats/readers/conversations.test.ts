import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  lastHumanMessageAt,
  readInboxAsks,
  summariseAsks,
} from '../../../src/stats/readers/conversations';
import { createTempDir, removeTempDir } from '../../helpers/temp-dir';

const T0 = '2026-08-20T10:00:00.000Z';
const T1 = '2026-08-20T10:05:00.000Z';
const T2 = '2026-08-21T09:00:00.000Z';

let dir: string;
beforeEach(() => {
  dir = createTempDir('stats-conv');
});
afterEach(() => removeTempDir(dir));

function jsonl(path: string, rows: unknown[]) {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`);
}

function seed() {
  jsonl(join(dir, 'b1', 'conversations.jsonl'), [
    {
      id: 'c1',
      botId: 'b1',
      type: 'inbox',
      title: 'Q1',
      createdAt: T0,
      updatedAt: T1,
      messageCount: 2,
      askHumanQuestionId: 'q1',
      inboxStatus: 'answered',
    },
    {
      id: 'c2',
      botId: 'b1',
      type: 'inbox',
      title: 'Q2',
      createdAt: T2,
      updatedAt: T2,
      messageCount: 1,
      askHumanQuestionId: 'q2',
      inboxStatus: 'pending',
    },
    {
      id: 'c3',
      botId: 'b1',
      type: 'general',
      title: 'chat',
      createdAt: T0,
      updatedAt: T0,
      messageCount: 1,
    },
    {
      id: 'c4',
      botId: 'b1',
      type: 'inbox',
      title: 'Q4',
      createdAt: T0,
      updatedAt: T0,
      messageCount: 1,
      inboxStatus: 'timed_out',
    },
  ]);
  jsonl(join(dir, 'b1', 'messages', 'c1.jsonl'), [
    { id: 'm1', role: 'bot', content: 'x'.repeat(400), createdAt: T0 },
    { id: 'm2', role: 'human', content: 'yes', createdAt: T1 },
  ]);
  jsonl(join(dir, 'b1', 'messages', 'c2.jsonl'), [
    { id: 'm3', role: 'bot', content: 'short?', createdAt: T2 },
  ]);
  jsonl(join(dir, 'b1', 'messages', 'c3.jsonl'), [
    { id: 'm4', role: 'human', content: 'hi', createdAt: T0 },
  ]);
  jsonl(join(dir, 'b1', 'messages', 'c4.jsonl'), [
    { id: 'm5', role: 'bot', content: 'q4', createdAt: T0 },
  ]);
}

describe('readInboxAsks', () => {
  it('[] when nothing exists', () => {
    expect(readInboxAsks(dir, 'b1')).toEqual([]);
  });
  it('returns inbox conversations with question length and answer time', () => {
    seed();
    const asks = readInboxAsks(dir, 'b1');
    expect(asks.map((a) => a.id).sort()).toEqual(['c1', 'c2', 'c4']);
    const c1 = asks.find((a) => a.id === 'c1');
    expect(c1).toEqual({
      id: 'c1',
      title: 'Q1',
      createdAt: T0,
      inboxStatus: 'answered',
      questionChars: 400,
      answeredAt: T1,
    });
    const c2 = asks.find((a) => a.id === 'c2');
    expect(c2?.answeredAt).toBeNull();
    expect(c2?.questionChars).toBe(6);
  });
});

describe('summariseAsks', () => {
  it('counts sent / answered / pending / closed-unanswered within a window', () => {
    seed();
    const asks = readInboxAsks(dir, 'b1');
    const all = summariseAsks(asks, 0);
    expect(all).toEqual({ asksSent: 3, asksAnswered: 1, asksPending: 1, asksClosedUnanswered: 1 });
    const recent = summariseAsks(asks, Date.parse(T2) - 1000);
    expect(recent).toEqual({
      asksSent: 1,
      asksAnswered: 0,
      asksPending: 1,
      asksClosedUnanswered: 0,
    });
  });
});

describe('lastHumanMessageAt', () => {
  it('null when nothing exists', () => {
    expect(lastHumanMessageAt(dir, 'b1')).toBeNull();
  });
  it('returns the latest human-authored message timestamp across all conversations', () => {
    seed();
    expect(lastHumanMessageAt(dir, 'b1')).toBe(Date.parse(T1));
  });
});
