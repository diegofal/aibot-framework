import { describe, expect, test } from 'bun:test';
import {
  describeEvent,
  formatAgo,
  formatDuration,
  narrateBorn,
  narrateGoals,
  narrateHistory,
  narrateHolding,
  narrateIntegrateInsight,
  narrateIntegrateNoBroadcast,
  narrateIntrospection,
  narrateLateLink,
  narrateLearned,
  narrateLinkFailed,
  narrateLinkSkipped,
  narrateLinkStopped,
  narrateLinking,
  narrateMetBot,
  narrateMetPerson,
  narrateNoEmbeddings,
  narrateNoticeCapped,
  narrateNoticeFailed,
  narrateNoticeLearned,
  narrateNoticePass,
  narrateNoticePaused,
  narrateNoticeRecognised,
  narrateNoticeUnparsable,
  narrateNoticed,
  narrateRemembered,
  narrateResumeBirth,
  narrateResync,
  narrateRewake,
  narrateSenseSummary,
  narrateSleep,
  narrateStageFailed,
  narrateUnreadable,
  narrateWake,
  quoteModelText,
} from '../../src/watcher/narration';

describe('narration', () => {
  test('narrateWake', () => {
    expect(narrateWake({ bots: 8, tenants: 1, backends: ['claude-cli', 'ollama'] })).toBe(
      'Waking up for the first time. Looking around: 8 bots, 1 tenant, Claude CLI and Ollama available.'
    );
  });
  test('narrateWake with no backend', () => {
    expect(narrateWake({ bots: 1, tenants: 2, backends: [] })).toBe(
      'Waking up for the first time. Looking around: 1 bot, 2 tenants, no LLM backend configured.'
    );
  });
  test('narrateRewake', () => {
    expect(
      narrateRewake({
        neurons: 1240,
        lastAwakeMs: Date.parse('2026-10-23T04:00:00Z'),
        nowMs: Date.parse('2026-10-23T10:00:00Z'),
      })
    ).toBe('Waking up. 1,240 neurons, last awake 6 h ago.');
  });
  test('narrateRewake without a previous row', () => {
    expect(narrateRewake({ neurons: 3, nowMs: 0 })).toBe('Waking up. 3 neurons.');
  });
  test('narrateResumeBirth', () => {
    expect(narrateResumeBirth('knowledge')).toBe(
      'Waking up in the middle of being born. Picking up at birth:knowledge.'
    );
  });
  test('narrateMetBot', () => {
    expect(
      narrateMetBot({
        name: 'jarvis',
        purpose: "Jarvis, the operator's assistant",
        channel: 'telegram ok',
        activeGoals: 3,
      })
    ).toBe(`Met jarvis: "Jarvis, the operator's assistant" (telegram ok, 3 active goals).`);
  });
  test('narrateMetBot without purpose and one goal', () => {
    expect(narrateMetBot({ name: 'x', channel: 'dashboard only', activeGoals: 1 })).toBe(
      'Met x (dashboard only, 1 active goal).'
    );
  });
  test('narrateMetPerson', () => {
    expect(
      narrateMetPerson({ name: 'Ana', operator: true, channels: ['telegram', 'email'], bots: 3 })
    ).toBe('Met Ana (operator, telegram + email), known to 3 bots.');
  });
  test('narrateMetPerson, not the operator, one bot', () => {
    expect(narrateMetPerson({ name: 'Bo', operator: false, channels: ['web'], bots: 1 })).toBe(
      'Met Bo (web), known to 1 bot.'
    );
  });
  test('narrateGoals', () => {
    expect(narrateGoals({ bot: 'jarvis', goals: 3, openTasks: 7 })).toBe(
      'Learned what jarvis is working on: 3 goals, 7 open tasks.'
    );
  });
  test('narrateLearned', () => {
    expect(
      narrateLearned({
        bot: 'jarvis',
        text: 'Invoices from Acme arrive on the 3rd',
        kind: 'fact',
        confidence: 'high',
      })
    ).toBe(
      `Learned from jarvis's knowledge map: "Invoices from Acme arrive on the 3rd" (fact, confidence high).`
    );
  });
  test('narrateLearned without confidence', () => {
    expect(narrateLearned({ bot: 'j', text: 'Why?', kind: 'question' })).toBe(
      `Learned from j's knowledge map: "Why?" (question).`
    );
  });
  test('narrateRemembered', () => {
    expect(narrateRemembered({ bot: 'jarvis', text: 'Ana likes tea' })).toBe(
      'Remembered from jarvis: "Ana likes tea".'
    );
  });
  test('narrateHistory', () => {
    expect(narrateHistory({ days: 30, cycles: 212, goalsWorked: 14, goalsNever: 3 })).toBe(
      'Reviewed 30 days of history: 212 cycles. 14 goals were worked on, 3 never.'
    );
  });
  test('narrateLinking', () => {
    expect(narrateLinking({ neurons: 1240, edges: 3800 })).toBe(
      'Linking what I know: 1,240 neurons, 3,800 edges so far.'
    );
  });
  test('narrateLateLink', () => {
    expect(narrateLateLink({ embedded: 1, edges: 0 })).toBe(
      'Embedded 1 neuron I had not embedded yet: 0 new related edges.'
    );
    expect(narrateLateLink({ embedded: 120, edges: 1 })).toBe(
      'Embedded 120 neurons I had not embedded yet: 1 new related edge.'
    );
    expect(narrateLateLink({ embedded: 32, edges: 4, failure: 'ECONNREFUSED' })).toBe(
      'Embedded 32 neurons I had not embedded yet: 4 new related edges. Stopped at an embedding error (ECONNREFUSED); the rest at the next maintenance.'
    );
    expect(narrateLateLink({ embedded: 31, edges: 2, skipped: 1 })).toBe(
      'Embedded 31 neurons I had not embedded yet: 2 new related edges. 1 embed failed and was skipped; the next maintenance tries again.'
    );
  });
  test('narrateLinkSkipped notes a recovered error without claiming a stop', () => {
    expect(narrateLinkSkipped({ skipped: 1, failure: 'ECONNREFUSED' })).toBe(
      '1 embed failed and was skipped (ECONNREFUSED); it gets embedded at the next start or maintenance.'
    );
    expect(narrateLinkSkipped({ skipped: 3 })).toBe(
      '3 embeds failed and were skipped; they get embedded at the next start or maintenance.'
    );
  });
  test('narrateLinkFailed names the real reason and claims no placement', () => {
    const text = narrateLinkFailed({ pending: 300, reason: 'connect ECONNREFUSED' });
    expect(text).toBe(
      'Could not embed the 300 neurons without a vector (connect ECONNREFUSED). I will try again at the next maintenance.'
    );
    expect(text).not.toContain('Placing');
  });
  test('narrateLinkStopped says how far it got and that the rest follows', () => {
    expect(narrateLinkStopped({ embedded: 3, total: 1200, failure: 'connect ECONNREFUSED' })).toBe(
      'Stopped at an embedding error after 3 of 1,200 neurons (connect ECONNREFUSED). The rest get embedded at the next start or maintenance.'
    );
  });
  test('narrateNoEmbeddings', () => {
    expect(narrateNoEmbeddings('no embedding model configured')).toBe(
      'Could not embed what I know (no embedding model configured). Placing neurons by kind, without related edges.'
    );
  });
  test('narrateBorn', () => {
    expect(
      narrateBorn({
        counts: { entity: 8, person: 12, goal: 31, fact: 640, surprise: 44, topic: 0 },
        durationMs: 130_000,
        unreadable: [],
      })
    ).toBe(
      'Born. 735 neurons: 8 bots, 12 people, 31 goals, 640 facts, 44 surprises in 2 min 10 s.'
    );
  });
  test('narrateBorn names what it could not read', () => {
    expect(
      narrateBorn({
        counts: { entity: 1 },
        durationMs: 400,
        unreadable: ['b1/KNOWLEDGE.json', 'b2/TASKS.json'],
      })
    ).toBe('Born. 1 neuron: 1 bot in 400 ms. Could not read: b1/KNOWLEDGE.json, b2/TASKS.json.');
  });
  test('narrateStageFailed', () => {
    expect(narrateStageFailed('memory', new Error('boom'))).toBe(
      'Could not finish birth:memory (boom). Moving on.'
    );
  });
  test('narrateUnreadable', () => {
    expect(narrateUnreadable('b1/KNOWLEDGE.json', 'invalid JSON')).toBe(
      'Could not read b1/KNOWLEDGE.json (invalid JSON).'
    );
  });
  test('narrateResync', () => {
    expect(narrateResync({ bots: 1, goals: 2, people: 0 })).toBe(
      'Caught up on what changed while I slept: 1 new bot, 2 new goals, 0 new people.'
    );
  });
  test('narrateSleep', () => {
    expect(narrateSleep({ neurons: 1240 })).toBe('Going to sleep. 1,240 neurons.');
  });
  test('narrateNoticed', () => {
    expect(
      narrateNoticed({
        what: 'Ana wrote to jarvis about invoices',
        salience: 0.7,
        reasons: ['human message'],
        touched: 2,
      })
    ).toBe(
      'Noticed: Ana wrote to jarvis about invoices. Salience 0.7 (human message, touches 2 neurons).'
    );
  });
  test('narrateNoticed with nothing touched', () => {
    expect(
      narrateNoticed({
        what: 'web_fetch failed in b1',
        salience: 0.5,
        reasons: ['error', 'novel'],
        touched: 0,
      })
    ).toBe('Noticed: web_fetch failed in b1. Salience 0.5 (error, novel).');
  });
  test('narrateSenseSummary', () => {
    expect(
      narrateSenseSummary({
        events: 14,
        windowMs: 60_000,
        top: 'web_fetch failed in b1',
        topSalience: 0.5,
      })
    ).toBe('Sensed 14 events in the last 1 min, top: web_fetch failed in b1 (salience 0.5).');
  });
  test('narrateSenseSummary, one event and nothing salient', () => {
    expect(narrateSenseSummary({ events: 1, windowMs: 60_000 })).toBe(
      'Sensed 1 event in the last 1 min.'
    );
  });
});

describe('describeEvent', () => {
  const names = { botName: (id: string) => (id === 'b1' ? 'jarvis' : id) };
  test('human message names the sender and topic words', () => {
    expect(
      describeEvent(
        { botId: 'b1', channelKind: 'web', chatId: 'c', timestamp: 0, text: 'invoices acme' },
        { ...names, sender: 'Ana' }
      )
    ).toBe('Ana wrote to jarvis about invoices acme');
  });
  test('human message without sender or text', () => {
    expect(
      describeEvent({ botId: 'b1', channelKind: 'web', chatId: 'c', timestamp: 0 }, names)
    ).toBe('someone wrote to jarvis');
  });
  test('tool error', () => {
    expect(
      describeEvent(
        { type: 'tool:error', botId: 'b1', timestamp: 0, data: { toolName: 'web_fetch' } },
        names
      )
    ).toBe('web_fetch failed in jarvis');
  });
  test('llm error', () => {
    expect(describeEvent({ type: 'llm:error', botId: 'b1', timestamp: 0 }, names)).toBe(
      'an LLM call failed in jarvis'
    );
  });
  test('message sent', () => {
    expect(
      describeEvent(
        { type: 'tool:end', botId: 'b1', timestamp: 0, data: { toolName: 'send_message' } },
        names
      )
    ).toBe('jarvis sent a message');
  });
  test('task changed', () => {
    expect(
      describeEvent(
        {
          type: 'task:changed',
          botId: 'b1',
          timestamp: 0,
          data: { taskId: 't-1', op: 'task-move', from: 'todo', to: 'done' },
        },
        names
      )
    ).toBe('jarvis moved task t-1 from todo to done');
  });
  test('worker waiting and ended', () => {
    expect(
      describeEvent({ type: 'worker:waiting', botId: 'b1', timestamp: 0, data: {} }, names)
    ).toBe('a worker of jarvis is waiting for an answer');
    expect(
      describeEvent(
        { type: 'worker:ended', botId: 'b1', timestamp: 0, data: { status: 'blocked' } },
        names
      )
    ).toBe('a worker of jarvis ended blocked');
  });
  test('karma change', () => {
    expect(
      describeEvent({ type: 'karma:change', botId: 'b1', timestamp: 0, data: { delta: -2 } }, names)
    ).toBe("jarvis's karma moved -2");
  });
  test('memory flush and cycle result', () => {
    expect(describeEvent({ type: 'memory:flush', botId: 'b1', timestamp: 0 }, names)).toBe(
      'jarvis saved to memory'
    );
    expect(describeEvent({ type: 'agent:result', botId: 'b1', timestamp: 0 }, names)).toBe(
      'jarvis finished a cycle'
    );
  });
  test('anything else', () => {
    expect(describeEvent({ type: 'llm:start', botId: 'b1', timestamp: 0 }, names)).toBe(
      'llm:start in jarvis'
    );
  });
});

describe('formatting', () => {
  test('formatDuration', () => {
    expect(formatDuration(850)).toBe('850 ms');
    expect(formatDuration(41_000)).toBe('41 s');
    expect(formatDuration(130_000)).toBe('2 min 10 s');
    expect(formatDuration(120_000)).toBe('2 min');
  });
  test('formatAgo', () => {
    expect(formatAgo(20_000)).toBe('less than a minute');
    expect(formatAgo(12 * 60_000)).toBe('12 min');
    expect(formatAgo(6 * 3_600_000)).toBe('6 h');
    expect(formatAgo(3 * 86_400_000)).toBe('3 d');
  });
});

describe('notice narration (phase 2)', () => {
  test('quoteModelText quotes, collapses whitespace and clips model output', () => {
    expect(quoteModelText('  a\n  "b"  ')).toBe(`"a 'b'"`);
    expect(quoteModelText('x'.repeat(300))).toBe(`"${'x'.repeat(199)}…"`);
  });

  test('narrateNoticeLearned', () => {
    expect(
      narrateNoticeLearned({
        text: 'The Acme invoice is due on Friday',
        kind: 'fact',
        confidence: 'high',
        bots: ['Jarvis', 'Scout'],
      })
    ).toBe(
      'Learned: "The Acme invoice is due on Friday" (fact, confidence high; from Jarvis and Scout).'
    );
    expect(narrateNoticeLearned({ text: 'Invoices', kind: 'topic', bots: ['Jarvis'] })).toBe(
      'Learned: "Invoices" (topic; from Jarvis).'
    );
  });

  test('narrateNoticeRecognised', () => {
    expect(narrateNoticeRecognised({ text: 'Invoices', activations: 4 })).toBe(
      'Recognised again: "Invoices" (4 activations).'
    );
  });

  test('narrateNoticePass, with and without anything kept', () => {
    expect(narrateNoticePass({ events: 5, kept: 2, recognised: 1, dropped: 2 })).toBe(
      'Noticed 5 events: kept 2, recognised 1, let 2 go.'
    );
    expect(narrateNoticePass({ events: 3, kept: 0, recognised: 0, dropped: 3 })).toBe(
      'Noticed 3 events; nothing worth keeping.'
    );
  });

  test('narrateNoticeFailed', () => {
    expect(narrateNoticeFailed({ events: 4, error: 'spawn claude ENOENT' })).toBe(
      'Could not notice: the model call failed ("spawn claude ENOENT"). I kept the 4 events for the next pass.'
    );
  });

  test('narrateNoticeUnparsable', () => {
    expect(narrateNoticeUnparsable({ events: 1 })).toBe(
      "Could not read the model's answer as JSON. I kept the 1 event for the next pass."
    );
  });

  test('narrateNoticeCapped', () => {
    expect(narrateNoticeCapped({ maxPerDay: 288 })).toBe(
      "Reached today's noticing budget (288 calls). I keep sensing and will notice again tomorrow."
    );
  });

  test('narrateNoticePaused', () => {
    expect(narrateNoticePaused({ backend: 'claude-cli' })).toBe(
      'Claude CLI is rate-limited across the fleet (circuit open). Noticing is paused until it recovers.'
    );
  });
});

describe('narrateIntrospection (phase 4)', () => {
  test('says who asked and the score, in code-written words', () => {
    expect(narrateIntrospection({ trigger: 'manual', score: 0.75, parsed: true })).toBe(
      'The operator asked me what I am doing; my answer matched 75 % of what I was really doing.'
    );
    expect(narrateIntrospection({ trigger: 'sample', score: 0, parsed: false })).toBe(
      'I asked myself what I am doing; my answer could not be read (score 0).'
    );
  });
});

describe('narrateHolding / sense summary repeats', () => {
  test('a held item with its reasons, and without any', () => {
    expect(narrateHolding({ what: 'x failed', salience: 0.55, reasons: ['error', 'novel'] })).toBe(
      'Holding: x failed. Salience 0.6 (error, novel).'
    );
    expect(narrateHolding({ what: 'x', salience: 1, reasons: [] })).toBe('Holding: x. Salience 1.');
  });

  test('the sense summary counts repeats', () => {
    expect(narrateSenseSummary({ events: 4, windowMs: 60_000, repeats: 1 })).toBe(
      'Sensed 4 events in the last 1 min (1 repeat).'
    );
  });
});

describe('integrate broadcast reasoning', () => {
  test('an insight row carries why it broadcast nothing, or that no reason was given', () => {
    expect(
      narrateIntegrateInsight({
        text: 'Two briefs',
        bots: ['Jarvis', 'Scout'],
        whyNoBroadcast: 'operator decides',
      })
    ).toBe('I realised: "Two briefs" (across Jarvis and Scout; no broadcast: "operator decides").');
    expect(
      narrateIntegrateInsight({ text: 'Two briefs', bots: ['Jarvis'], reasonMissing: true })
    ).toBe('I realised: "Two briefs" (from Jarvis; no broadcast and no reason given).');
  });

  test('a no-broadcast row quotes the insight and the reason', () => {
    expect(narrateIntegrateNoBroadcast({ insight: 'Two briefs', why: 'already chosen' })).toBe(
      'Not broadcasting "Two briefs": "already chosen".'
    );
  });
});
