/**
 * One way to explain everything: every surface builds the same `Why` and
 * renders it with the same panel. Adding a builder means adding a fixture
 * here; rendering a Why fold anywhere but `web/pages/why-helpers.js` fails.
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Dispatch } from '../../src/bot/curiosity/types';
import { computePostureWithRule } from '../../src/stats/posture';
import { WHY_BUILDERS, type WhyBuilderName } from '../../src/why/builders';
import type { ProactiveSend } from '../../src/why/builders/proactive';
import { WhySchema } from '../../src/why/types';
import { whyPanel } from '../../web/pages/why-helpers.js';

const ROOT = join(import.meta.dir, '..', '..');

const dispatch: Dispatch = {
  id: 'd1',
  botId: 'b1',
  createdAt: '2026-10-11T12:00:00Z',
  kind: 'insight',
  topic: 't',
  hook: 'h',
  whyCare: 'w',
  evidence: 'e',
  action: 'a',
  body: 'b',
  editorScore: 0.5,
  status: 'held',
  heldReason: 'editor',
  heldBar: 0.7,
  origin: { trigger: 'insight', cycleId: 'c1', goalTitle: 'G', plan: 'P' },
};

const proactive: ProactiveSend = {
  botId: 'b1',
  sentAt: '2026-10-11T12:01:00Z',
  recipient: 'operator',
  toOperator: true,
  message: 'm',
  status: 'refused',
  result:
    'Proactive send throttled: b1 may send again at 2026-10-11T13:00:00.000Z. Per-bot cooldown 60m.',
  cycleId: 'c1',
  cycle: { cycleId: 'c1', startedAt: '2026-10-11T12:00:00Z', planSummary: 'P', goalTitle: 'G' },
};

/** One fixture per builder: its input. */
const FIXTURES: { [K in WhyBuilderName]: Parameters<(typeof WHY_BUILDERS)[K]>[0] } = {
  dispatch,
  proactive,
  goalEvent: {
    botId: 'b1',
    event: {
      ts: '2026-10-11T12:00:00Z',
      op: 'status',
      from: 'pending',
      to: 'in_progress',
      actor: 'strategist',
      cycleId: 'c1',
      inferred: false,
      note: null,
    },
    cycle: { cycleId: 'c1', startedAt: '2026-10-11T11:59:00Z', planSummary: 'P' },
  },
  karma: {
    event: {
      id: 'k1',
      botId: 'b1',
      timestamp: '2026-10-11T12:00:00Z',
      delta: 3,
      reason: 'Production approved: "a.md"',
      source: 'production',
      kind: 'productionApproved',
      metadata: { path: 'a.md' },
    },
  },
  posture: computePostureWithRule({
    enabled: true,
    nowMs: Date.UTC(2026, 9, 11, 12),
    lastRunAt: Date.UTC(2026, 9, 11, 11),
    retryCount: 0,
    lastError: null,
    consecutiveIdleCycles: 5,
    goalsActive: 1,
    goalsByStatus: { active: 1 },
    lastOutcomeAt: null,
  }),
  idle: {
    botId: 'b1',
    cycleId: 'c1',
    reasoning: 'r',
    gate: { outputCount: 6, feedbackCount: 0, plan: ['p'] },
  },
  cycle: {
    botId: 'b1',
    cycle: {
      cycleId: 'c1',
      startedAt: '2026-10-11T12:00:00Z',
      status: 'completed',
      goalTitle: 'G',
    },
  },
  ask: { botId: 'b1', cycleId: 'c1', goalId: 'g1', status: 'pending' },
  permission: {
    botId: 'b1',
    action: 'exec',
    resource: 'ls',
    description: 'Look around',
    cycleId: 'c1',
    goalId: 'g1',
    cycle: { cycleId: 'c1', startedAt: '2026-10-11T12:00:00Z', planSummary: 'P', goalTitle: 'G' },
    status: 'approved',
    executionStatus: 'executed',
    executionSummary: 'Listed it.',
  },
  production: {
    entry: {
      id: 'e1',
      timestamp: '2026-10-11T12:00:00Z',
      botId: 'b1',
      tool: 'file_write',
      path: 'a.md',
      action: 'create',
      description: 'd',
      size: 1,
      trackOnly: false,
    },
  },
  direction: {
    botId: 'b1',
    direction: {
      runId: 'r1',
      at: '2026-10-11T12:00:00Z',
      summary: 'S',
      retrospective: 'R',
      bets: [{ id: 'x', title: 'T', kind: 'explore', rationale: 'r' }],
      learned: ['l'],
      surprised: ['s'],
      trigger: { kind: 'first', everyHours: 24 },
    },
  },
  frontier: {
    botId: 'b1',
    item: {
      id: 'f1',
      question: 'q?',
      whyInteresting: 'w',
      bridge: 'b',
      distance: 1,
      surpriseScore: 0.5,
      createdAt: '2026-10-11T12:00:00Z',
      status: 'open',
      createdBy: { by: 'extractor', cycleId: 'c1', at: '2026-10-11T12:00:00Z' },
    },
  },
  agentProposal: {
    proposal: {
      proposedBy: 'b1',
      agentName: 'Scout',
      agentId: 'scout',
      justification: 'Nobody covers research.',
      status: 'pending',
      cycleId: 'c1',
      goalId: 'g1',
    },
    cycle: { cycleId: 'c1', startedAt: '2026-10-11T12:00:00Z', planSummary: 'P', goalTitle: 'G' },
  },
  feedback: {
    botId: 'b1',
    status: 'applied',
    appliedAt: '2026-10-11T12:02:00Z',
    cycleId: 'c1',
    cycle: { cycleId: 'c1', startedAt: '2026-10-11T12:00:00Z', planSummary: 'P' },
  },
};

describe('Why contract', () => {
  for (const name of Object.keys(WHY_BUILDERS) as WhyBuilderName[]) {
    it(`${name}: a valid Why, rendered by the shared panel`, () => {
      const why = WHY_BUILDERS[name](FIXTURES[name] as never);
      const parsed = WhySchema.safeParse(why);
      expect(parsed.success ? null : parsed.error.issues).toBeNull();
      expect(whyPanel(why)).toStartWith('<details class="why">');
    });
  }

  it('every builder file is registered', () => {
    const files = readdirSync(join(ROOT, 'src', 'why', 'builders'))
      .filter((f) => f.endsWith('.ts') && f !== 'index.ts')
      .map((f) => f.replace(/\.ts$/, ''));
    const index = readFileSync(join(ROOT, 'src', 'why', 'builders', 'index.ts'), 'utf-8');
    for (const f of files) expect(index).toContain(`from './${f}'`);
  });

  it('no page renders its own Why fold', () => {
    const pages = join(ROOT, 'web', 'pages');
    const offenders = readdirSync(pages)
      .filter((f) => f.endsWith('.js') && f !== 'why-helpers.js')
      .filter((f) => /class="why[" -]|curio-origin/.test(readFileSync(join(pages, f), 'utf-8')));
    expect(offenders).toEqual([]);
  });
});
