/**
 * Daily auto-archive: productions-triage applied with archiveStale for every
 * bot whose productions are on. Archive moves into archived/, never deletes.
 */
import { describe, expect, it } from 'bun:test';
import {
  resolveAutoArchive,
  runAutoArchive,
  startAutoArchive,
} from '../../src/hygiene/auto-archive';
import type { HygieneRunRequest } from '../../src/hygiene/registry';
import type { HygieneRun } from '../../src/hygiene/types';

const quiet = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as never;

function run(botId: string, applied: number, error?: string): HygieneRun {
  return {
    runId: botId,
    routine: 'productions-triage',
    botId,
    dryRun: false,
    startedAt: '',
    finishedAt: '',
    findings: [],
    applied: Array.from({ length: applied }, (_, i) => ({
      findingId: `f${i}`,
      action: 'archive',
      result: 'x',
    })),
    skipped: [],
    backups: [],
    ...(error ? { error } : {}),
  } as HygieneRun;
}

function fakeRegistry(results: Record<string, HygieneRun> = {}) {
  const calls: HygieneRunRequest[] = [];
  return {
    calls,
    registry: {
      run: async (req: HygieneRunRequest) => {
        calls.push(req);
        if (req.botId === 'boom') throw new Error('kaput');
        return results[req.botId ?? ''] ?? run(req.botId ?? '', 0);
      },
    },
  };
}

const config = (autoArchive?: Record<string, unknown>) =>
  ({
    productions: {
      enabled: true,
      baseDir: './productions',
      ...(autoArchive ? { autoArchive } : {}),
    },
    bots: [
      { id: 'a', name: 'A' },
      { id: 'off', name: 'Off', productions: { enabled: false } },
      { id: 'b', name: 'B' },
    ],
  }) as never;

describe('resolveAutoArchive', () => {
  it('defaults to on, 7 stale days, every 24 h', () => {
    expect(resolveAutoArchive(config())).toEqual({
      enabled: true,
      staleDays: 7,
      intervalHours: 24,
    });
  });

  it('honours the config switch and values', () => {
    expect(
      resolveAutoArchive(config({ enabled: false, staleDays: 14, intervalHours: 12 }))
    ).toEqual({
      enabled: false,
      staleDays: 14,
      intervalHours: 12,
    });
  });

  it('is off when productions are off globally', () => {
    expect(resolveAutoArchive({ productions: { enabled: false }, bots: [] } as never).enabled).toBe(
      false
    );
  });
});

describe('runAutoArchive', () => {
  it('applies productions-triage with archiveStale for each bot with productions on', async () => {
    const { calls, registry } = fakeRegistry({ a: run('a', 2), b: run('b', 1) });
    const summary = await runAutoArchive({ registry, config: config(), logger: quiet });
    expect(calls).toEqual([
      {
        routine: 'productions-triage',
        botId: 'a',
        apply: true,
        options: { archiveStale: true, staleDays: 7 },
      },
      {
        routine: 'productions-triage',
        botId: 'b',
        apply: true,
        options: { archiveStale: true, staleDays: 7 },
      },
    ]);
    expect(summary).toEqual({ bots: 2, archived: 3, failed: [] });
  });

  it('a failing bot is reported and never stops the others', async () => {
    const { calls, registry } = fakeRegistry({ b: run('b', 0, 'bad dir') });
    const cfg = {
      productions: { enabled: true },
      bots: [{ id: 'boom' }, { id: 'b' }, { id: 'c' }],
    } as never;
    const summary = await runAutoArchive({ registry, config: cfg, logger: quiet });
    expect(calls.map((c) => c.botId)).toEqual(['boom', 'b', 'c']);
    expect(summary.failed).toEqual(['boom', 'b']);
  });
});

describe('startAutoArchive', () => {
  function fakeTimers() {
    const timeouts: Array<{ fn: () => void; ms: number }> = [];
    const intervals: Array<{ fn: () => void; ms: number }> = [];
    let cleared = 0;
    return {
      timeouts,
      intervals,
      get cleared() {
        return cleared;
      },
      timers: {
        setTimeout: (fn: () => void, ms: number) => {
          timeouts.push({ fn, ms });
          return { unref() {} } as never;
        },
        setInterval: (fn: () => void, ms: number) => {
          intervals.push({ fn, ms });
          return { unref() {} } as never;
        },
        clear: () => {
          cleared += 1;
        },
      },
    };
  }

  it('does nothing when disabled', () => {
    const t = fakeTimers();
    const { registry } = fakeRegistry();
    const handle = startAutoArchive({
      registry,
      config: config({ enabled: false }),
      logger: quiet,
      timers: t.timers,
    });
    expect(handle).toBeNull();
    expect(t.timeouts).toHaveLength(0);
  });

  it('runs once after the start delay, then every intervalHours; stop clears the timers', async () => {
    const t = fakeTimers();
    const { calls, registry } = fakeRegistry();
    const handle = startAutoArchive({
      registry,
      config: config({ intervalHours: 12 }),
      logger: quiet,
      timers: t.timers,
      startDelayMs: 1000,
    });
    expect(handle).not.toBeNull();
    expect(t.timeouts.map((x) => x.ms)).toEqual([1000]);
    t.timeouts[0].fn();
    await Promise.resolve();
    expect(calls.length).toBe(2);
    expect(t.intervals.map((x) => x.ms)).toEqual([12 * 3_600_000]);
    handle?.stop();
    expect(t.cleared).toBeGreaterThan(0);
  });
});

describe('runAutoArchive → onArchived', () => {
  function archivedRun(botId: string, files: string[]): HygieneRun {
    const r = run(botId, 0);
    r.findings = files.map((file) => ({
      id: `productions-triage:unreviewed-stale:${file}`,
      kind: 'unreviewed-stale',
      severity: 'info',
      file,
      line: null,
      message: 'm',
      fixable: true,
    })) as never;
    r.applied = files.map((file) => ({
      findingId: `productions-triage:unreviewed-stale:${file}`,
      action: 'archive',
      result: `${file} → archived/`,
    }));
    // A non-archive fix in the same run is not an ignored output.
    r.applied.push({
      findingId: 'productions-triage:orphan-reference:x',
      action: 'prune-changelog',
      result: 'x',
    });
    return r;
  }

  it('hands each bot its archived files, once, and skips bots with none', async () => {
    const { registry } = fakeRegistry({ a: archivedRun('a', ['01_x.md', '02_y.ts']) });
    const seen: Array<[string, string[]]> = [];
    await runAutoArchive({
      registry,
      config: config(),
      logger: quiet,
      onArchived: (botId, files) => {
        seen.push([botId, files]);
      },
    });
    expect(seen).toEqual([['a', ['01_x.md', '02_y.ts']]]);
  });

  it('a throwing onArchived never stops the pass', async () => {
    const { registry, calls } = fakeRegistry({
      a: archivedRun('a', ['01_x.md']),
      b: archivedRun('b', ['02_y.md']),
    });
    const summary = await runAutoArchive({
      registry,
      config: config(),
      logger: quiet,
      onArchived: () => {
        throw new Error('nope');
      },
    });
    expect(calls.map((c) => c.botId)).toEqual(['a', 'b']);
    expect(summary.archived).toBe(2);
    expect(summary.failed).toEqual([]);
  });
});
