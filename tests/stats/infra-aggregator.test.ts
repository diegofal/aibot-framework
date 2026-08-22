import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { createStatsContext } from '../../src/stats/context';
import { buildInfra } from '../../src/stats/infra-aggregator';
import { removeTempDir } from '../helpers/temp-dir';
import { type StatsFixture, createStatsFixture } from './fixture';

let fx: StatsFixture;
beforeEach(() => {
  fx = createStatsFixture();
});
afterEach(() => removeTempDir(fx.dir));

describe('buildInfra', () => {
  it('reports backends, security audits, cron, telegram, noise, boots and log size', () => {
    const ctx = createStatsContext({ config: fx.config, now: () => fx.now });
    const i = buildInfra(ctx, [fx.bots.b1, fx.bots.b2, fx.bots.b3]);

    expect(i.generatedAt).toBe(new Date(fx.now).toISOString());

    const ollama = i.backends.find((b) => b.name === 'ollama');
    expect(ollama?.last429At).not.toBeNull();
    expect(ollama?.last401At).toBeNull();
    expect(ollama?.failedCalls24h).toBe(1);
    expect(ollama?.lastErrorMessage).toContain('429');
    const claude = i.backends.find((b) => b.name === 'claude-cli');
    expect(claude).toEqual({
      name: 'claude-cli',
      last429At: null,
      last401At: null,
      lastErrorMessage: null,
      failedCalls24h: 0,
      circuit: null,
    });

    expect(i.securityAudit).toEqual([
      {
        botId: 'b1',
        critical: 1,
        warn: 0,
        info: 2,
        at: new Date(fx.now - 3_600_000).toISOString(),
      },
    ]);

    expect(i.cron).toHaveLength(1);
    expect(i.cron[0]).toMatchObject({
      id: 'j1',
      botId: 'b1',
      schedule: 'cron 0 9 * * *',
      lastStatus: 'ok',
    });

    expect(i.telegram).toEqual([
      { botId: 'b1', state: 'configured', lastError: null },
      { botId: 'b2', state: 'missing', lastError: null },
      { botId: 'b3', state: 'revoked', lastError: expect.stringContaining('401') },
    ]);

    expect(i.logNoise[0]).toEqual({ msg: 'Agent loop completed for bot', level: 30, count: 2 });
    expect(i.boots).toEqual([new Date(fx.now - 10 * 3_600_000).toISOString()]);
    expect(i.logBytes).toBeGreaterThan(0);
  });

  it('filters per-bot rows to the scoped bots and keeps unscoped cron jobs out for tenants', () => {
    const ctx = createStatsContext({ config: fx.config, now: () => fx.now });
    const i = buildInfra(ctx, [fx.bots.b3]);
    expect(i.securityAudit).toEqual([]);
    expect(i.telegram.map((t) => t.botId)).toEqual(['b3']);
    expect(i.cron).toEqual([]);
    expect(i.backends.find((b) => b.name === 'ollama')?.failedCalls24h).toBe(0);
  });

  it('survives a missing log file and empty stores', () => {
    const ctx = createStatsContext({
      config: {
        ...fx.config,
        logging: { level: 'info', file: `${fx.dir}/nope/none.log` },
      } as never,
      now: () => fx.now,
    });
    const i = buildInfra(ctx, [fx.bots.b2]);
    expect(i.boots).toEqual([]);
    expect(i.logNoise).toEqual([]);
    expect(i.logBytes).toBe(0);
    expect(i.telegram).toEqual([{ botId: 'b2', state: 'missing', lastError: null }]);
  });

  it('prefers the channel status recorded by the bot manager over log heuristics', () => {
    const ctx = createStatsContext({
      config: fx.config,
      now: () => fx.now,
      botManager: {
        getChannelState: (botId: string) =>
          botId === 'b1'
            ? { kind: 'telegram', state: 'ok', lastError: null, checkedAt: null }
            : { kind: 'headless', state: 'revoked', lastError: 'recorded 401', checkedAt: null },
      },
    });
    const i = buildInfra(ctx, [fx.bots.b1, fx.bots.b3]);
    expect(i.telegram).toEqual([
      { botId: 'b1', state: 'ok', lastError: null },
      { botId: 'b3', state: 'revoked', lastError: 'recorded 401' },
    ]);
  });

  it('attaches the agent-loop circuit breaker state to each backend', () => {
    const ctx = createStatsContext({
      config: fx.config,
      now: () => fx.now,
      botManager: {
        getAgentLoopCircuitState: () => ({
          ollama: {
            open: true,
            halfOpen: false,
            until: fx.now + 60_000,
            consecutiveFailures: 3,
            lastError: '429 weekly usage limit',
          },
        }),
      },
    });
    const i = buildInfra(ctx, [fx.bots.b1]);
    const ollama = i.backends.find((b) => b.name === 'ollama');
    expect(ollama?.circuit).toEqual({
      open: true,
      halfOpen: false,
      until: new Date(fx.now + 60_000).toISOString(),
      consecutiveFailures: 3,
      lastError: '429 weekly usage limit',
    });
    const claude = i.backends.find((b) => b.name === 'claude-cli');
    expect(claude?.circuit).toBeNull();
  });

  it('leaves circuit null when the bot manager does not expose it', () => {
    const ctx = createStatsContext({ config: fx.config, now: () => fx.now });
    const i = buildInfra(ctx, [fx.bots.b1]);
    expect(i.backends.every((b) => b.circuit === null)).toBe(true);
  });
});
