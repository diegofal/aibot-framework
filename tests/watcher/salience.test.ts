import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HumanInboundEvent } from '../../src/bot/agent-loop-utils';
import { Graph } from '../../src/watcher/graph';
import {
  decay,
  eventText,
  privateView,
  repeatKey,
  scoreEvent,
  topicWords,
  withoutNovelty,
} from '../../src/watcher/salience';
import type { SensedEvent } from '../../src/watcher/types';

function emptyGraph() {
  const g = new Graph(mkdtempSync(join(tmpdir(), 'watcher-sal-')));
  g.load();
  return g;
}

const ctx = () => ({ graph: emptyGraph(), nowMs: 0 });
const ev = (type: string, data: Record<string, unknown> = {}): SensedEvent =>
  ({ type, botId: 'b1', timestamp: 0, data }) as SensedEvent;
const human = (text?: string): HumanInboundEvent => ({
  botId: 'b1',
  channelKind: 'web',
  chatId: 'c1',
  timestamp: 0,
  ...(text ? { text } : {}),
});

describe('scoreEvent table', () => {
  test('human_inbound +0.5', () => {
    const s = scoreEvent(human(), ctx());
    expect(s.salience).toBeCloseTo(0.5);
    expect(s.reasons).toEqual(['human message']);
  });
  test('send_message and send_proactive_message +0.5', () => {
    expect(scoreEvent(ev('tool:end', { toolName: 'send_message' }), ctx()).salience).toBeCloseTo(
      0.5
    );
    expect(
      scoreEvent(ev('tool:end', { toolName: 'send_proactive_message' }), ctx()).reasons
    ).toEqual(['message sent']);
  });
  test('another tool:end scores nothing', () => {
    expect(scoreEvent(ev('tool:end', { toolName: 'file_read' }), ctx()).salience).toBe(0);
  });
  test('tool:error and llm:error +0.3', () => {
    expect(scoreEvent(ev('tool:error', { toolName: 'x' }), ctx()).salience).toBeCloseTo(0.3);
    expect(scoreEvent(ev('llm:error'), ctx()).reasons).toEqual(['error']);
  });
  test('task:changed +0.2', () => {
    expect(scoreEvent(ev('task:changed', { taskId: 't' }), ctx()).salience).toBeCloseTo(0.2);
  });
  test('worker:waiting +0.4', () => {
    expect(scoreEvent(ev('worker:waiting'), ctx()).salience).toBeCloseTo(0.4);
  });
  test('worker:ended blocked +0.4, done nothing', () => {
    expect(scoreEvent(ev('worker:ended', { status: 'blocked' }), ctx()).salience).toBeCloseTo(0.4);
    expect(scoreEvent(ev('worker:ended', { status: 'done' }), ctx()).salience).toBe(0);
  });
  // The surprises come from the curiosity extractor, after the cycle's
  // agent:result (which never carried them): `curiosity:surprise`.
  test('curiosity:surprise with surprises +0.3, without nothing', () => {
    const e = ev('curiosity:surprise', { surprises: ['x'] });
    expect(scoreEvent(e, ctx()).reasons).toContain('surprise');
    expect(scoreEvent(e, ctx()).salience).toBeCloseTo(0.3);
    expect(scoreEvent(ev('curiosity:surprise', { surprises: [] }), ctx()).salience).toBe(0);
  });
  test('agent:result scores nothing on its own', () => {
    expect(scoreEvent(ev('agent:result', { surprises: ['x'] }), ctx()).salience).toBe(0);
  });
  test('karma:change |delta|/10', () => {
    expect(scoreEvent(ev('karma:change', { delta: -3 }), ctx()).salience).toBeCloseTo(0.3);
    expect(scoreEvent(ev('karma:change', { delta: 'x' }), ctx()).salience).toBe(0);
  });
  test('memory:flush +0.1', () => {
    expect(scoreEvent(ev('memory:flush'), ctx()).salience).toBeCloseTo(0.1);
  });
  test('novelty +0.2 when no neuron matches the text', () => {
    const s = scoreEvent(ev('tool:error', { error: 'host refused the connection' }), ctx());
    expect(s.salience).toBeCloseTo(0.5);
    expect(s.reasons).toEqual(['error', 'novel']);
  });
});

describe('scoreEvent against a graph', () => {
  test('a matching neuron is touched and the event is not novel', () => {
    const graph = emptyGraph();
    const n = graph.addNeuron({
      kind: 'fact',
      text: 'invoices from acme',
      support: { bots: ['b1'] },
      createdBy: 'bot:b1',
    });
    const s = scoreEvent(human('invoices from acme'), { graph, nowMs: 0 });
    expect(s.touched).toEqual([n.id]);
    expect(s.reasons).toEqual(['human message']);
  });
  test('the goal neuron named by goalId is touched', () => {
    const graph = emptyGraph();
    const g = graph.addNeuron({
      kind: 'goal',
      text: 'Research',
      support: { bots: ['b1'] },
      createdBy: 'bot:b1',
      meta: { key: 'goal:b1:g-1' },
    });
    const s = scoreEvent(ev('task:changed', { taskId: 't', goalId: 'g-1' }), { graph, nowMs: 0 });
    expect(s.touched).toEqual([g.id]);
  });
});

describe('helpers', () => {
  test('decay halves every hour', () => {
    expect(decay(1, 0)).toBe(1);
    expect(decay(1, 3_600_000)).toBeCloseTo(0.5);
    expect(decay(0.8, 7_200_000)).toBeCloseTo(0.2);
  });
  test('eventText picks the readable part', () => {
    expect(eventText(human('hi there'))).toBe('hi there');
    expect(eventText(ev('tool:error', { error: 'boom' }))).toBe('boom');
    expect(eventText(ev('agent:result', { summary: 'did it' }))).toBe('did it');
    expect(eventText(ev('karma:change', { reason: 'r' }))).toBe('r');
    expect(eventText(ev('memory:flush'))).toBeUndefined();
  });
  test('topicWords drops stopwords, short words, numbers, emails, handles and urls', () => {
    expect(
      topicWords(
        'Hola, my email is ana@x.com and the invoice 1234 from Acme arrives at https://acme.io @bob'
      )
    ).toBe('hola email invoice acme arrives');
  });
  test('topicWords caps the count and dedupes', () => {
    expect(topicWords('alpha beta gamma delta epsilon zeta theta alpha', 3)).toBe(
      'alpha beta gamma'
    );
  });
  test('privateView keeps operator text and reduces anyone else to topic words', () => {
    const e = human('Please pay the Acme invoice tomorrow, my card is 4111');
    expect(privateView(e, true).text).toBe(e.text);
    expect(privateView(e, false).text).toBe('please acme invoice tomorrow card');
    expect(privateView(human(), false).text).toBeUndefined();
  });
});

describe('repeatKey / withoutNovelty', () => {
  const ev = (type: string, data: Record<string, unknown>, botId = 'b1') =>
    ({ type, botId, timestamp: 0, data }) as never;

  test('a failed tool keys by tool and error class, ignoring numbers', () => {
    const a = repeatKey(
      ev('tool:error', { toolName: 'web_fetch', error: 'timeout after 3001 ms' })
    );
    const b = repeatKey(
      ev('tool:end', { toolName: 'web_fetch', success: false, result: 'Timeout after 12 ms' })
    );
    expect(a).toBeDefined();
    expect(a).toBe(b);
  });

  test('without error text a failure keys by failure kind and target', () => {
    const k = repeatKey(
      ev('tool:end', {
        toolName: 'web_fetch',
        success: false,
        failureKind: 'blocked',
        target: 'x.com',
      })
    );
    expect(k).toBe('b1|fail|web_fetch|blocked|x.com');
  });

  test('other events key by type and text; no text, no key; bots differ', () => {
    expect(repeatKey(ev('agent:result', { summary: 'Done 3' }))).toBe('b1|agent:result|done #');
    expect(repeatKey(ev('llm:start', {}))).toBeUndefined();
    expect(repeatKey(ev('agent:result', { summary: 'x' }, 'b2'))).not.toBe(
      repeatKey(ev('agent:result', { summary: 'x' }))
    );
  });

  test('human messages are never keyed', () => {
    expect(
      repeatKey({
        botId: 'b1',
        channelKind: 'rest',
        chatId: '1',
        userId: '1',
        timestamp: 0,
        text: 'hola',
      })
    ).toBeUndefined();
  });

  test('withoutNovelty drops the bonus and the reason, and leaves other scores alone', () => {
    expect(withoutNovelty({ salience: 0.5, reasons: ['error', 'novel'], touched: [] })).toEqual({
      salience: 0.3,
      reasons: ['error'],
      touched: [],
    });
    const plain = { salience: 0.3, reasons: ['error'], touched: [] };
    expect(withoutNovelty(plain)).toBe(plain);
  });
});
