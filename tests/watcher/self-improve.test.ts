/**
 * The watcher's self-improvement loop (`docs/plans/self-improve-plan.md`,
 * "Watcher loop"): tool problems found across bots, suppressions kept in
 * the loop-on bots' LESSONS.json, proven lessons lent to loop-on bots.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LessonStore } from '../../src/bot/self-improve/store';
import type { Lesson } from '../../src/bot/self-improve/types';
import type { ToolAuditEntry } from '../../src/bot/tool-audit-log';
import {
  type FleetSelfImproveBot,
  type FleetSelfImproveDeps,
  readSelfImproveState,
  runFleetSelfImprove,
  selfImproveStateFile,
  writeSelfImproveState,
} from '../../src/watcher/self-improve';

const H = 3_600_000;
const D = 24 * H;
const NOW = Date.parse('2026-10-27T12:00:00Z');
let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'fleet-si-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function bot(id: string, loopOn = true): FleetSelfImproveBot {
  const soulDir = join(root, 'souls', id);
  mkdirSync(soulDir, { recursive: true });
  return { id, name: `Bot ${id}`, soulDir, loopOn };
}

let seq = 0;
function fail(tool: string, result: string, agoMs = H): ToolAuditEntry {
  seq++;
  return {
    timestamp: new Date(NOW - agoMs - seq).toISOString(),
    botId: 'x',
    chatId: 0,
    toolName: tool,
    args: {},
    success: false,
    result,
    durationMs: 1,
    retryAttempts: 0,
    cycleId: 'c-1',
  };
}
function ok(tool: string, agoMs = H): ToolAuditEntry {
  return { ...fail(tool, 'fine', agoMs), success: true };
}
const notFound = (n: number, agoMs = H) =>
  Array.from({ length: n }, () => fail('file_read', 'File not found: x.md', agoMs));

function lesson(over: Partial<Lesson> = {}): Lesson {
  return {
    id: 'l-aaaaaaaa',
    classKey: 'file_read:file-not-found',
    tool: 'file_read',
    errorClass: 'file-not-found',
    text: 'Check the productions dir before reading a bare filename.',
    textSource: 'model',
    evidence: [],
    source: 'own',
    status: 'proven',
    createdAt: new Date(NOW - 20 * D).toISOString(),
    updatedAt: new Date(NOW - 10 * D).toISOString(),
    baseline: { failures: 5, calls: 10, rate: 0.5, sinceMs: 0, untilMs: 1 },
    ...over,
  };
}

function deps(
  bots: FleetSelfImproveBot[],
  audit: Record<string, ToolAuditEntry[]>,
  over: Partial<FleetSelfImproveDeps> = {}
): FleetSelfImproveDeps & { rows: Array<{ op: string; text: string }> } {
  const rows: Array<{ op: string; text: string }> = [];
  return {
    bots,
    readAudit: (id) => audit[id] ?? [],
    cfg: { toolProblemBots: 3 },
    nowMs: NOW,
    storeFor: (dir) => new LessonStore(dir),
    log: (row) => rows.push(row),
    isDismissed: () => false,
    ...over,
    rows,
  };
}

const read = (b: FleetSelfImproveBot) => new LessonStore(b.soulDir).read();

describe('tool problems', () => {
  test('a named class present in exactly toolProblemBots bots is a tool problem', async () => {
    const bots = [bot('a'), bot('b'), bot('c')];
    const d = deps(bots, { a: notFound(4), b: notFound(2), c: notFound(3) });
    const r = await runFleetSelfImprove(d);
    expect(r.toolProblems).toEqual([
      {
        classKey: 'file_read:file-not-found',
        bots: [
          { id: 'a', failures: 4 },
          { id: 'c', failures: 3 },
          { id: 'b', failures: 2 },
        ],
      },
    ]);
    const tp = d.rows.filter((x) => x.op === 'self-improve:tool-problem');
    expect(tp).toHaveLength(1);
    expect(tp[0].text).toContain('file_read:file-not-found');
    expect(tp[0].text).toContain('3 bots');
  });

  test('one bot short of toolProblemBots, or one failure per bot, is not', async () => {
    const bots = [bot('a'), bot('b'), bot('c')];
    const r1 = await runFleetSelfImprove(deps(bots, { a: notFound(5), b: notFound(5) }));
    expect(r1.toolProblems).toEqual([]);
    const r2 = await runFleetSelfImprove(
      deps(bots, { a: notFound(5), b: notFound(5), c: notFound(1) })
    );
    expect(r2.toolProblems).toEqual([]);
  });

  test('an other:* class is never a tool problem', async () => {
    const bots = [bot('a'), bot('b'), bot('c')];
    const weird = () => [fail('exec', 'Something odd happened'), fail('exec', 'Something odd')];
    const r = await runFleetSelfImprove(deps(bots, { a: weird(), b: weird(), c: weird() }));
    expect(r.toolProblems).toEqual([]);
  });

  test('a dismissed class is not a tool problem', async () => {
    const bots = [bot('a'), bot('b'), bot('c')];
    const r = await runFleetSelfImprove(
      deps(
        bots,
        { a: notFound(3), b: notFound(3), c: notFound(3) },
        { isDismissed: (k) => k === 'file_read:file-not-found' }
      )
    );
    expect(r.toolProblems).toEqual([]);
  });

  test('the log row is written when the class is newly found, not on every run', async () => {
    const bots = [bot('a'), bot('b'), bot('c')];
    const audit = { a: notFound(3), b: notFound(3), c: notFound(3) };
    const d = deps(bots, audit, { previousToolProblems: ['file_read:file-not-found'] });
    const r = await runFleetSelfImprove(d);
    expect(r.toolProblems).toHaveLength(1);
    expect(d.rows.filter((x) => x.op === 'self-improve:tool-problem')).toHaveLength(0);
  });

  test('the suppression is written only into loop-on bots, idempotently', async () => {
    const bots = [bot('a'), bot('b', false), bot('c')];
    const audit = { a: notFound(3), b: notFound(3), c: notFound(3) };
    await runFleetSelfImprove(deps(bots, audit));
    const a = read(bots[0]);
    expect(a.suppressed).toHaveLength(1);
    expect(a.suppressed[0].classKey).toBe('file_read:file-not-found');
    expect(a.suppressed[0].bots).toEqual(['a', 'b', 'c']);
    expect(a.suppressed[0].reason).toContain('3 bots');
    expect(read(bots[2]).suppressed).toHaveLength(1);
    expect(existsSync(join(bots[1].soulDir, 'LESSONS.json'))).toBe(false);

    const before = readFileSync(join(bots[0].soulDir, 'LESSONS.json'), 'utf8');
    await runFleetSelfImprove(deps(bots, audit, { nowMs: NOW + H }));
    expect(readFileSync(join(bots[0].soulDir, 'LESSONS.json'), 'utf8')).toBe(before);
  });

  test('the suppression is removed when the class disappears or is dismissed', async () => {
    const bots = [bot('a'), bot('b'), bot('c')];
    await runFleetSelfImprove(deps(bots, { a: notFound(3), b: notFound(3), c: notFound(3) }));
    expect(read(bots[0]).suppressed).toHaveLength(1);
    // Gone from one bot: below the bar.
    await runFleetSelfImprove(deps(bots, { a: notFound(3), b: notFound(3) }));
    expect(read(bots[0]).suppressed).toEqual([]);
    // Back, then dismissed.
    await runFleetSelfImprove(deps(bots, { a: notFound(3), b: notFound(3), c: notFound(3) }));
    expect(read(bots[1]).suppressed).toHaveLength(1);
    await runFleetSelfImprove(
      deps(bots, { a: notFound(3), b: notFound(3), c: notFound(3) }, { isDismissed: () => true })
    );
    for (const b of bots) expect(read(b).suppressed).toEqual([]);
  });
});

describe('propagation', () => {
  function seed(b: FleetSelfImproveBot, lessons: Lesson[]) {
    new LessonStore(b.soulDir).write({ version: 1, lessons, suppressed: [] });
  }

  test('a proven own lesson is lent to a loop-on bot with the class present', async () => {
    const [x, y] = [bot('x'), bot('y')];
    seed(x, [lesson()]);
    const yAudit = [...notFound(2), ok('file_read'), ok('file_read')];
    const r = await runFleetSelfImprove(deps([x, y], { y: yAudit }));
    expect(r.borrowed).toHaveLength(1);
    const lent = read(y).lessons;
    expect(lent).toHaveLength(1);
    const l = lent[0];
    expect(l.id).toMatch(/^l-[0-9a-f]{8}$/);
    expect(l.id).toBe(r.borrowed[0].lessonId);
    expect(r.borrowed[0]).toMatchObject({
      toBot: 'y',
      fromBot: 'x',
      classKey: 'file_read:file-not-found',
    });
    expect(l).toMatchObject({
      classKey: 'file_read:file-not-found',
      tool: 'file_read',
      errorClass: 'file-not-found',
      text: lesson().text,
      textSource: 'model',
      source: 'borrowed',
      borrowedFrom: { botId: 'x', lessonId: 'l-aaaaaaaa' },
      status: 'active',
      createdAt: new Date(NOW).toISOString(),
      updatedAt: new Date(NOW).toISOString(),
    });
    expect(l.evidence).toHaveLength(2);
    expect(l.baseline.failures).toBe(2);
    expect(l.baseline.calls).toBe(4);
    // The soul event in y's soul dir.
    const events = readFileSync(join(y.soulDir, 'soul-events.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((s) => JSON.parse(s));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ op: 'lesson', actor: 'system', file: 'LESSONS.json' });
    expect(events[0].summary).toContain('Borrowed a lesson from Bot x');
    expect(r.perBot.y).toEqual({ active: 1, proven: 0, retired: 0, unproven: 0, borrowed: 1 });
    expect(r.perBot.x).toEqual({ active: 0, proven: 1, retired: 0, unproven: 0, borrowed: 0 });
  });

  test('evidence is the newest EVIDENCE_MAX failures of the class', async () => {
    const [x, y] = [bot('x'), bot('y')];
    seed(x, [lesson()]);
    const yAudit = Array.from({ length: 8 }, (_, i) =>
      fail('file_read', 'File not found: x', (i + 1) * H)
    );
    await runFleetSelfImprove(deps([x, y], { y: yAudit }));
    const ev = read(y).lessons[0].evidence;
    expect(ev).toHaveLength(5);
    expect(ev[0]).toBe(`${yAudit[0].timestamp}|file_read`);
  });

  test('never into a loop-off bot, nor one without the class present', async () => {
    const [x, off, thin] = [bot('x'), bot('off', false), bot('thin')];
    seed(x, [lesson()]);
    const r = await runFleetSelfImprove(
      deps([x, off, thin], { off: notFound(5), thin: notFound(1) })
    );
    expect(r.borrowed).toEqual([]);
    expect(existsSync(join(off.soulDir, 'LESSONS.json'))).toBe(false);
    expect(read(thin).lessons).toEqual([]);
  });

  test('never from a lesson that is not proven, or was itself borrowed', async () => {
    const [x, y] = [bot('x'), bot('y')];
    seed(x, [
      lesson({ id: 'l-11111111', status: 'active' }),
      lesson({ id: 'l-22222222', status: 'retired' }),
      lesson({
        id: 'l-33333333',
        source: 'borrowed',
        borrowedFrom: { botId: 'z', lessonId: 'l-0' },
      }),
    ]);
    const r = await runFleetSelfImprove(deps([x, y], { y: notFound(3) }));
    expect(r.borrowed).toEqual([]);
  });

  test('never twice in 7 days, never over a lesson in the prompt', async () => {
    const [x, y] = [bot('x'), bot('y')];
    seed(x, [lesson()]);
    await runFleetSelfImprove(deps([x, y], { y: notFound(3) }));
    expect(read(y).lessons).toHaveLength(1);
    // Next day: the borrowed one is still in y's file (created < 7 d).
    await runFleetSelfImprove(deps([x, y], { y: notFound(3) }, { nowMs: NOW + D }));
    expect(read(y).lessons).toHaveLength(1);
    // A retired lesson of the class created 3 days ago blocks too.
    const z = bot('z');
    seed(z, [
      lesson({
        id: 'l-44444444',
        status: 'retired',
        source: 'own',
        createdAt: new Date(NOW - 3 * D).toISOString(),
      }),
    ]);
    const r = await runFleetSelfImprove(deps([x, z], { z: notFound(3) }));
    expect(r.borrowed).toEqual([]);
    // An old proven own lesson of the class (in the prompt) blocks as well.
    const w = bot('w');
    seed(w, [lesson({ id: 'l-55555555', status: 'proven' })]);
    const r2 = await runFleetSelfImprove(deps([x, w], { w: notFound(3) }));
    expect(r2.borrowed).toEqual([]);
  });

  test('one borrow per bot and class per run, even with two lenders', async () => {
    const [x1, x2, y] = [bot('x1'), bot('x2'), bot('y')];
    seed(x1, [lesson({ id: 'l-11111111' })]);
    seed(x2, [lesson({ id: 'l-22222222' })]);
    const r = await runFleetSelfImprove(deps([x1, x2, y], { y: notFound(3) }));
    expect(r.borrowed.filter((b) => b.toBot === 'y')).toHaveLength(1);
    expect(read(y).lessons).toHaveLength(1);
  });

  test('never into a bot whose failures of the class are all outside its cycles', async () => {
    // Conversation calls (no cycleId) never see a lesson: the class is not
    // present for borrowing, and a borrowed lesson would start from 0.
    const [x, y] = [bot('x'), bot('y')];
    seed(x, [lesson()]);
    const conversationOnly = notFound(4).map((e) => ({ ...e, cycleId: undefined }));
    const r = await runFleetSelfImprove(deps([x, y], { y: conversationOnly }));
    expect(r.borrowed).toEqual([]);
    expect(read(y).lessons).toEqual([]);
  });

  test('never into a bot whose prompt is already at its maxActive', async () => {
    const [x, y] = [bot('x'), { ...bot('y'), maxActive: 1 }];
    seed(x, [lesson()]);
    seed(y, [
      lesson({ id: 'l-bbbbbbbb', classKey: 'manage_goals:note-too-long', status: 'active' }),
    ]);
    const r = await runFleetSelfImprove(deps([x, y], { y: notFound(3) }));
    expect(r.borrowed).toEqual([]);
    expect(read(y).lessons.map((l) => l.id)).toEqual(['l-bbbbbbbb']);
  });

  test('never for a class suppressed in the borrower', async () => {
    const [x, y, b, c] = [bot('x'), bot('y'), bot('b'), bot('c')];
    seed(x, [lesson()]);
    const r = await runFleetSelfImprove(
      deps([x, y, b, c], { y: notFound(3), b: notFound(3), c: notFound(3) })
    );
    expect(r.toolProblems).toHaveLength(1);
    expect(r.borrowed).toEqual([]);
    expect(read(y).lessons).toEqual([]);
  });
});

describe('failures never throw', () => {
  test('a throwing readAudit or store leaves a logged error and the rest of the run', async () => {
    const [x, broken, y] = [bot('x'), bot('broken'), bot('y')];
    new LessonStore(x.soulDir).write({ version: 1, lessons: [lesson()], suppressed: [] });
    const d = deps(
      [x, broken, y],
      { y: notFound(3) },
      {
        readAudit: (id) => {
          if (id === 'broken') throw new Error('disk gone');
          return id === 'y' ? notFound(3) : [];
        },
      }
    );
    const r = await runFleetSelfImprove(d);
    expect(r.borrowed).toHaveLength(1);
    expect(d.rows.some((x) => x.op === 'self-improve:error' && x.text.includes('broken'))).toBe(
      true
    );

    const d2 = deps(
      [x, y],
      { y: notFound(3) },
      {
        storeFor: () => {
          throw new Error('no store');
        },
      }
    );
    const r2 = await runFleetSelfImprove(d2);
    expect(r2.borrowed).toEqual([]);
    expect(d2.rows.some((x) => x.op === 'self-improve:error')).toBe(true);
  });

  test('a store whose write throws is logged and the run ends', async () => {
    const [x, y] = [bot('x'), bot('y')];
    new LessonStore(x.soulDir).write({ version: 1, lessons: [lesson()], suppressed: [] });
    const d = deps(
      [x, y],
      { y: notFound(3) },
      {
        storeFor: (dir) => {
          const s = new LessonStore(dir);
          return {
            read: () => s.read(),
            write: () => {
              throw new Error('read-only');
            },
          };
        },
      }
    );
    const r = await runFleetSelfImprove(d);
    expect(r.borrowed).toEqual([]);
    expect(d.rows.some((x) => x.op === 'self-improve:error')).toBe(true);
  });
});

describe('the state file', () => {
  test('round-trips; a missing or broken file reads as empty', () => {
    const dir = join(root, 'watcher');
    expect(readSelfImproveState(dir)).toEqual({ dismissed: [] });
    const last = {
      ranAt: new Date(NOW).toISOString(),
      toolProblems: [],
      borrowed: [],
      perBot: {},
    };
    writeSelfImproveState(dir, { dismissed: ['a:b'], last });
    expect(readSelfImproveState(dir)).toEqual({ dismissed: ['a:b'], last });
    mkdirSync(dir, { recursive: true });
    writeFileSync(selfImproveStateFile(dir), '{nope');
    expect(readSelfImproveState(dir)).toEqual({ dismissed: [] });
  });
});

describe('SelfImproveRunner.tick', () => {
  test('never ran: due at the tick even when the clock moves during the check', async () => {
    const { SelfImproveRunner } = await import('../../src/watcher/self-improve');
    let clock = NOW;
    const runner = new SelfImproveRunner({
      watcherDir: join(root, 'watcher'),
      settings: () => ({ enabled: true, toolProblemBots: 3, everyHours: 24 }),
      bots: () => [],
      readAudit: () => [],
      storeFor: (dir) => new LessonStore(dir),
      log: () => {},
      running: () => true,
      killed: () => false,
      // Every read of the clock is 5 ms later than the last.
      now: () => {
        clock += 5;
        return clock;
      },
    });
    expect(runner.tick(NOW)).toBe(true);
    await runner.current();
  });
});

describe('SelfImproveRunner: a dismissal during a run (review #10)', () => {
  test('stays dismissed: not in the saved result, no suppression left in the bots', async () => {
    const { SelfImproveRunner } = await import('../../src/watcher/self-improve');
    const bots = [bot('a'), bot('b'), bot('c')];
    const audit: Record<string, ToolAuditEntry[]> = {
      a: notFound(3),
      b: notFound(3),
      c: notFound(3),
    };
    let runner: InstanceType<typeof SelfImproveRunner>;
    let dismissedMidRun = false;
    runner = new SelfImproveRunner({
      watcherDir: join(root, 'watcher'),
      settings: () => ({ enabled: true, toolProblemBots: 3, everyHours: 24 }),
      bots: () => bots,
      // The operator dismisses while the run is reading the last bot.
      readAudit: (id) => {
        if (id === 'c' && !dismissedMidRun) {
          dismissedMidRun = true;
          runner.dismiss('file_read:file-not-found');
        }
        return audit[id] ?? [];
      },
      storeFor: (dir) => new LessonStore(dir),
      log: () => {},
      running: () => true,
      killed: () => false,
      now: () => NOW,
    });
    await runner.run();
    expect(dismissedMidRun).toBe(true);
    const status = runner.status();
    expect(status.dismissed).toContain('file_read:file-not-found');
    expect(status.last?.toolProblems ?? []).toEqual([]);
    for (const b of bots) expect(read(b).suppressed).toEqual([]);
  });
});
