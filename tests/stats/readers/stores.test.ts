/**
 * Tests for the small "one file per store" readers: outcomes, karma,
 * schedules, sessions, cron, mesh, productions.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readCronJobs } from '../../../src/stats/readers/cron';
import { readKarmaStats } from '../../../src/stats/readers/karma';
import { readMeshCounts } from '../../../src/stats/readers/mesh';
import { readOutcomeStats } from '../../../src/stats/readers/outcomes';
import { readProductionOutput } from '../../../src/stats/readers/productions';
import { readSchedules } from '../../../src/stats/readers/schedules';
import { lastSessionActivityAt } from '../../../src/stats/readers/sessions';
import { createTempDir, removeTempDir } from '../../helpers/temp-dir';

const NOW = Date.UTC(2026, 7, 21, 12);
const DAY = 86_400_000;

let dir: string;
beforeEach(() => {
  dir = createTempDir('stats-stores');
});
afterEach(() => removeTempDir(dir));

function jsonl(path: string, rows: unknown[]) {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`);
}

describe('readOutcomeStats', () => {
  it('zeros when missing', () => {
    expect(readOutcomeStats(dir, 'b1', 0)).toEqual({ produced: 0, stale: 0, lastAt: null });
  });
  it('counts every outcome in the window as produced, stale ones separately, lastAt across all', () => {
    jsonl(join(dir, 'b1', 'outcomes.jsonl'), [
      { id: '1', botId: 'b1', timestamp: NOW - DAY, status: 'produced' },
      { id: '2', botId: 'b1', timestamp: NOW - 2 * DAY, status: 'stale' },
      { id: '3', botId: 'b1', timestamp: NOW - 40 * DAY, status: 'produced' },
    ]);
    const s = readOutcomeStats(dir, 'b1', NOW - 7 * DAY);
    expect(s.produced).toBe(2);
    expect(s.stale).toBe(1);
    expect(s.lastAt).toBe(NOW - DAY);
  });
});

describe('readKarmaStats', () => {
  it('null score and zero delta when no events and no service', () => {
    expect(readKarmaStats(dir, 'b1', 0)).toEqual({ score: null, delta: 0, events: 0 });
  });
  it('sums deltas inside window; score from service when provided', () => {
    jsonl(join(dir, 'b1', 'events.jsonl'), [
      { id: 'a', botId: 'b1', timestamp: new Date(NOW - DAY).toISOString(), delta: 3 },
      { id: 'b', botId: 'b1', timestamp: new Date(NOW - 2 * DAY).toISOString(), delta: -1 },
      { id: 'c', botId: 'b1', timestamp: new Date(NOW - 60 * DAY).toISOString(), delta: 10 },
    ]);
    const noService = readKarmaStats(dir, 'b1', NOW - 7 * DAY);
    expect(noService).toEqual({ score: null, delta: 2, events: 2 });
    const withService = readKarmaStats(dir, 'b1', NOW - 7 * DAY, { getScore: () => 57 });
    expect(withService.score).toBe(57);
  });
});

describe('readSchedules', () => {
  it('empty object when missing or malformed', () => {
    expect(readSchedules(dir)).toEqual({});
    writeFileSync(join(dir, 'schedules.json'), '{oops');
    expect(readSchedules(dir)).toEqual({});
  });
  it('returns the per-bot map', () => {
    writeFileSync(
      join(dir, 'schedules.json'),
      JSON.stringify({ b1: { nextRunAt: 1, lastRunAt: 2, consecutiveIdleCycles: 3 } })
    );
    expect(readSchedules(dir).b1?.consecutiveIdleCycles).toBe(3);
  });
});

describe('lastSessionActivityAt', () => {
  it('null when sessions.json is missing or has no matching bot', () => {
    expect(lastSessionActivityAt(dir, 'b1')).toBeNull();
    writeFileSync(join(dir, 'sessions.json'), JSON.stringify({ 'bot:b2:private:1': {} }));
    expect(lastSessionActivityAt(dir, 'b1')).toBeNull();
  });
  it('returns the latest lastActivityAt among sessions with messages', () => {
    writeFileSync(
      join(dir, 'sessions.json'),
      JSON.stringify({
        'bot:b1:private:1': { lastActivityAt: '2026-08-01T00:00:00.000Z', messageCount: 4 },
        'bot:b1:group:2': { lastActivityAt: '2026-08-10T00:00:00.000Z', messageCount: 1 },
        'bot:b1:private:3': { lastActivityAt: '2026-08-20T00:00:00.000Z', messageCount: 0 },
      })
    );
    expect(lastSessionActivityAt(dir, 'b1')).toBe(Date.parse('2026-08-10T00:00:00.000Z'));
  });
});

describe('readCronJobs', () => {
  it('[] when missing', () => {
    expect(readCronJobs(dir)).toEqual([]);
  });
  it('flattens jobs with schedule description and state', () => {
    writeFileSync(
      join(dir, 'jobs.json'),
      JSON.stringify({
        version: 1,
        jobs: [
          {
            id: 'j1',
            name: 'digest',
            enabled: true,
            schedule: { kind: 'cron', expr: '0 9 * * *' },
            payload: { kind: 'instruction', text: 'x', chatId: 1, botId: 'b1' },
            state: {
              lastStatus: 'error',
              lastError: 'boom',
              lastRunAtMs: NOW - DAY,
              consecutiveErrors: 2,
            },
          },
          {
            id: 'j2',
            name: 'tick',
            enabled: false,
            schedule: { kind: 'every', everyMs: 60_000 },
            payload: { kind: 'skillJob', skillId: 's', jobId: 'j' },
            state: { consecutiveErrors: 0, nextRunAtMs: NOW + DAY },
          },
        ],
      })
    );
    const jobs = readCronJobs(dir);
    expect(jobs).toHaveLength(2);
    expect(jobs[0]).toMatchObject({
      id: 'j1',
      botId: 'b1',
      schedule: 'cron 0 9 * * *',
      lastStatus: 'error',
      lastError: 'boom',
      consecutiveErrors: 2,
    });
    expect(jobs[0].lastRunAt).toBe(new Date(NOW - DAY).toISOString());
    expect(jobs[1]).toMatchObject({
      botId: null,
      schedule: 'every 1m',
      lastStatus: null,
      enabled: false,
    });
    expect(jobs[1].nextRunAt).toBe(new Date(NOW + DAY).toISOString());
  });
});

describe('readMeshCounts', () => {
  it('zero when missing', () => {
    expect(readMeshCounts(join(dir, 'mesh.jsonl'), 0)).toEqual({ byBot: {}, total: 0 });
  });
  it('counts insights per source bot within the window', () => {
    jsonl(join(dir, 'mesh.jsonl'), [
      { id: '1', sourceBotId: 'b1', timestamp: NOW - DAY },
      { id: '2', sourceBotId: 'b1', timestamp: NOW - 2 * DAY },
      { id: '3', sourceBotId: 'b2', timestamp: NOW - 50 * DAY },
    ]);
    expect(readMeshCounts(join(dir, 'mesh.jsonl'), NOW - 7 * DAY)).toEqual({
      byBot: { b1: 2 },
      total: 2,
    });
  });
});

describe('readProductionOutput', () => {
  it('zeros for a missing workDir', () => {
    expect(readProductionOutput(join(dir, 'nowhere'))).toEqual({
      filesActive: 0,
      filesArchived: 0,
      approved: 0,
      rejected: 0,
      unreviewed: 0,
      lastFileAt: null,
    });
  });
  it('derives active/archived files and review counts from changelog.jsonl', () => {
    jsonl(join(dir, 'work', 'changelog.jsonl'), [
      {
        id: '1',
        timestamp: '2026-08-01T00:00:00.000Z',
        botId: 'b1',
        tool: 'file_write',
        path: 'a.md',
        action: 'create',
        size: 10,
        evaluation: { status: 'approved' },
      },
      {
        id: '2',
        timestamp: '2026-08-02T00:00:00.000Z',
        botId: 'b1',
        tool: 'file_write',
        path: 'a.md',
        action: 'edit',
        size: 12,
        evaluation: { status: 'rejected' },
      },
      {
        id: '3',
        timestamp: '2026-08-03T00:00:00.000Z',
        botId: 'b1',
        tool: 'file_write',
        path: 'b.md',
        action: 'create',
        size: 5,
      },
      {
        id: '4',
        timestamp: '2026-08-04T00:00:00.000Z',
        botId: 'b1',
        tool: 'archive',
        path: 'archived/b.md',
        action: 'archive',
        size: 5,
        archivedFrom: 'b.md',
      },
      {
        id: '5',
        timestamp: '2026-08-05T00:00:00.000Z',
        botId: 'b1',
        tool: 'file_write',
        path: 'c.md',
        action: 'create',
        size: 1,
      },
      {
        id: '6',
        timestamp: '2026-08-06T00:00:00.000Z',
        botId: 'b1',
        tool: 'file_delete',
        path: 'c.md',
        action: 'delete',
        size: 0,
      },
    ]);
    const s = readProductionOutput(join(dir, 'work'));
    expect(s.filesActive).toBe(1); // a.md
    expect(s.filesArchived).toBe(1); // b.md
    expect(s.approved).toBe(1);
    expect(s.rejected).toBe(1);
    expect(s.unreviewed).toBe(2); // b.md create + c.md create (content entries only)
    expect(s.lastFileAt).toBe('2026-08-05T00:00:00.000Z');
  });
});
