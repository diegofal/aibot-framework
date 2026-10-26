import { describe, expect, it } from 'bun:test';
import {
  BOT_CADENCE,
  LOCKED_EXAMPLES,
  TUNABLES,
  checkTunableChange,
  isTunablePath,
} from '../../../src/watcher/autonomy/locked';
import { testConfig } from './fixtures';

const ctx = { config: testConfig('/tmp/none') };

describe('locked: an allowlist of tunables', () => {
  it('lists exactly the rung-0 watcher tunables with bounded ranges', () => {
    expect(TUNABLES.map((t) => t.path).sort()).toEqual(
      [
        'watcher.notice.salienceBar',
        'watcher.notice.wakeSalience',
        'watcher.notice.maxWaitMs',
        'watcher.integrate.wakeSalience',
        'watcher.integrate.minItems',
        'watcher.integrate.agendaMax',
        'watcher.integrate.agendaFloorMs',
        'watcher.integrate.heartbeatMs',
        'watcher.fastLane.minBots',
        'watcher.forget.threshold',
      ].sort()
    );
    for (const t of TUNABLES) {
      expect(Number.isFinite(t.min)).toBe(true);
      expect(Number.isFinite(t.max)).toBe(true);
      expect(t.min).toBeLessThan(t.max);
    }
    expect(BOT_CADENCE.minMs).toBe(3_600_000);
    expect(BOT_CADENCE.maxMs).toBe(7 * 86_400_000);
  });

  it('no locked example is tunable', () => {
    expect(LOCKED_EXAMPLES.length).toBeGreaterThan(20);
    for (const path of LOCKED_EXAMPLES) {
      expect({ path, tunable: isTunablePath(path, ctx) }).toEqual({ path, tunable: false });
      const r = checkTunableChange({ path, to: 1 }, ctx);
      expect(r.ok).toBe(false);
    }
  });

  it('accepts an in-range value and refuses one out of range', () => {
    expect(checkTunableChange({ path: 'watcher.notice.salienceBar', to: 0.6 }, ctx).ok).toBe(true);
    expect(checkTunableChange({ path: 'watcher.notice.salienceBar', to: 2 }, ctx).ok).toBe(true);
    const high = checkTunableChange({ path: 'watcher.notice.salienceBar', to: 2.01 }, ctx);
    expect(high.ok).toBe(false);
    if (!high.ok) expect(high.note).toContain('0.1');
    expect(checkTunableChange({ path: 'watcher.forget.threshold', to: 0.01 }, ctx).ok).toBe(false);
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, '0.5', null, undefined, true]) {
      expect(checkTunableChange({ path: 'watcher.notice.salienceBar', to: bad }, ctx).ok).toBe(
        false
      );
    }
  });

  it('integers stay integers', () => {
    expect(checkTunableChange({ path: 'watcher.integrate.minItems', to: 6 }, ctx).ok).toBe(true);
    expect(checkTunableChange({ path: 'watcher.integrate.minItems', to: 6.5 }, ctx).ok).toBe(false);
    expect(checkTunableChange({ path: 'watcher.fastLane.minBots', to: 3 }, ctx).ok).toBe(true);
    expect(checkTunableChange({ path: 'watcher.notice.maxWaitMs', to: 600_000.5 }, ctx).ok).toBe(
      false
    );
  });

  it('a bot cadence is a duration string between 1h and 7d, for a live non-tenant bot', () => {
    const ok = checkTunableChange({ path: 'bots.b1.agentLoop.every', to: '6h' }, ctx);
    expect(ok).toEqual({ ok: true, family: 'fleet-cadence' });
    expect(checkTunableChange({ path: 'bots.b2.agentLoop.every', to: '7d' }, ctx).ok).toBe(true);
    expect(checkTunableChange({ path: 'bots.b1.agentLoop.every', to: '30m' }, ctx).ok).toBe(false);
    expect(checkTunableChange({ path: 'bots.b1.agentLoop.every', to: '8d' }, ctx).ok).toBe(false);
    expect(checkTunableChange({ path: 'bots.b1.agentLoop.every', to: 'soon' }, ctx).ok).toBe(false);
    expect(checkTunableChange({ path: 'bots.b1.agentLoop.every', to: 7200000 }, ctx).ok).toBe(
      false
    );
    const tenant = checkTunableChange({ path: 'bots.tb.agentLoop.every', to: '6h' }, ctx);
    expect(tenant.ok).toBe(false);
    if (!tenant.ok) expect(tenant.note).toContain('tenant');
    const ghost = checkTunableChange({ path: 'bots.ghost.agentLoop.every', to: '6h' }, ctx);
    expect(ghost.ok).toBe(false);
  });

  it('a watcher tunable is a threshold', () => {
    expect(checkTunableChange({ path: 'watcher.integrate.agendaMax', to: 0 }, ctx)).toEqual({
      ok: true,
      family: 'threshold',
    });
  });
});
