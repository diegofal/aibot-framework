import { describe, expect, test } from 'bun:test';
import {
  type DesignerInput,
  buildRosterPrompt,
  parseRosterAnswer,
  toProposalData,
  vetRoster,
} from '../../../src/watcher/roster/designer';
import {
  type DesignedBot,
  type OperatorBrief,
  WATCHER_PROPOSER,
} from '../../../src/watcher/roster/types';

const brief: OperatorBrief = {
  wants: [
    {
      id: 'w-aaaaaa',
      what: 'Five live AI engineering roles a week',
      cadence: 'every Monday',
      delivery: 'Telegram',
      success: 'I apply to at least one',
    },
    {
      id: 'w-bbbbbb',
      what: 'A note when a framework release breaks us',
      cadence: '',
      delivery: '',
      success: '',
    },
  ],
  notes: 'I read in the morning.',
};

const input = (over: Partial<DesignerInput> = {}): DesignerInput => ({
  brief,
  bots: [
    { id: 'job-seeker', name: 'Job Seeker', enabled: false, mindProposed: false },
    { id: 'scout', name: 'Scout', enabled: true, mindProposed: true },
  ],
  outcomes: [
    {
      botId: 'scout',
      name: 'Scout',
      enabled: true,
      approvedAt: '2026-10-20T00:00:00.000Z',
      serves: ['w-bbbbbb'],
      killCriterion: 'no flagged release in 3 weeks',
      cyclesCompleted: 12,
      lastCycleAt: '2026-10-27T00:00:00.000Z',
      productions: 3,
      approved: 0,
      rejected: 1,
    },
  ],
  previous: [{ agentId: 'old-one', name: 'Old', status: 'rejected', note: 'too vague' }],
  presets: [{ id: 'job-seeker', description: 'Finds roles that match you' }],
  mind: { counts: { fact: 10, insight: 2 }, broadcasts7d: { delivered: 4, served: 1 } },
  slots: 2,
  ...over,
});

const bot = (over: Partial<DesignedBot> = {}): DesignedBot => ({
  agentId: 'role-finder',
  name: 'Role Finder',
  role: 'Finds live AI engineering roles',
  personality: 'Terse and precise',
  serves: ['w-aaaaaa'],
  deliverable: 'A list of five roles with links',
  cadence: '7d',
  delivery: 'Telegram',
  killCriterion: 'Two weekly lists in a row with no role I open',
  goals: ['Every Monday, send five live AI roles'],
  ...over,
});

const vetCtx = {
  brief,
  takenIds: new Set(['job-seeker', 'scout', 'pending-one']),
  presetIds: new Set(['job-seeker', 'researcher']),
  slots: 2,
};

describe('buildRosterPrompt', () => {
  test('shows the brief with ids, the roster, outcomes, presets, the mind, and the slot limit', () => {
    const [system, user] = buildRosterPrompt(input());
    expect(system.role).toBe('system');
    expect(system.content).toContain('serves');
    expect(user.content).toContain('[w-aaaaaa] Five live AI engineering roles a week');
    expect(user.content).toContain('job-seeker (Job Seeker): off');
    expect(user.content).toContain('scout (Scout): on, proposed by me');
    expect(user.content).toContain('12 cycles completed');
    expect(user.content).toContain('no flagged release in 3 weeks');
    expect(user.content).toContain('old-one (Old): rejected — too vague');
    expect(user.content).toContain('job-seeker: Finds roles that match you');
    expect(user.content).toContain('insight 2');
    expect(user.content).toContain('4 delivered, 1 acted on');
    expect(user.content).toContain('Propose at most 2');
  });
});

describe('parseRosterAnswer', () => {
  test('reads proposals, retire and questions; drops malformed entries', () => {
    const answer = parseRosterAnswer(
      JSON.stringify({
        proposals: [
          {
            agentId: 'role-finder',
            name: 'Role Finder',
            role: 'Finds roles',
            personality: 'Terse',
            serves: ['w-aaaaaa'],
            deliverable: 'Five roles',
            cadence: '7d',
            delivery: 'Telegram',
            killCriterion: 'No role opened in two weeks',
            goals: ['Send five roles', 7],
            preset: 'job-seeker',
          },
          { name: 'no id' },
        ],
        retire: [{ botId: 'scout', reason: 'No approved output' }, { botId: 3 }],
        questions: ['Which countries?', ''],
        note: 'One bot covers both wants',
      })
    );
    expect(answer?.proposals).toHaveLength(1);
    expect(answer?.proposals[0].goals).toEqual(['Send five roles']);
    expect(answer?.proposals[0].preset).toBe('job-seeker');
    expect(answer?.retire).toEqual([{ botId: 'scout', reason: 'No approved output' }]);
    expect(answer?.questions).toEqual(['Which countries?']);
    expect(answer?.note).toBe('One bot covers both wants');
  });

  test('JSON inside prose and fences is found; prose alone is null', () => {
    expect(
      parseRosterAnswer('Here:\n```json\n{"proposals":[],"questions":["Why?"]}\n```')?.questions
    ).toEqual(['Why?']);
    expect(parseRosterAnswer('I cannot help with that.')).toBeNull();
  });
});

describe('vetRoster', () => {
  test('accepts a bot that serves a known want', () => {
    const r = vetRoster([bot()], vetCtx);
    expect(r.accepted.map((b) => b.agentId)).toEqual(['role-finder']);
    expect(r.dropped).toEqual([]);
  });

  test('drops a bot that serves no want in the brief, keeping only known ids', () => {
    const r = vetRoster(
      [bot({ serves: ['w-zzzzzz'] }), bot({ agentId: 'two-x', serves: ['w-zzzzzz', 'w-bbbbbb'] })],
      vetCtx
    );
    expect(r.dropped).toEqual([{ name: 'Role Finder', reason: 'serves no want in the brief' }]);
    expect(r.accepted[0].serves).toEqual(['w-bbbbbb']);
  });

  test('drops bad ids, taken ids, repeated ids, bad cadence and unknown presets', () => {
    const r = vetRoster(
      [
        bot({ agentId: 'Bad Id' }),
        bot({ agentId: 'scout' }),
        bot({ agentId: 'pending-one' }),
        bot({ agentId: 'ok-one', cadence: '10m' }),
        bot({ agentId: 'ok-two', cadence: '30d' }),
        bot({ agentId: 'ok-three', preset: 'nope' }),
      ],
      { ...vetCtx, slots: 3 }
    );
    expect(r.accepted).toEqual([]);
    expect(r.dropped.map((d) => d.reason)).toEqual([
      'id "Bad Id" is not a lowercase slug',
      'id "scout" is taken',
      'id "pending-one" is taken',
      'cadence "10m" is outside 30m–7d',
      'cadence "30d" is outside 30m–7d',
      'unknown preset "nope"',
    ]);
  });

  test('two proposals with the same id: the second is dropped', () => {
    const r = vetRoster([bot(), bot()], vetCtx);
    expect(r.accepted).toHaveLength(1);
    expect(r.dropped[0].reason).toBe('id "role-finder" is taken');
  });

  test('over the slots, the rest is dropped as over the limit', () => {
    const r = vetRoster([bot(), bot({ agentId: 'b-two' }), bot({ agentId: 'b-three' })], vetCtx);
    expect(r.accepted.map((b) => b.agentId)).toEqual(['role-finder', 'b-two']);
    expect(r.dropped).toEqual([{ name: 'Role Finder', reason: 'over the limit of 2 proposals' }]);
  });

  test('a bot without a kill criterion or deliverable is dropped', () => {
    const r = vetRoster(
      [bot({ killCriterion: '' }), bot({ agentId: 'x-two', deliverable: '' })],
      vetCtx
    );
    expect(r.dropped.map((d) => d.reason)).toEqual(['no kill criterion', 'no deliverable']);
  });
});

describe('toProposalData', () => {
  test('maps onto an agent proposal by the watcher, with wants as text and preset skills', () => {
    const data = toProposalData(
      bot({ preset: 'job-seeker', mindObjective: 'resolve my hiring predictions' }),
      {
        brief,
        presetSkills: (id) => (id === 'job-seeker' ? ['web-search'] : []),
      }
    );
    expect(data).toMatchObject({
      agentId: 'role-finder',
      agentName: 'Role Finder',
      role: 'Finds live AI engineering roles',
      personalityDescription: 'Terse and precise',
      skills: ['web-search'],
      proposedBy: WATCHER_PROPOSER,
      agentLoop: { mode: 'periodic', every: '7d' },
      serves: [{ id: 'w-aaaaaa', what: 'Five live AI engineering roles a week' }],
      goals: ['Every Monday, send five live AI roles'],
      deliverable: 'A list of five roles with links',
      delivery: 'Telegram',
      killCriterion: 'Two weekly lists in a row with no role I open',
      preset: 'job-seeker',
      mindObjective: 'resolve my hiring predictions',
    });
    expect(data.justification).toContain('Serves: Five live AI engineering roles a week');
    expect(data.justification).toContain('Kill if: Two weekly lists');
  });
});
