import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { HygieneHistory, HygieneRegistry } from '../../src/hygiene/registry';
import type { HygieneRun } from '../../src/hygiene/types';
import { createTempDir, removeTempDir } from '../helpers/temp-dir';
import { NOW, makeBot, makeConfig, noopLogger, writeFile } from './helpers';

let root: string;

beforeEach(() => {
  root = createTempDir('hygiene-registry');
});

afterEach(() => {
  removeTempDir(root);
});

function makeRegistry(bots = [makeBot({ id: 'bot1' }), makeBot({ id: 'bot2' })]) {
  const config = makeConfig(root, bots);
  return new HygieneRegistry({ config, logger: noopLogger, now: () => NOW });
}

describe('HygieneRegistry.listRoutines', () => {
  test('exposes the six routine ids with scope and canApply', () => {
    const list = makeRegistry().listRoutines();
    expect(list.map((r) => r.id)).toEqual([
      'goal-lint',
      'soul-structure',
      'memory-hygiene',
      'productions-triage',
      'data-cleanup',
      'all',
    ]);
    expect(list.find((r) => r.id === 'data-cleanup')!.scope).toBe('fleet');
    expect(list.find((r) => r.id === 'all')!.scope).toBe('fleet');
    expect(list.every((r) => typeof r.canApply === 'boolean' && r.name && r.description)).toBe(
      true
    );
  });
});

describe('HygieneRegistry.run', () => {
  test('bot-scoped preview resolves the soul dir the way the bot manager does', async () => {
    const soulDir = join(root, 'data', 'tenants', '__admin__', 'bots', 'bot1', 'soul');
    writeFile(
      join(soulDir, 'GOALS.md'),
      '## Active Goals\n- [ ] X\n  - status: archived\n  - priority: low\n'
    );
    const run = await makeRegistry().run({ routine: 'goal-lint', botId: 'bot1' });
    expect(run.routine).toBe('goal-lint');
    expect(run.botId).toBe('bot1');
    expect(run.dryRun).toBe(true);
    expect(run.findings.map((f) => f.kind)).toEqual(['archived-in-active']);
    expect(run.applied).toEqual([]);
    expect(run.runId).toBeTruthy();
    expect(run.startedAt <= run.finishedAt).toBe(true);
    // preview never writes
    expect(readFileSync(join(soulDir, 'GOALS.md'), 'utf-8')).toContain('status: archived');
  });

  test('honours bot.soulDir / bot.workDir overrides', async () => {
    const customSoul = join(root, 'custom-soul');
    writeFile(
      join(customSoul, 'GOALS.md'),
      '## Active Goals\n- [ ] X\n  - status: archived\n  - priority: low\n'
    );
    const registry = makeRegistry([makeBot({ id: 'bot1', soulDir: customSoul })]);
    const run = await registry.run({ routine: 'goal-lint', botId: 'bot1' });
    expect(run.findings).toHaveLength(1);
  });

  test('apply runs the fix, records backups and persists the run', async () => {
    const soulDir = join(root, 'data', 'tenants', '__admin__', 'bots', 'bot1', 'soul');
    writeFile(
      join(soulDir, 'GOALS.md'),
      '## Active Goals\n- [ ] X\n  - status: archived\n  - priority: low\n'
    );
    const registry = makeRegistry();
    const run = await registry.run({ routine: 'goal-lint', botId: 'bot1', apply: true });
    expect(run.dryRun).toBe(false);
    expect(run.applied).toHaveLength(1);
    expect(run.backups).toHaveLength(1);
    expect(existsSync(run.backups[0])).toBe(true);

    const history = registry.history.list({});
    expect(history).toHaveLength(1);
    expect(history[0].runId).toBe(run.runId);
    expect(existsSync(join(root, 'data', 'hygiene', 'runs.jsonl'))).toBe(true);
  });

  test('unknown routine → run with error, not persisted', async () => {
    const registry = makeRegistry();
    const run = await registry.run({ routine: 'nope' });
    expect(run.error).toMatch(/Unknown routine/);
    expect(registry.history.list({})).toHaveLength(0);
  });

  test('bot routine without botId or with unknown bot → error', async () => {
    const registry = makeRegistry();
    expect((await registry.run({ routine: 'goal-lint' })).error).toMatch(/botId/);
    expect((await registry.run({ routine: 'goal-lint', botId: 'zzz' })).error).toMatch(/not found/);
  });

  test('a throwing routine is captured as run.error and still persisted', async () => {
    const registry = makeRegistry();
    registry.register({
      id: 'boom',
      name: 'Boom',
      description: 'throws',
      scope: 'fleet',
      canApply: false,
      preview: () => {
        throw new Error('kaboom');
      },
      apply: () => ({ applied: [], skipped: [], backups: [] }),
    });
    const run = await registry.run({ routine: 'boom' });
    expect(run.error).toBe('kaboom');
    expect(registry.history.list({})[0].error).toBe('kaboom');
  });

  test('fleet routine ignores botId and runs data-cleanup', async () => {
    writeFile(join(root, 'data', 'karma', 'ghost', 'events.jsonl'), '{}');
    const run = await makeRegistry().run({ routine: 'data-cleanup' });
    expect(run.botId).toBeNull();
    expect(run.findings.map((f) => f.kind)).toEqual(['orphan-karma-dir']);
  });

  test('all: runs every bot routine for every bot plus data-cleanup, tagging findings with botId', async () => {
    writeFile(
      join(root, 'data', 'tenants', '__admin__', 'bots', 'bot1', 'soul', 'GOALS.md'),
      '## Active Goals\n- [ ] X\n  - status: archived\n  - priority: low\n'
    );
    writeFile(
      join(root, 'data', 'tenants', '__admin__', 'bots', 'bot2', 'soul', 'MEMORY.md'),
      'mail a@b.co\n'
    );
    writeFile(join(root, 'data', 'karma', 'ghost', 'events.jsonl'), '{}');
    const run = await makeRegistry().run({ routine: 'all' });
    expect(run.routine).toBe('all');
    expect(run.botId).toBeNull();
    const byBot = (id: string | undefined) =>
      run.findings.filter((f) => f.botId === id).map((f) => f.kind);
    expect(byBot('bot1')).toContain('archived-in-active');
    expect(byBot('bot2')).toContain('pii');
    expect(byBot(undefined)).toEqual(['orphan-karma-dir']);
    expect(run.findings.every((f) => f.id.includes(':'))).toBe(true);
    expect(new Set(run.findings.map((f) => f.id)).size).toBe(run.findings.length);
  });

  test('all: restricts to the given bots and can skip fleet routines', async () => {
    writeFile(
      join(root, 'data', 'tenants', '__admin__', 'bots', 'bot2', 'soul', 'MEMORY.md'),
      'mail a@b.co\n'
    );
    writeFile(join(root, 'data', 'karma', 'ghost', 'events.jsonl'), '{}');
    const run = await makeRegistry().run({ routine: 'all', botIds: ['bot1'], includeFleet: false });
    expect(run.findings.filter((f) => f.botId === 'bot2')).toHaveLength(0);
    expect(run.findings.filter((f) => f.kind === 'orphan-karma-dir')).toHaveLength(0);
  });

  test('all with apply applies per routine and aggregates backups', async () => {
    writeFile(
      join(root, 'data', 'tenants', '__admin__', 'bots', 'bot1', 'soul', 'GOALS.md'),
      '## Active Goals\n- [ ] X\n  - status: archived\n  - priority: low\n'
    );
    writeFile(join(root, 'data', 'karma', 'ghost', 'events.jsonl'), '{}');
    const run = await makeRegistry().run({ routine: 'all', apply: true });
    expect(run.dryRun).toBe(false);
    // goal-lint moved the goal, soul-structure created the missing MEMORY.md, data-cleanup trashed the orphan
    expect(run.applied.map((a) => a.action).sort()).toEqual([
      'create-memory-md',
      'move-to-completed',
      'trash',
    ]);
    expect(run.backups).toHaveLength(1);
    expect(existsSync(join(root, 'data', 'karma', 'ghost'))).toBe(false);
  });

  test('passes deps through to routines', async () => {
    const soulDir = join(root, 'data', 'tenants', '__admin__', 'bots', 'bot1', 'soul');
    writeFile(
      join(soulDir, 'GOALS.md'),
      '## Active Goals\n- [ ] Telegram digest\n  - status: pending\n  - priority: low\n'
    );
    const registry = new HygieneRegistry({
      config: makeConfig(root),
      logger: noopLogger,
      now: () => NOW,
      channelStateOf: () => 'error',
    });
    const run = await registry.run({ routine: 'goal-lint', botId: 'bot1' });
    expect(run.findings.map((f) => f.kind)).toEqual(['dead-trigger']);
  });
});

describe('HygieneHistory', () => {
  function fakeRun(i: number, botId: string | null = 'bot1'): HygieneRun {
    return {
      runId: `r${i}`,
      routine: 'goal-lint',
      botId,
      dryRun: true,
      startedAt: new Date(NOW.getTime() + i * 1000).toISOString(),
      finishedAt: new Date(NOW.getTime() + i * 1000).toISOString(),
      findings: [],
      applied: [],
      skipped: [],
      backups: [],
    };
  }

  test('append + list newest first, filtered by botId and limited', () => {
    const history = new HygieneHistory(join(root, 'data'), noopLogger);
    history.append(fakeRun(1, 'bot1'));
    history.append(fakeRun(2, 'bot2'));
    history.append(fakeRun(3, 'bot1'));
    history.append(fakeRun(4, null));
    expect(history.list({}).map((r) => r.runId)).toEqual(['r4', 'r3', 'r2', 'r1']);
    expect(history.list({ botId: 'bot1' }).map((r) => r.runId)).toEqual(['r3', 'r1']);
    expect(history.list({ limit: 2 }).map((r) => r.runId)).toEqual(['r4', 'r3']);
  });

  test('keeps only the last 500 runs on disk', () => {
    const history = new HygieneHistory(join(root, 'data'), noopLogger);
    for (let i = 0; i < 505; i++) history.append(fakeRun(i));
    const lines = readFileSync(join(root, 'data', 'hygiene', 'runs.jsonl'), 'utf-8')
      .trim()
      .split('\n');
    expect(lines).toHaveLength(500);
    expect(history.list({ limit: 1 })[0].runId).toBe('r504');
    expect(history.list({ limit: 1000 }).at(-1)!.runId).toBe('r5');
  });

  test('survives a corrupt line and a missing file', () => {
    const history = new HygieneHistory(join(root, 'data'), noopLogger);
    expect(history.list({})).toEqual([]);
    writeFile(join(root, 'data', 'hygiene', 'runs.jsonl'), 'not json\n');
    history.append(fakeRun(1));
    expect(history.list({}).map((r) => r.runId)).toEqual(['r1']);
  });
});
