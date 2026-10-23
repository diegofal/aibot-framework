import { describe, expect, test } from 'bun:test';
import {
  NOTICE_KEEP_KINDS,
  type NoticePromptItem,
  buildNoticePrompt,
} from '../../src/watcher/prompts';
import type { Neuron } from '../../src/watcher/types';

const items: NoticePromptItem[] = [
  {
    id: 'b-11111111',
    botId: 'b1',
    bot: 'Jarvis',
    at: '2026-10-23T10:00:00.000Z',
    what: 'the operator wrote to Jarvis about The Acme invoice is due on Friday',
    salience: 0.7,
    reasons: ['human', 'novel'],
    fromOperator: true,
  },
  {
    id: 'b-22222222',
    botId: 'b2',
    bot: 'Scout',
    at: '2026-10-23T10:01:00.000Z',
    what: 'web_fetch failed in Scout',
    detail: 'error: 403 wiley.com',
    salience: 0.5,
    reasons: ['tool error', 'novel'],
    fromOperator: false,
  },
];

const touched: Neuron[] = [
  {
    id: 'n-aaaaaaaa',
    kind: 'topic',
    text: 'Invoices',
    support: { bots: ['b1'] },
    createdBy: 'bot:b1',
    createdAt: '2026-10-01T00:00:00.000Z',
    lastActivatedAt: '2026-10-01T00:00:00.000Z',
    activations: 3,
  },
];

describe('buildNoticePrompt', () => {
  test('lists every event with its id, bot, time, salience and who wrote it', () => {
    const { user } = buildNoticePrompt(items, touched);
    expect(user).toContain('## Events');
    expect(user).toContain(
      '- [b-11111111] 2026-10-23T10:00:00.000Z · Jarvis · from the operator · salience 0.7 (human, novel)'
    );
    expect(user).toContain(
      '  the operator wrote to Jarvis about The Acme invoice is due on Friday'
    );
    expect(user).toContain('- [b-22222222] 2026-10-23T10:01:00.000Z · Scout · salience 0.5');
    expect(user).toContain('  error: 403 wiley.com');
  });

  test('lists the neurons the events touched', () => {
    const { user } = buildNoticePrompt(items, touched);
    expect(user).toContain('## Neurons these events touched');
    expect(user).toContain('- [n-aaaaaaaa] topic: Invoices (3 activations)');
  });

  test('says so when no neuron was touched', () => {
    expect(buildNoticePrompt(items, []).user).toContain('## Neurons these events touched\n(none)');
  });

  test('states the JSON contract with the allowed kinds', () => {
    const { system, user } = buildNoticePrompt(items, touched);
    expect(user).toContain('## Answer');
    expect(user).toContain('"keep"');
    expect(user).toContain('"from"');
    expect(user).toContain('"relatedTo"');
    expect(user).toContain('"drop"');
    expect(user).toContain('"touched"');
    for (const k of NOTICE_KEEP_KINDS) expect(user).toContain(k);
    expect(system).toContain('JSON');
  });

  test('carries the privacy rule: only operator events may become facts', () => {
    const { system } = buildNoticePrompt(items, touched);
    expect(system).toContain('from the operator');
    expect(system).toContain('fact');
  });
});
