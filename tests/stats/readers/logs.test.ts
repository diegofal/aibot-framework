import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { normaliseLogTemplate, scanLogs } from '../../../src/stats/readers/logs';
import { createTempDir, removeTempDir } from '../../helpers/temp-dir';

const NOW = Date.UTC(2026, 7, 21, 12);
const H = 3_600_000;

let dir: string;
beforeEach(() => {
  dir = createTempDir('stats-logs');
});
afterEach(() => removeTempDir(dir));

function line(over: Record<string, unknown>) {
  return JSON.stringify({ level: 30, time: NOW - H, pid: 1, hostname: 'h', ...over });
}

function writeLog(lines: string[]) {
  const p = join(dir, 'aibot.log');
  writeFileSync(p, `${lines.join('\n')}\n`);
  return p;
}

describe('scanLogs', () => {
  it('returns empty signals for a missing file', () => {
    const s = scanLogs(join(dir, 'none.log'), { maxBytes: 1000, sinceMs: 0, nowMs: NOW });
    expect(s.scannedLines).toBe(0);
    expect(s.boots).toEqual([]);
    expect(s.cyclesByBot).toEqual({});
    expect(s.logNoise).toEqual([]);
  });

  it('extracts cycles, alignment warnings, loop breaks, telegram, security, boots, collab and backends', () => {
    const p = writeLog([
      line({ msg: 'Starting AIBot Framework v1.0.0', time: NOW - 5 * H }),
      line({ msg: 'Starting AIBot Framework v1.0.0', time: NOW - 2 * H }),
      line({
        botId: 'b1',
        durationMs: 4000,
        priority: 'high',
        isIdle: false,
        msg: 'Agent loop completed for bot',
      }),
      line({
        botId: 'b1',
        durationMs: 2000,
        priority: 'none',
        isIdle: true,
        msg: 'Agent loop completed for bot',
      }),
      line({ botId: 'b2', durationMs: 1000, isIdle: false, msg: 'Agent loop completed for bot' }),
      line({
        level: 40,
        botId: 'b1',
        warnings: ['a', 'b'],
        msg: 'Agent loop: post-execution alignment check found issues',
      }),
      line({
        level: 40,
        botId: 'b1',
        round: 3,
        detector: 'repeat',
        msg: 'Tool loop detector: breaking',
      }),
      line({
        level: 40,
        botId: 'b2',
        err: { message: '401: Unauthorized' },
        msg: 'Telegram start failed — falling back to headless mode. Token rejected (401 Unauthorized).',
      }),
      line({
        level: 40,
        botId: 'b1',
        summary: { critical: 1, warn: 2, info: 3 },
        msg: 'Security audit: CRITICAL issues found',
      }),
      line({ level: 30, botId: 'b2', msg: 'Security audit: clean' }),
      line({
        level: 50,
        sourceBotId: 'b1',
        targetBotId: 'b2',
        msg: 'visible collaborate send failed',
      }),
      line({
        level: 40,
        model: 'qwen',
        err: { message: 'HTTP 429 Too Many Requests' },
        msg: 'Primary model failed, trying fallbacks',
      }),
      line({
        level: 40,
        backend: 'claude-cli',
        err: { message: 'exit 1: Invalid API key (401)' },
        msg: 'Claude CLI call failed',
      }),
      line({ msg: 'Agent loop completed for bot', botId: 'old', time: NOW - 48 * H }),
    ]);
    const s = scanLogs(p, { maxBytes: 1_000_000, sinceMs: NOW - 24 * H, nowMs: NOW });

    expect(s.scannedLines).toBe(14);
    expect(s.boots).toEqual([
      new Date(NOW - 5 * H).toISOString(),
      new Date(NOW - 2 * H).toISOString(),
    ]);
    expect(s.cyclesByBot.b1).toEqual({
      total: 2,
      idle: 1,
      durationSumMs: 6000,
      alignmentWarnings: 2,
      loopBreaks: 1,
      lastAt: NOW - H,
    });
    expect(s.cyclesByBot.b2.total).toBe(1);
    expect(s.cyclesByBot.old).toBeUndefined();
    expect(s.telegramByBot.b2).toMatchObject({ revoked: true });
    expect(s.telegramByBot.b2.lastError).toContain('401');
    expect(s.securityAudit).toEqual([
      { botId: 'b1', critical: 1, warn: 2, info: 3, at: new Date(NOW - H).toISOString() },
      { botId: 'b2', critical: 0, warn: 0, info: 0, at: new Date(NOW - H).toISOString() },
    ]);
    expect(s.collaborateFailed).toEqual([{ from: 'b1', to: 'b2' }]);
    expect(s.backends.ollama).toMatchObject({
      last429At: new Date(NOW - H).toISOString(),
      last401At: null,
    });
    expect(s.backends['claude-cli']).toMatchObject({ last401At: new Date(NOW - H).toISOString() });
    expect(s.backends['claude-cli'].lastErrorMessage).toContain('Invalid API key');
    expect(s.fallbacks).toBe(1);
    expect(s.logNoise[0]).toEqual({ msg: 'Agent loop completed for bot', level: 30, count: 3 });
  });

  it('keeps only the last 20 boots', () => {
    const p = writeLog(
      Array.from({ length: 25 }, (_, i) =>
        line({ msg: 'Starting AIBot Framework', time: NOW - (30 - i) * 60_000 })
      )
    );
    const s = scanLogs(p, { maxBytes: 1_000_000, sinceMs: 0, nowMs: NOW });
    expect(s.boots).toHaveLength(20);
    expect(s.boots[19]).toBe(new Date(NOW - 6 * 60_000).toISOString());
  });

  it('honours maxBytes by reading only the tail', () => {
    const lines = Array.from({ length: 200 }, (_, i) => line({ msg: `m${i}`, time: NOW - 60_000 }));
    const p = writeLog(lines);
    const s = scanLogs(p, { maxBytes: 500, sinceMs: 0, nowMs: NOW });
    expect(s.scannedLines).toBeLessThan(10);
    expect(s.scannedLines).toBeGreaterThan(0);
  });
});

describe('normaliseLogTemplate', () => {
  it('collapses numbers and ids', () => {
    expect(normaliseLogTemplate('Bot 12 took 345ms')).toBe('Bot N took Nms');
    expect(normaliseLogTemplate('id 3f2a9c8e-1111-2222-3333-444455556666 done')).toBe('id H done');
  });
});
