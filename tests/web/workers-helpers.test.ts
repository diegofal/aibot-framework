import { describe, expect, it } from 'bun:test';
import {
  activeWorkersByTask,
  formatElapsed,
  homeEventEffects,
  isWorkerEvent,
  waitingWorkersSection,
  workerActionPath,
  workerDetailUrl,
  workerModel,
  workerSheetBody,
  workerTaskBadge,
  workersList,
  workersPollingWanted,
  workersStrip,
} from '../../web/pages/workers-helpers.js';

const NOW = Date.parse('2026-10-12T10:00:00Z');
const budget = { steps: 8, toolCalls: 40, wallMs: 3_600_000 };

const run = (over: Record<string, unknown> = {}) => ({
  runId: 'r-7c1e',
  botId: 'b1',
  taskId: 't-1',
  goalId: 'g-1',
  dispatchCycleId: 'c-9',
  taskText: 'Find 3 companies running at L3+',
  goalTitle: 'Dark factory research',
  status: 'running',
  attempt: 1,
  step: 3,
  budget,
  used: { steps: 3, toolCalls: 7, wallMs: 360_000 },
  createdAt: '2026-10-12T09:53:00Z',
  startedAt: '2026-10-12T09:54:00Z',
  currentTool: 'web_fetch',
  ...over,
});

describe('formatElapsed', () => {
  it('reads like the mockup', () => {
    expect(formatElapsed(20_000)).toBe('<1 min');
    expect(formatElapsed(6 * 60_000)).toBe('6 min');
    expect(formatElapsed(2 * 3_600_000 + 60_000)).toBe('2 h');
    expect(formatElapsed(3 * 86_400_000)).toBe('3 d');
    expect(formatElapsed(-5)).toBe('<1 min');
    expect(formatElapsed(Number.NaN)).toBe('');
  });
});

describe('workerModel', () => {
  it('normalises a run view', () => {
    const m = workerModel(run());
    expect(m).toMatchObject({
      runId: 'r-7c1e',
      taskId: 't-1',
      status: 'running',
      step: 3,
      steps: 8,
      tool: 'web_fetch',
      question: null,
      sinceMs: Date.parse('2026-10-12T09:54:00Z'),
      active: true,
    });
  });

  it('normalises a live presence worker', () => {
    const m = workerModel({
      runId: 'r-2',
      taskId: 't-2',
      goalId: null,
      status: 'waiting',
      step: 4,
      budget,
      used: budget,
      tool: null,
      question: 'Which metric?',
      since: NOW - 7_200_000,
      updatedAt: NOW,
    });
    expect(m).toMatchObject({
      status: 'waiting',
      question: 'Which metric?',
      sinceMs: NOW - 7_200_000,
    });
  });

  it('takes the question of a waiting run view from its wait, and marks ended runs inactive', () => {
    expect(
      workerModel(
        run({ status: 'waiting', wait: { kind: 'ask', id: 'q', question: 'Q?', since: 'x' } })
      ).question
    ).toBe('Q?');
    expect(workerModel(run({ status: 'done' })).active).toBe(false);
  });
});

describe('workerTaskBadge', () => {
  it('a running worker pulses with step n/budget, tool and elapsed, and opens the sheet', () => {
    const html = workerTaskBadge(run(), NOW);
    expect(html).toContain('wk-pulse');
    expect(html).not.toContain('is-wait');
    expect(html).toContain('step 3/8');
    expect(html).toContain('web_fetch');
    expect(html).toContain('6 min');
    expect(html).toContain('data-open-worker="r-7c1e"');
  });

  it('a waiting worker is amber with its question', () => {
    const html = workerTaskBadge(
      run({
        status: 'waiting',
        wait: { kind: 'ask', id: 'q', question: 'Which <metric>?', since: 'x' },
      }),
      NOW
    );
    expect(html).toContain('is-wait');
    expect(html).toContain('waiting on you');
    expect(html).toContain('Which &lt;metric&gt;?');
  });

  it('is empty without a run or for an ended run', () => {
    expect(workerTaskBadge(null, NOW)).toBe('');
    expect(workerTaskBadge(run({ status: 'done' }), NOW)).toBe('');
  });
});

describe('activeWorkersByTask', () => {
  it('maps task id to its active run (newest wins) and skips ended runs', () => {
    const map = activeWorkersByTask([
      run({ runId: 'old', status: 'failed' }),
      run({ runId: 'r-a' }),
      run({ runId: 'r-b', taskId: 't-2' }),
    ]);
    expect(map.get('t-1')?.runId).toBe('r-a');
    expect(map.get('t-2')?.runId).toBe('r-b');
    expect(activeWorkersByTask(null).size).toBe(0);
  });
});

describe('workersStrip', () => {
  it('one card per active run with the progress bar; ended runs are left out', () => {
    const html = workersStrip([run(), run({ runId: 'r-x', status: 'done' })], { nowMs: NOW });
    expect(html).toContain('Active workers');
    expect(html.match(/class="wk-card[ "]/g)).toHaveLength(1);
    expect(html).toContain('Dark factory research · step 3 / 8 · web_fetch · 6 min');
    expect(html).toContain('width:38%');
  });

  it('a waiting card shows the question in amber', () => {
    const html = workersStrip(
      [
        run({
          status: 'waiting',
          wait: { kind: 'ask', id: 'q', question: 'Rollback metric?', since: 'x' },
        }),
      ],
      { nowMs: NOW }
    );
    expect(html).toContain('is-wait');
    expect(html).toContain('waiting on you: &quot;Rollback metric?&quot;');
  });

  it('is empty when no run is active', () => {
    expect(workersStrip([], { nowMs: NOW })).toBe('');
    expect(workersStrip([run({ status: 'stopped' })], { nowMs: NOW })).toBe('');
  });
});

describe('workerSheetBody', () => {
  const detail = {
    run: run(),
    journal: [],
    steps: [
      {
        n: 1,
        startedAt: '2026-10-12T09:54:00Z',
        endedAt: '2026-10-12T09:56:00Z',
        summary: 'Shortlisted 6 candidates',
        report: { kind: 'progress', note: 'Shortlisted 6 candidates' },
        toolCalls: [
          { name: 'web_search', ok: true, sideEffect: 'read' },
          { name: 'web_search', ok: true, sideEffect: 'read' },
        ],
      },
      {
        n: 2,
        startedAt: '2026-10-12T09:56:00Z',
        toolCalls: [{ name: 'web_fetch', target: 'globex.com', ok: true, sideEffect: 'read' }],
      },
    ],
  };

  it('shows the header, budget, cycle link, one row per step and Stop for an active run', () => {
    const html = workerSheetBody(detail, NOW);
    expect(html).toContain('Find 3 companies running at L3+');
    expect(html).toContain('Dark factory research');
    expect(html).toContain('Attempt 1');
    expect(html).toContain('data-open-cycle="c-9"');
    expect(html).toContain('data-bot-id="b1"');
    expect(html).toContain('Steps');
    expect(html).toContain('Tool calls');
    expect(html).toContain('web_search<b>×2</b>');
    expect(html).toContain('step 1');
    expect(html).toContain('progress');
    expect(html).toContain('running');
    expect(html).toContain('data-worker-stop="r-7c1e"');
    expect(html).not.toContain('data-worker-retry');
  });

  it('an ended run offers Retry and shows its outcome; an operator retry has no cycle', () => {
    const html = workerSheetBody(
      {
        ...detail,
        run: run({
          status: 'blocked',
          dispatchCycleId: null,
          outcome: { kind: 'blocked', note: 'Needs a login' },
          endedAt: '2026-10-12T09:59:00Z',
        }),
      },
      NOW
    );
    expect(html).toContain('data-worker-retry="r-7c1e"');
    expect(html).not.toContain('data-worker-stop');
    expect(html).toContain('Needs a login');
    expect(html).toContain('Started by you');
    expect(html).not.toContain('data-open-cycle');
  });

  it('shows the question of a waiting run and copes with no steps', () => {
    const html = workerSheetBody(
      {
        run: run({
          status: 'waiting',
          wait: { kind: 'ask', id: 'q', question: 'Which?', since: 'x' },
        }),
        steps: [],
        journal: [],
      },
      NOW
    );
    expect(html).toContain('Which?');
    expect(html).toContain('No steps yet');
    expect(html).toContain('href="#/needs/inbox"');
    expect(html).toContain('Waiting for your answer');
  });

  it('an approval wait links to permissions; a question cut at 300 chars says so', () => {
    const html = workerSheetBody(
      {
        run: run({
          status: 'waiting',
          wait: { kind: 'approval', id: 'p', question: 'x'.repeat(300), since: 'x' },
        }),
        steps: [],
      },
      NOW
    );
    expect(html).toContain('href="#/needs/permissions"');
    expect(html).toContain(`${'x'.repeat(300)}…`);
  });

  it('a step shows its note, not the raw summary, and tool targets only in the tooltip', () => {
    const html = workerSheetBody(
      {
        run: run(),
        steps: [
          {
            n: 1,
            startedAt: '2026-10-12T09:54:00Z',
            endedAt: '2026-10-12T09:56:00Z',
            summary: 'progress: Wrote it — tools: file_read ×2',
            report: { kind: 'progress', note: 'Wrote it' },
            toolCalls: [
              { name: 'file_read', target: 'a.md', ok: true },
              { name: 'file_read', target: 'b.md', ok: true },
            ],
          },
        ],
      },
      NOW
    );
    expect(html).toContain('Wrote it');
    expect(html).not.toContain('— tools:');
    expect(html).toContain('title="a.md\nb.md"');
    expect(html).toContain('2 min · 2 tool calls');
  });
});

describe('workersList (fleet view)', () => {
  it('active runs first, then recent, with bot names and links to the sheet', () => {
    const html = workersList(
      [
        run(),
        run({ runId: 'r-old', botId: 'b2', status: 'done', endedAt: '2026-10-12T08:00:00Z' }),
      ],
      { nowMs: NOW, names: { b1: 'Bot One', b2: 'Bot Two' } }
    );
    expect(html.indexOf('Active')).toBeLessThan(html.indexOf('Recent'));
    expect(html).toContain('Bot One');
    expect(html).toContain('Bot Two');
    expect(html).toContain('data-open-worker="r-old"');
    expect(html).toContain('done');
  });

  it('says when workers are off or nothing ran', () => {
    expect(workersList([], { nowMs: NOW, enabled: false })).toContain('Workers are off');
    expect(workersList([], { nowMs: NOW })).toContain('No worker runs yet');
  });
});

describe('waitingWorkersSection (Needs You)', () => {
  it('lists waiting runs with their question and a link to the sheet', () => {
    const html = waitingWorkersSection(
      [
        {
          runId: 'r-1',
          botId: 'b1',
          botName: 'Bot One',
          taskId: 't-1',
          taskText: 'Draft the rollback plan',
          goalTitle: 'Pilot',
          step: 4,
          stepsBudget: 8,
          question: 'Which metric decides a rollback?',
          waitKind: 'ask',
          waitId: 'q1',
          since: '2026-10-12T08:00:00Z',
          itemId: 'ask:q1',
        },
      ],
      NOW
    );
    expect(html).toContain('Workers waiting on you');
    expect(html).toContain('Which metric decides a rollback?');
    expect(html).toContain('Draft the rollback plan');
    expect(html).toContain('data-open-worker="r-1"');
    expect(html).toContain('2 h');
    expect(waitingWorkersSection([], NOW)).toBe('');
    expect(waitingWorkersSection(undefined, NOW)).toBe('');
  });
});

describe('events and urls', () => {
  it('isWorkerEvent accepts worker:* and task:changed, optionally for one bot', () => {
    expect(isWorkerEvent({ type: 'worker:step', botId: 'b1' })).toBe(true);
    expect(isWorkerEvent({ type: 'task:changed', botId: 'b1' }, 'b1')).toBe(true);
    expect(isWorkerEvent({ type: 'task:changed', botId: 'b2' }, 'b1')).toBe(false);
    expect(isWorkerEvent({ type: 'tool:start', botId: 'b1' })).toBe(false);
    expect(isWorkerEvent(null)).toBe(false);
  });

  it('builds encoded urls', () => {
    expect(workerDetailUrl('r/1')).toBe('/api/workers/r%2F1');
    expect(workerActionPath('r-1', 'stop')).toBe('/api/workers/r-1/stop');
    expect(workerActionPath('r-1', 'retry')).toBe('/api/workers/r-1/retry');
  });
});

describe('agent home live updates (M6)', () => {
  it('homeEventEffects: worker progress refreshes only the workers strip, not the home', () => {
    expect(homeEventEffects({ type: 'worker:tool', botId: 'b1' })).toEqual({
      workers: true,
      home: false,
    });
    expect(homeEventEffects({ type: 'worker:step', botId: 'b1' })).toEqual({
      workers: true,
      home: false,
    });
    expect(homeEventEffects({ type: 'tool:start', botId: 'b1', data: { runId: 'r-1' } })).toEqual({
      workers: false,
      home: false,
    });
  });

  it('homeEventEffects: a run that ends or a task change refreshes both', () => {
    expect(homeEventEffects({ type: 'worker:ended', botId: 'b1' })).toEqual({
      workers: true,
      home: true,
    });
    expect(homeEventEffects({ type: 'task:changed', botId: 'b1' })).toEqual({
      workers: true,
      home: true,
    });
    expect(homeEventEffects({ type: 'agent:result', botId: 'b1' })).toEqual({
      workers: false,
      home: true,
    });
    expect(homeEventEffects(null)).toEqual({ workers: false, home: false });
  });

  it('workersPollingWanted: stop polling once the route says workers are off', () => {
    expect(workersPollingWanted({ enabled: false })).toBe(false);
    expect(workersPollingWanted({ enabled: true, runs: [] })).toBe(true);
    expect(workersPollingWanted({ runs: [] })).toBe(true);
    // a failed request says nothing: keep polling
    expect(workersPollingWanted(null)).toBe(true);
    expect(workersPollingWanted({ error: 'boom' })).toBe(true);
  });
});

describe('worker sheet why (C22)', () => {
  it('renders the run why with the shared panel, Open cycle included', () => {
    const html = workerSheetBody(
      {
        run: run(),
        steps: [],
        why: {
          what: 'A worker run on "Book the room"',
          by: 'agent',
          cycle: { id: 'c-1', botId: 'b1', plan: 'Hand it off' },
        },
      },
      NOW
    );
    expect(html).toContain('<details class="why">');
    expect(html).toContain('Hand it off');
    expect(html).toContain('data-open-cycle="c-1"');
  });

  it('no why, no fold', () => {
    expect(workerSheetBody({ run: run(), steps: [] }, NOW)).not.toContain('class="why"');
  });
});
