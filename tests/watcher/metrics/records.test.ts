import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadMetricsRecords } from '../../../src/watcher/metrics/records';

let root: string;
const NOW = Date.parse('2026-10-23T12:00:00Z');
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'watcher-records-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function config() {
  return {
    paths: { data: join(root, 'data') },
    bots: [{ id: 'b1', name: 'B1', soulDir: join(root, 'soul', 'b1') }],
    operator: { proactiveDailyCap: 4 },
    watcher: undefined,
  } as never;
}

describe('loadMetricsRecords', () => {
  test('nothing on disk gives empty records, never a throw', () => {
    const r = loadMetricsRecords({
      config: config(),
      dir: join(root, 'missing'),
      neurons: () => [],
      nowMs: NOW,
      window: '7d',
    });
    expect(r).toMatchObject({
      neurons: [],
      broadcasts: [],
      cycles: [],
      budgetDays: [],
      canaries: [],
      introspection: [],
      knowledgeSurprises: [],
      proactiveDailyCap: 4,
    });
    expect(r.baselineIdleShare).toBeUndefined();
  });

  test('reads budget days, baseline, canaries, introspection, cycles and knowledge surprises', () => {
    const dir = join(root, 'data', 'watcher');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'budget-2026-10-23.json'),
      JSON.stringify({ notice: { calls: 2, tokens: 10, costUsd: 0.1 }, integrate: { calls: 1 } })
    );
    writeFileSync(join(dir, 'budget-broken.json'), '{');
    writeFileSync(
      join(dir, 'baseline-2026-10-20.json'),
      JSON.stringify({ fleet: { idleShare: 0.4 } })
    );
    writeFileSync(join(dir, 'canaries.jsonl'), '{"kind":"check","found":true}\nnot json\n');
    writeFileSync(join(dir, 'introspection.jsonl'), '{"subject":"watcher","score":1}\n');
    const cycles = join(root, 'data', 'agent-cycles', 'b1');
    mkdirSync(cycles, { recursive: true });
    writeFileSync(
      join(cycles, '2026-10-23.jsonl'),
      `${JSON.stringify({ cycleId: 'c1', startedAt: '2026-10-23T10:00:00Z', status: 'idle' })}\n`
    );
    const soul = join(root, 'soul', 'b1');
    mkdirSync(soul, { recursive: true });
    writeFileSync(
      join(soul, 'KNOWLEDGE.json'),
      JSON.stringify({
        topics: [{ name: 't', surprises: [{ id: 's', text: 'Herons nest high', at: 'x' }] }],
      })
    );
    const r = loadMetricsRecords({
      config: config(),
      dir,
      neurons: () => {
        throw new Error('graph gone');
      },
      nowMs: NOW,
      window: '7d',
      semaphore: () => ({ queuedInteractive: 1, activeWatcher: 0 }),
    });
    expect(r.budgetDays).toEqual([
      {
        date: '2026-10-23',
        notice: { calls: 2, tokens: 10, costUsd: 0.1 },
        integrate: { calls: 1, tokens: 0, costUsd: 0 },
      },
    ]);
    expect(r.baselineIdleShare).toBe(0.4);
    expect(r.canaries).toHaveLength(1);
    expect(r.introspection).toEqual([{ subject: 'watcher', score: 1 }]);
    expect(r.cycles.map((c) => c.cycleId)).toEqual(['c1']);
    expect(r.knowledgeSurprises).toEqual(['Herons nest high']);
    expect(r.neurons).toEqual([]);
    expect(r.semaphore).toEqual({ queuedInteractive: 1, activeWatcher: 0 });
  });
});
