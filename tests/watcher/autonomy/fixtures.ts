import type { Config } from '../../../src/config';
import type { ProposalInput } from '../../../src/watcher/autonomy/types';
import type { WatcherLogRow } from '../../../src/watcher/types';
import { WATCHER_DEFAULTS } from '../../../src/watcher/types';

/** A valid rung-0 threshold proposal; override what a test needs. */
export function proposalInput(over: Partial<ProposalInput> = {}): ProposalInput {
  return {
    kind: 'threshold',
    title: 'Raise the notice salience bar',
    rationale: 'Most notice passes keep nothing; a higher bar wakes fewer of them.',
    support: ['n-12345678'],
    changes: [{ path: 'watcher.notice.salienceBar', from: 0.4, to: 0.6 }],
    predicted: { effect: 'About a third fewer notice passes', savingUsdPerWeek: 2 },
    guard: { metric: 'watcher.costUsdPerDay', direction: 'max', bound: 3, windowHours: 72 },
    rollback: 'Set the bar back to 0.4',
    proposedBy: 'test',
    ...over,
  };
}

/** A live-config stand-in: one admin bot, one tenant bot, multi-tenant on, proposals on. */
export function testConfig(
  dataDir: string,
  proposals: Partial<{ enabled: boolean; maxPending: number; approvalTtlHours: number }> = {}
): Config {
  return {
    bots: [
      { id: 'b1', name: 'b1', enabled: true, agentLoop: { every: '2h' } },
      { id: 'b2', name: 'b2', enabled: true, tenantId: '__admin__' },
      { id: 'tb', name: 'tb', enabled: true, tenantId: 't1', agentLoop: { every: '6h' } },
    ],
    multiTenant: { enabled: true },
    paths: { data: dataDir },
    operator: {},
    watcher: {
      ...WATCHER_DEFAULTS,
      notice: { ...WATCHER_DEFAULTS.notice },
      integrate: { ...WATCHER_DEFAULTS.integrate },
      autonomy: {
        monthlyCeilingUsd: 90,
        proposals: { enabled: true, maxPending: 3, approvalTtlHours: 72, ...proposals },
      },
    },
  } as unknown as Config;
}

/** Collects the rows a module says. */
export function rowLog() {
  const rows: Array<Pick<WatcherLogRow, 'phase' | 'op' | 'text'>> = [];
  return {
    rows,
    say(phase: WatcherLogRow['phase'], op: string, text: string) {
      rows.push({ phase, op, text });
      return undefined;
    },
    ops: () => rows.map((r) => r.op),
  };
}
