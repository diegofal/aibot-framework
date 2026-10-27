import { describe, expect, test } from 'bun:test';
import { classifyFailure } from '../../src/bot/self-improve/classes';
import {
  MIN_MEASURE_CALLS,
  baselineFor,
  evaluateLesson,
  rateWindow,
} from '../../src/bot/self-improve/measure';
import type { FailureClass, Lesson, ResolvedSelfImprove } from '../../src/bot/self-improve/types';
import { BASELINE_DAYS } from '../../src/bot/self-improve/types';
import type { ToolAuditEntry } from '../../src/bot/tool-audit-log';

const DAY = 86_400_000;
const CREATED = Date.parse('2026-10-20T00:00:00.000Z');
const NOT_FOUND = 'File not found: /app/productions/scout/x.md';
const CLS = classifyFailure({
  toolName: 'file_read',
  result: NOT_FOUND,
  success: false,
}) as FailureClass;

const CFG: ResolvedSelfImprove = {
  enabled: true,
  minRepeats: 3,
  maxActive: 5,
  measureCalls: 20,
  measureDays: 5,
  minDrop: 0.5,
};

function at(ms: number, over: Partial<ToolAuditEntry> = {}): ToolAuditEntry {
  return {
    timestamp: new Date(ms).toISOString(),
    botId: 'scout',
    chatId: 0,
    toolName: 'file_read',
    args: {},
    success: false,
    result: NOT_FOUND,
    durationMs: 1,
    retryAttempts: 0,
    ...over,
  };
}
const okAt = (ms: number, over: Partial<ToolAuditEntry> = {}) =>
  at(ms, { success: true, result: '# x', ...over });

/** `failures` failing then `successes` succeeding calls, one minute apart from `startMs`. */
function calls(startMs: number, failures: number, successes: number): ToolAuditEntry[] {
  const out: ToolAuditEntry[] = [];
  for (let i = 0; i < failures + successes; i++) {
    out.push(i < failures ? at(startMs + i * 60_000) : okAt(startMs + i * 60_000));
  }
  return out;
}

const FIRST_WINDOW = {
  failures: 1,
  calls: 3,
  rate: 1 / 3,
  sinceMs: CREATED,
  untilMs: CREATED + 5 * DAY,
};
const ZERO_BASELINE = {
  failures: 0,
  calls: 10,
  rate: 0,
  sinceMs: CREATED - 7 * DAY,
  untilMs: CREATED,
};

function lesson(over: Partial<Lesson> = {}): Lesson {
  return {
    id: 'l-00000001',
    classKey: CLS.key,
    tool: CLS.tool,
    errorClass: CLS.errorClass,
    text: 'Get the exact path from read_production_log before file_read.',
    textSource: 'fallback',
    evidence: [],
    source: 'own',
    status: 'active',
    createdAt: new Date(CREATED).toISOString(),
    updatedAt: new Date(CREATED).toISOString(),
    baseline: { failures: 4, calls: 10, rate: 0.4, sinceMs: CREATED - 7 * DAY, untilMs: CREATED },
    ...over,
  };
}

describe('rateWindow', () => {
  test('counts the class failures over the tool calls in [since, until)', () => {
    const entries = [
      at(CREATED),
      at(CREATED + 1),
      okAt(CREATED + 2),
      okAt(CREATED + 3),
      at(CREATED + 4, { result: 'Failed to read file: Directories cannot be read like files' }),
      okAt(CREATED + 5, { toolName: 'web_fetch' }),
      at(CREATED + 10),
    ];
    expect(rateWindow(entries, CLS, CREATED, CREATED + 10)).toEqual({
      failures: 2,
      calls: 5,
      rate: 0.4,
      sinceMs: CREATED,
      untilMs: CREATED + 10,
    });
  });

  test('calls that never counted as failures are left out of both sides', () => {
    const entries = [
      at(CREATED),
      okAt(CREATED + 1),
      at(CREATED + 2, { failureKind: 'aborted' }),
      at(CREATED + 3, { failureKind: 'blocked' }),
    ];
    const w = rateWindow(entries, CLS, CREATED, CREATED + 10);
    expect([w.failures, w.calls]).toEqual([1, 2]);
  });

  test('no calls is a rate of 0', () => {
    expect(rateWindow([], CLS, CREATED, CREATED + 10).rate).toBe(0);
  });
});

describe('baselineFor', () => {
  test('covers the BASELINE_DAYS before now', () => {
    const now = CREATED;
    const entries = [
      at(now - BASELINE_DAYS * DAY - 1),
      at(now - BASELINE_DAYS * DAY),
      okAt(now - 1),
      at(now),
    ];
    expect(baselineFor(entries, CLS, now)).toEqual({
      failures: 1,
      calls: 2,
      rate: 0.5,
      sinceMs: now - BASELINE_DAYS * DAY,
      untilMs: now,
    });
  });
});

describe('evaluateLesson', () => {
  test('a lesson that is not active is not evaluated', () => {
    const entries = calls(CREATED, 0, 30);
    expect(evaluateLesson(lesson({ status: 'proven' }), entries, CFG, CREATED + DAY)).toBeNull();
  });

  test('an open window is not evaluated', () => {
    expect(evaluateLesson(lesson(), calls(CREATED, 0, 10), CFG, CREATED + DAY)).toBeNull();
  });

  test('the window closes at measureCalls calls: a big drop is proven', () => {
    const entries = [...calls(CREATED - DAY, 5, 0), ...calls(CREATED, 1, 21)];
    const r = evaluateLesson(lesson(), entries, CFG, CREATED + DAY);
    expect(r?.status).toBe('proven');
    expect(r?.statusReason).toBe('failure rate 40% → 5% over 22 calls');
    expect(r?.measure).toEqual({
      failures: 1,
      calls: 22,
      rate: 1 / 22,
      sinceMs: CREATED,
      untilMs: CREATED + DAY,
    });
    expect(r?.extended).toBe(false);
  });

  test('the window closes at measureDays: a small drop is retired', () => {
    const r = evaluateLesson(lesson(), calls(CREATED, 3, 7), CFG, CREATED + 5 * DAY);
    expect(r?.status).toBe('retired');
    expect(r?.statusReason).toBe('failure rate 40% → 30% over 10 calls, did not drop by 50%');
  });

  test('a drop of exactly minDrop is proven', () => {
    const r = evaluateLesson(lesson(), calls(CREATED, 2, 8), CFG, CREATED + 5 * DAY);
    expect(r?.status).toBe('proven');
  });

  test('too few calls opens a second window', () => {
    const r = evaluateLesson(lesson(), calls(CREATED, 1, 2), CFG, CREATED + 5 * DAY);
    expect(r?.status).toBe('active');
    expect(r?.extended).toBe(true);
    expect(r?.measure.untilMs).toBe(CREATED + 5 * DAY);
    expect(r?.statusReason).toBe('too few calls to tell (3); measuring once more');
  });

  test('the second window starts where the first ended', () => {
    const l = lesson({ extended: true, measure: FIRST_WINDOW });
    // Calls inside the first window never close the second one.
    expect(evaluateLesson(l, calls(CREATED, 0, 20), CFG, CREATED + 6 * DAY)).toBeNull();
    const entries = [...calls(CREATED, 0, 20), ...calls(CREATED + 5 * DAY, 0, 20)];
    const r = evaluateLesson(l, entries, CFG, CREATED + 6 * DAY);
    expect(r?.measure.sinceMs).toBe(CREATED + 5 * DAY);
    expect(r?.measure.calls).toBe(20);
    expect(r?.status).toBe('proven');
    expect(r?.extended).toBe(true);
  });

  test('too few calls after two windows is unproven', () => {
    const r = evaluateLesson(
      lesson({ extended: true, measure: FIRST_WINDOW }),
      calls(CREATED + 5 * DAY, 0, MIN_MEASURE_CALLS - 1),
      CFG,
      CREATED + 10 * DAY
    );
    expect(r?.status).toBe('unproven');
    expect(r?.statusReason).toBe('too few calls to tell after two windows (4)');
  });

  test('a baseline of 0 is proven when the class does not appear', () => {
    const r = evaluateLesson(
      lesson({ baseline: ZERO_BASELINE }),
      calls(CREATED, 0, 20),
      CFG,
      CREATED + DAY
    );
    expect(r?.status).toBe('proven');
  });

  test('a baseline of 0 is retired when the class appears', () => {
    const r = evaluateLesson(
      lesson({ baseline: ZERO_BASELINE }),
      calls(CREATED, 1, 19),
      CFG,
      CREATED + DAY
    );
    expect(r?.status).toBe('retired');
    expect(r?.statusReason).toBe('failure rate 0% → 5% over 20 calls, did not drop by 50%');
  });

  test('an unparseable createdAt is not evaluated', () => {
    expect(
      evaluateLesson(lesson({ createdAt: 'yesterday' }), calls(CREATED, 0, 30), CFG, CREATED + DAY)
    ).toBeNull();
  });
});
