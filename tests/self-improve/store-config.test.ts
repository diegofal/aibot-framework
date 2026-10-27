import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SELF_IMPROVE_DEFAULTS, resolveSelfImprove } from '../../src/bot/self-improve/config';
import { LessonStore, pruneLessons } from '../../src/bot/self-improve/store';
import type { Lesson } from '../../src/bot/self-improve/types';
import { auditRowRef, isLessonInPrompt } from '../../src/bot/self-improve/types';
import {
  BotAgentLoopOverrideSchema,
  GlobalAgentLoopConfigSchema,
  WatcherConfigSchema,
} from '../../src/config';
import { checkTunableChange } from '../../src/watcher/autonomy/locked';

function lesson(over: Partial<Lesson> = {}): Lesson {
  return {
    id: 'l-00000001',
    classKey: 'file_read:file-not-found',
    tool: 'file_read',
    errorClass: 'file-not-found',
    text: 'Get the exact path from read_production_log before file_read.',
    textSource: 'fallback',
    evidence: [],
    source: 'own',
    status: 'active',
    createdAt: '2026-10-27T10:00:00.000Z',
    updatedAt: '2026-10-27T10:00:00.000Z',
    baseline: { failures: 4, calls: 10, rate: 0.4, sinceMs: 0, untilMs: 1 },
    ...over,
  };
}

describe('LessonStore', () => {
  test('missing or unreadable file reads as empty, never throws', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lessons-'));
    const store = new LessonStore(dir);
    expect(store.read()).toEqual({ version: 1, lessons: [], suppressed: [] });
    writeFileSync(store.path, '{not json');
    expect(store.read().lessons).toEqual([]);
  });

  test('round-trips and drops malformed lessons', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lessons-'));
    const store = new LessonStore(dir);
    store.write({ version: 1, lessons: [lesson()], suppressed: [] });
    writeFileSync(
      store.path,
      JSON.stringify({ version: 1, lessons: [lesson(), { id: 'bad' }], suppressed: [] })
    );
    expect(store.read().lessons.map((l) => l.id)).toEqual(['l-00000001']);
  });

  test('inPrompt: active and proven, newest first, capped', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lessons-'));
    const store = new LessonStore(dir);
    store.write({
      version: 1,
      suppressed: [],
      lessons: [
        lesson({ id: 'l-a', createdAt: '2026-10-01T00:00:00Z' }),
        lesson({ id: 'l-b', status: 'proven', createdAt: '2026-10-03T00:00:00Z' }),
        lesson({ id: 'l-c', status: 'retired', createdAt: '2026-10-04T00:00:00Z' }),
        lesson({ id: 'l-d', createdAt: '2026-10-02T00:00:00Z' }),
      ],
    });
    expect(store.inPrompt(2).map((l) => l.id)).toEqual(['l-b', 'l-d']);
  });

  test('pruneLessons keeps every in-prompt lesson and the newest finished ones', () => {
    const live = lesson({ id: 'l-live' });
    const old = lesson({ id: 'l-old', status: 'retired', updatedAt: '2026-01-01T00:00:00Z' });
    const recent = lesson({ id: 'l-new', status: 'retired', updatedAt: '2026-10-01T00:00:00Z' });
    expect(pruneLessons([live, old, recent], 2).map((l) => l.id)).toEqual(['l-live', 'l-new']);
  });
});

describe('contract helpers', () => {
  test('auditRowRef and isLessonInPrompt', () => {
    expect(auditRowRef({ timestamp: '2026-10-27T10:00:00.000Z', toolName: 'file_read' })).toBe(
      '2026-10-27T10:00:00.000Z|file_read'
    );
    expect(isLessonInPrompt({ status: 'unproven' })).toBe(false);
  });
});

describe('self-improve config', () => {
  test('bots off by default, watcher loop on by default', () => {
    const global = GlobalAgentLoopConfigSchema.parse({}).selfImprove;
    expect(resolveSelfImprove({ agentLoop: { selfImprove: global } } as never, undefined)).toEqual(
      SELF_IMPROVE_DEFAULTS
    );
    expect(WatcherConfigSchema.parse({}).selfImprove).toEqual({
      enabled: true,
      toolProblemBots: 3,
      everyHours: 24,
    });
  });

  test('a bot field wins over the global default', () => {
    const r = resolveSelfImprove(
      { agentLoop: { selfImprove: { enabled: false, minRepeats: 4 } } } as never,
      { agentLoop: { selfImprove: { enabled: true } } } as never
    );
    expect(r.enabled).toBe(true);
    expect(r.minRepeats).toBe(4);
  });

  test('the bot override validates in BotAgentLoopOverrideSchema', () => {
    const parsed = BotAgentLoopOverrideSchema.parse({ selfImprove: { enabled: true } });
    expect(parsed?.selfImprove).toEqual({ enabled: true });
    expect(() => BotAgentLoopOverrideSchema.parse({ selfImprove: { minRepeats: 1 } })).toThrow();
  });

  test('neither switch is proposable by the watcher', () => {
    const ctx = { config: { bots: [{ id: 'jarvis-factory' }] } };
    expect(checkTunableChange({ path: 'watcher.selfImprove.enabled', to: true }, ctx).ok).toBe(
      false
    );
    expect(
      checkTunableChange(
        { path: 'bots.jarvis-factory.agentLoop.selfImprove.enabled', to: true },
        ctx
      ).ok
    ).toBe(false);
  });
});
