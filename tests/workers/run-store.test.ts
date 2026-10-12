import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runJournalPath, workersDir } from '../../src/workers/paths';
import { WorkerRunStore } from '../../src/workers/run-store';
import type { WorkerRun } from '../../src/workers/types';
import { createTempDir, removeTempDir } from '../helpers/temp-dir';

let dir: string;
beforeEach(() => {
  dir = createTempDir('worker-run-store');
});
afterEach(() => removeTempDir(dir));

function run(over: Partial<WorkerRun> = {}): WorkerRun {
  return {
    runId: 'r-1',
    botId: 'b1',
    taskId: 't-1',
    goalId: 'g-1',
    dispatchCycleId: 'c-1',
    taskText: 'Do it',
    goalTitle: 'Goal',
    status: 'running',
    attempt: 1,
    step: 0,
    budget: { steps: 8, toolCalls: 40, wallMs: 1000 },
    used: { steps: 0, toolCalls: 0, wallMs: 0 },
    createdAt: '2026-10-12T10:00:00.000Z',
    ...over,
  };
}

describe('WorkerRunStore', () => {
  test('active runs round-trip through runs.json (atomic write, no tmp left)', () => {
    const store = new WorkerRunStore(dir);
    store.saveActive('b1', [run(), run({ runId: 'r-2', claimToken: 'tok' })]);
    const loaded = store.loadActive('b1');
    expect(loaded.map((r) => r.runId)).toEqual(['r-1', 'r-2']);
    expect(loaded[1].claimToken).toBe('tok');
    const files = require('node:fs').readdirSync(workersDir(dir, 'b1')) as string[];
    expect(files.filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  test('readers never throw: missing or corrupt files read as empty', () => {
    const store = new WorkerRunStore(dir);
    expect(store.loadActive('nobody')).toEqual([]);
    expect(store.readJournal('nobody', 'r-x')).toEqual([]);
    expect(store.readEnded('nobody')).toEqual([]);
    mkdirSync(workersDir(dir, 'b1'), { recursive: true });
    writeFileSync(join(workersDir(dir, 'b1'), 'runs.json'), '{not json');
    expect(store.loadActive('b1')).toEqual([]);
  });

  test('the journal is append-only JSONL and skips malformed lines', () => {
    const store = new WorkerRunStore(dir);
    store.appendJournal('b1', 'r-1', { ts: 't', runId: 'r-1', kind: 'run-start', attempt: 1 });
    store.appendJournal('b1', 'r-1', { ts: 't', runId: 'r-1', kind: 'step-start', n: 1 });
    const path = runJournalPath(dir, 'b1', 'r-1');
    writeFileSync(path, `${readFileSync(path, 'utf-8')}garbage\n`);
    store.appendJournal('b1', 'r-1', {
      ts: 't',
      runId: 'r-1',
      kind: 'tool',
      n: 1,
      name: 'web_fetch',
      ok: true,
      sideEffect: 'read',
    });
    expect(store.readJournal('b1', 'r-1').map((e) => e.kind)).toEqual([
      'run-start',
      'step-start',
      'tool',
    ]);
  });

  test('ended runs land in runs-YYYY-MM-DD.jsonl, newest first, without the claim token', () => {
    const store = new WorkerRunStore(dir);
    store.appendEnded(
      run({ runId: 'r-1', status: 'done', endedAt: '2026-10-11T09:00:00.000Z', claimToken: 'x' })
    );
    store.appendEnded(run({ runId: 'r-2', status: 'failed', endedAt: '2026-10-12T09:00:00.000Z' }));
    expect(existsSync(join(workersDir(dir, 'b1'), 'runs-2026-10-11.jsonl'))).toBe(true);
    const ended = store.readEnded('b1', { limit: 10 });
    expect(ended.map((r) => r.runId)).toEqual(['r-2', 'r-1']);
    expect(ended[1]).not.toHaveProperty('claimToken');
    expect(store.readEnded('b1', { limit: 1 })).toHaveLength(1);
  });

  test('listBots names every bot with a workers dir', () => {
    const store = new WorkerRunStore(dir);
    store.saveActive('b1', [run()]);
    store.saveActive('b2', []);
    expect(store.listBots().sort()).toEqual(['b1', 'b2']);
  });
});
