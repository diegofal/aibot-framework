import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Config } from '../../../src/config';
import { AgentProposalStore } from '../../../src/tools/agent-proposal-store';
import type { WatcherCallResult } from '../../../src/watcher/llm';
import { writeBrief } from '../../../src/watcher/roster/brief';
import { toProposalData } from '../../../src/watcher/roster/designer';
import {
  BRIEF_SETTLE_MS,
  ROSTER_RETRY_MS,
  RosterRunner,
  type RosterRunnerDeps,
  readRosterState,
} from '../../../src/watcher/roster/runner';
import { ROSTER_DEFAULTS, WATCHER_PROPOSER } from '../../../src/watcher/roster/types';

const HOUR = 3_600_000;
let root: string;
let now: number;
let store: AgentProposalStore;
let rows: Array<{ op: string; text: string }>;
let calls: number;
let answer: WatcherCallResult;
let bots: Config['bots'];

const okAnswer = (json: unknown): WatcherCallResult => ({
  ok: true,
  text: JSON.stringify(json),
  model: 'opus',
  backend: 'claude-cli',
  tokens: 1200,
  costUsd: 0.05,
  durationMs: 10,
});

const designed = (over: Record<string, unknown> = {}) => ({
  agentId: 'role-finder',
  name: 'Role Finder',
  role: 'Finds roles',
  personality: 'Terse',
  serves: ['w-aaaaaa'],
  deliverable: 'Five roles',
  cadence: '7d',
  delivery: 'Telegram',
  killCriterion: 'No role opened in two weeks',
  goals: ['Send five roles every Monday'],
  ...over,
});

function deps(over: Partial<RosterRunnerDeps> = {}): RosterRunnerDeps {
  return {
    watcherDir: join(root, 'watcher'),
    settings: () => ({ ...ROSTER_DEFAULTS }),
    config: () => ({ bots }) as unknown as Config,
    store: () => store,
    client: () => ({
      tier: 'integrate',
      model: 'opus',
      backend: 'claude-cli',
      chat: async () => {
        calls++;
        return answer;
      },
    }),
    mind: () => ({ counts: { fact: 3 } }),
    botOutcome: () => ({ cyclesCompleted: 4, productions: 2, approved: 1, rejected: 0 }),
    presets: () => [{ id: 'job-seeker', description: 'Finds roles', skills: ['web'] }],
    log: (op, text) => rows.push({ op, text }),
    running: () => true,
    killed: () => false,
    signal: () => undefined,
    now: () => now,
    ...over,
  };
}

function saveBrief(at = now) {
  writeBrief(
    join(root, 'watcher'),
    {
      wants: [
        {
          id: 'w-aaaaaa',
          what: 'Five AI roles a week',
          cadence: 'weekly',
          delivery: 'Telegram',
          success: '',
        },
      ],
      notes: '',
    },
    at
  );
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'roster-'));
  now = Date.parse('2026-10-28T03:00:00Z');
  store = new AgentProposalStore(join(root, 'agent-proposals'));
  rows = [];
  calls = 0;
  answer = okAnswer({ proposals: [designed()], questions: [], retire: [] });
  bots = [{ id: 'job-seeker', name: 'Job Seeker', enabled: false }] as Config['bots'];
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('RosterRunner.run', () => {
  test('proposes a vetted bot into the agent proposal queue as the watcher and saves the outcome', async () => {
    saveBrief();
    const r = await new RosterRunner(deps()).run('manual');
    expect(r.status).toBe('ran');
    if (r.status !== 'ran') return;
    expect(r.outcome.status).toBe('proposed');
    expect(r.outcome.proposed.map((p) => p.agentId)).toEqual(['role-finder']);
    const [p] = store.list();
    expect(p).toMatchObject({
      agentId: 'role-finder',
      proposedBy: WATCHER_PROPOSER,
      status: 'pending',
      serves: [{ id: 'w-aaaaaa', what: 'Five AI roles a week' }],
    });
    const state = readRosterState(join(root, 'watcher'));
    expect(state.lastRunAt).toBe('2026-10-28T03:00:00.000Z');
    expect(state.briefSeen).toBe('2026-10-28T03:00:00.000Z');
    expect(state.lastOutcome?.tokens).toBe(1200);
    expect(rows.map((x) => x.op)).toContain('roster:run');
  });

  test('no wants yet: nothing, no model call', async () => {
    const r = await new RosterRunner(deps()).run('manual');
    expect(r.status === 'ran' && r.outcome).toMatchObject({
      status: 'nothing',
      reason: 'The brief has no wants yet',
    });
    expect(calls).toBe(0);
  });

  test('pending proposals at the limit: nothing, no model call', async () => {
    saveBrief();
    for (const id of ['a-one', 'a-two'])
      store.create({
        ...toProposalData({ ...designed({ agentId: id }), goals: [] } as never, {
          brief: { wants: [], notes: '' },
          presetSkills: () => [],
        }),
      });
    const r = await new RosterRunner(deps()).run('manual');
    expect(r.status === 'ran' && r.outcome.reason).toBe('2 proposals are waiting for you');
    expect(calls).toBe(0);
  });

  test('one pending proposal leaves one slot: the second bot is dropped as over the limit', async () => {
    saveBrief();
    store.create({
      ...toProposalData({ ...designed({ agentId: 'waiting' }) } as never, {
        brief: { wants: [], notes: '' },
        presetSkills: () => [],
      }),
    });
    answer = okAnswer({ proposals: [designed(), designed({ agentId: 'second' })] });
    const r = await new RosterRunner(deps()).run('manual');
    expect(r.status === 'ran' && r.outcome.proposed.map((p) => p.agentId)).toEqual(['role-finder']);
    expect(r.status === 'ran' && r.outcome.dropped[0].reason).toBe('over the limit of 1 proposal');
  });

  test('a refused call records the attempt, not a run', async () => {
    saveBrief();
    answer = { ok: false, reason: 'cap' } as WatcherCallResult;
    const r = await new RosterRunner(deps()).run('manual');
    expect(r.status === 'ran' && r.outcome.status).toBe('refused');
    const state = readRosterState(join(root, 'watcher'));
    expect(state.lastRunAt).toBeUndefined();
    expect(state.lastAttemptAt).toBe('2026-10-28T03:00:00.000Z');
  });

  test('an unreadable answer counts as a run and proposes nothing', async () => {
    saveBrief();
    answer = { ...okAnswer({}), text: 'sorry' } as WatcherCallResult;
    const r = await new RosterRunner(deps()).run('manual');
    expect(r.status === 'ran' && r.outcome.status).toBe('unparsable');
    expect(readRosterState(join(root, 'watcher')).lastRunAt).toBeDefined();
    expect(store.list()).toEqual([]);
  });

  test('questions only: nothing proposed, the questions are kept', async () => {
    saveBrief();
    answer = okAnswer({ proposals: [], questions: ['Which countries?'] });
    const r = await new RosterRunner(deps()).run('manual');
    expect(r.status === 'ran' && r.outcome).toMatchObject({
      status: 'nothing',
      questions: ['Which countries?'],
    });
  });

  test('retire keeps only bots the mind proposed', async () => {
    saveBrief();
    const p = store.create({
      ...toProposalData(designed({ agentId: 'scout' }) as never, {
        brief: { wants: [], notes: '' },
        presetSkills: () => [],
      }),
    });
    store.updateStatus(p.id, 'approved');
    bots = [...(bots ?? []), { id: 'scout', name: 'Scout', enabled: true }] as Config['bots'];
    answer = okAnswer({
      proposals: [],
      retire: [
        { botId: 'scout', reason: 'kill criterion met' },
        { botId: 'job-seeker', reason: 'not mine' },
      ],
    });
    const r = await new RosterRunner(deps()).run('manual');
    expect(r.status === 'ran' && r.outcome.retire).toEqual([
      { botId: 'scout', reason: 'kill criterion met' },
    ]);
  });

  test('a stop during the call writes nothing', async () => {
    saveBrief();
    const ctrl = new AbortController();
    const r = await new RosterRunner(
      deps({
        signal: () => ctrl.signal,
        client: () => ({
          tier: 'integrate',
          model: 'opus',
          backend: 'claude-cli',
          chat: async () => {
            ctrl.abort();
            return answer;
          },
        }),
      })
    ).run('manual');
    expect(r.status).toBe('cancelled');
    expect(store.list()).toEqual([]);
    expect(readRosterState(join(root, 'watcher'))).toEqual({});
  });

  test('a brief saved during the call discards the answer and stays due (review #30)', async () => {
    saveBrief();
    const r = await new RosterRunner(
      deps({
        client: () => ({
          tier: 'integrate',
          model: 'opus',
          backend: 'claude-cli',
          chat: async () => {
            calls++;
            writeBrief(
              join(root, 'watcher'),
              {
                wants: [
                  {
                    id: 'w-bbbbbb',
                    what: 'Something else',
                    cadence: '',
                    delivery: '',
                    success: '',
                  },
                ],
                notes: '',
              },
              now + 1000
            );
            return answer;
          },
        }),
      })
    ).run('manual');
    expect(r.status === 'ran' && r.outcome).toMatchObject({
      status: 'nothing',
      reason: 'The brief changed during the run',
    });
    expect(store.list()).toEqual([]);
    const state = readRosterState(join(root, 'watcher'));
    expect(state.briefSeen).toBeUndefined();
    expect(state.lastRunAt).toBeDefined();
  });

  test('unavailable: asleep, killed, off, no proposal store', async () => {
    const reasons = await Promise.all(
      [
        deps({ running: () => false }),
        deps({ killed: () => true }),
        deps({ settings: () => ({ ...ROSTER_DEFAULTS, enabled: false }) }),
        deps({ store: () => undefined }),
      ].map(async (d) => {
        const r = await new RosterRunner(d).run('manual');
        return r.status === 'unavailable' ? r.reason : r.status;
      })
    );
    expect(reasons).toEqual([
      'The watcher is asleep',
      'The hard kill is on',
      'The roster is off (watcher.roster.enabled)',
      'Agent proposals are off (agentProposals.enabled)',
    ]);
  });
});

describe('RosterRunner.tick', () => {
  test('a brief edit is due 30 minutes later, once', async () => {
    saveBrief();
    const runner = new RosterRunner(deps());
    expect(runner.tick(now + BRIEF_SETTLE_MS - 1)).toBe(false);
    now += BRIEF_SETTLE_MS;
    expect(runner.tick(now)).toBe(true);
    await runner.current();
    expect(calls).toBe(1);
    expect(runner.tick(now + HOUR)).toBe(false);
  });

  test('weekly after the last run; a refused attempt waits the retry', async () => {
    saveBrief(now - 2 * HOUR);
    const runner = new RosterRunner(deps());
    await runner.run('manual');
    const week = 168 * HOUR;
    expect(runner.tick(now + week - 1)).toBe(false);
    answer = { ok: false, reason: 'cap' } as WatcherCallResult;
    now += week;
    expect(runner.tick(now)).toBe(true);
    await runner.current();
    expect(runner.tick(now + ROSTER_RETRY_MS - 1)).toBe(false);
    expect(runner.tick(now + ROSTER_RETRY_MS)).toBe(true);
  });

  test('no brief: never due', () => {
    expect(new RosterRunner(deps()).tick(now + 1000 * HOUR)).toBe(false);
  });
});

describe('RosterRunner.status', () => {
  test('lists the mind proposals and the approved bots with their outcomes', async () => {
    saveBrief();
    const p = store.create({
      ...toProposalData(designed({ agentId: 'scout' }) as never, {
        brief: {
          wants: [{ id: 'w-aaaaaa', what: 'x', cadence: '', delivery: '', success: '' }],
          notes: '',
        },
        presetSkills: () => [],
      }),
    });
    store.updateStatus(p.id, 'approved');
    store.create({
      agentId: 'by-a-bot',
      agentName: 'X',
      role: 'r',
      personalityDescription: '',
      skills: [],
      justification: '',
      proposedBy: 'jarvis',
    });
    bots = [{ id: 'scout', name: 'Scout', enabled: true }] as Config['bots'];
    const s = new RosterRunner(deps()).status();
    expect(s.enabled).toBe(true);
    expect(s.proposalsOn).toBe(true);
    expect(s.proposals.map((x) => [x.agentId, x.status, x.serves, x.cadence])).toEqual([
      ['scout', 'approved', ['w-aaaaaa'], '7d'],
    ]);
    expect(s.bots).toEqual([
      expect.objectContaining({
        botId: 'scout',
        name: 'Scout',
        enabled: true,
        cyclesCompleted: 4,
        approved: 1,
        killCriterion: 'No role opened in two weeks',
      }),
    ]);
    expect(s.nextRunAt).toBe(new Date(now + BRIEF_SETTLE_MS).toISOString());
  });
});
