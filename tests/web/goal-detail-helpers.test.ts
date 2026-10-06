import { describe, expect, it } from 'bun:test';
import {
  goalDetailBody,
  goalDetailError,
  goalDetailUrl,
  goalEditPayload,
  goalEditor,
} from '../../web/pages/goal-detail-helpers.js';

const NOW = Date.parse('2026-10-06T16:00:00.000Z');

function detail(over = {}) {
  return {
    botId: 'ai-perfectionist',
    generatedAt: '2026-10-06T16:00:00.000Z',
    days: 14,
    goal: {
      id: 'g-lab00001',
      text: 'Monthly <lab>',
      status: 'in_progress',
      section: 'active',
      bucket: 'inProgress',
      priority: 'high',
      notes: 'October lab drafted: 05_monthly_lab.md',
      outcome: null,
      source: 'operator:2026-10-04',
      origin: 'operator',
      originDate: '2026-10-04',
      created: '2026-10-04',
      started: '2026-10-06T13:58:00.000Z',
      updated: '2026-10-06T13:59:00.000Z',
      completed: null,
    },
    timeline: [
      {
        ts: '2026-10-05T10:00:00.000Z',
        op: 'add',
        from: null,
        to: 'pending',
        actor: 'operator',
        note: null,
        inferred: false,
        source: 'goal-events',
      },
      {
        ts: '2026-10-06T13:58:00.000Z',
        op: 'status',
        from: 'pending',
        to: 'in_progress',
        actor: 'tool',
        note: 'drafted',
        inferred: true,
        source: 'tool-audit',
      },
    ],
    cycles: [
      {
        cycleId: 'c-1',
        startedAt: '2026-10-06T13:58:00.000Z',
        endedAt: '2026-10-06T13:59:33.000Z',
        durationMs: 93_000,
        status: 'completed',
        focus: null,
        planSummary: 'Draft the October lab',
        attribution: 'exact',
        reason: 'cycle log',
        llmCalls: [
          {
            ts: '2026-10-06T13:58:02.000Z',
            caller: 'planner',
            backend: 'claude-cli',
            model: 'sonnet',
            promptTokens: 1200,
            completionTokens: 300,
            durationMs: 4000,
            ok: true,
            error: null,
          },
          {
            ts: '2026-10-06T13:59:33.000Z',
            caller: 'executor',
            backend: 'claude-cli',
            model: 'sonnet',
            promptTokens: 10,
            completionTokens: 900,
            durationMs: 48000,
            ok: false,
            error: 'timed out',
          },
        ],
        toolCalls: [
          {
            ts: '2026-10-06T13:59:00.000Z',
            name: 'file_write',
            ok: true,
            failureKind: null,
            args: '{"path":"05_monthly_lab.md"}',
            result: 'ok',
          },
          {
            ts: '2026-10-06T13:59:10.000Z',
            name: 'web_fetch',
            ok: false,
            failureKind: 'not-found',
            args: '{}',
            result: '404',
          },
        ],
        productions: [
          {
            ts: '2026-10-06T13:59:01.000Z',
            path: '05_monthly_lab.md',
            action: 'create',
            size: 2048,
            description: 'Lab',
            review: 'pending',
          },
        ],
        asks: [
          {
            id: 'ask-1',
            title: 'Which skill?',
            createdAt: '2026-10-06T13:59:05.000Z',
            status: 'pending',
          },
        ],
        karma: [
          {
            ts: '2026-10-06T15:00:00.000Z',
            delta: 3,
            reason: 'Production approved',
            kind: 'productionApproved',
          },
        ],
      },
      {
        cycleId: null,
        startedAt: '2026-10-02T09:00:00.000Z',
        endedAt: '2026-10-02T09:01:00.000Z',
        durationMs: 60_000,
        status: null,
        focus: null,
        planSummary: null,
        attribution: 'weak',
        reason: 'keyword overlap',
        llmCalls: [],
        toolCalls: [],
        productions: [],
        asks: [],
        karma: [],
      },
    ],
    totals: {
      cycles: 2,
      exactCycles: 1,
      inferredCycles: 1,
      llmCalls: 2,
      tokens: 2410,
      toolCalls: 2,
      toolFailures: 1,
      files: 1,
      asks: 1,
    },
    tracking: { exact: true, note: 'Cycles recorded with this goal are exact.' },
    ...over,
  };
}

describe('goalDetailUrl', () => {
  it('prefers the id and falls back to the exact title', () => {
    expect(goalDetailUrl('a b', { id: 'g-1', title: 'T' })).toBe(
      '/api/agents/a%20b/goals/detail?id=g-1'
    );
    expect(goalDetailUrl('b', { id: '', title: 'Ship & go' })).toBe(
      '/api/agents/b/goals/detail?title=Ship%20%26%20go'
    );
  });
});

describe('goalDetailBody', () => {
  it('renders the header: status, priority, who set it and the dates', () => {
    const html = goalDetailBody(detail(), 'ai-perfectionist', NOW);
    expect(html).toContain('Monthly &lt;lab&gt;');
    expect(html).toContain('In progress');
    expect(html).toContain('high');
    expect(html).toContain('Set by you');
    expect(html).toContain('2026-10-04');
    expect(html).toContain('Started');
    expect(html).toContain('2h ago');
    expect(html).toContain('October lab drafted');
  });

  it('renders totals, the timeline and marks inferred events', () => {
    const html = goalDetailBody(detail(), 'ai-perfectionist', NOW);
    expect(html).toContain('2,410');
    expect(html).toMatch(/gd-tl-item[^"]*inferred/);
    expect(html).toContain('pending → in_progress');
  });

  it('renders each cycle with attribution, LLM calls, tools, files, asks and karma', () => {
    const html = goalDetailBody(detail(), 'ai-perfectionist', NOW);
    expect(html.match(/<details class="gd-cycle/g)).toHaveLength(2);
    expect(html).toContain('gd-attr-exact');
    expect(html).toContain('title="cycle log"');
    expect(html).toContain('gd-attr-weak');
    expect(html).toContain('Draft the October lab');
    expect(html).toContain('planner');
    expect(html).toContain('timed out');
    expect(html).toContain('web_fetch');
    expect(html).toContain('not-found');
    expect(html).toContain('href="#/work/productions/ai-perfectionist?file=05_monthly_lab.md"');
    expect(html).toContain('Which skill?');
    expect(html).toContain('+3');
  });

  it('explains when nothing is linked yet', () => {
    const html = goalDetailBody(
      detail({
        cycles: [],
        timeline: [],
        tracking: { exact: false, note: 'Exact tracking starts soon.' },
      }),
      'b',
      NOW
    );
    expect(html).toContain('No work linked to this goal');
    expect(html).toContain('Exact tracking starts soon.');
  });
});

describe('goalDetailError', () => {
  it('escapes the message', () => {
    expect(goalDetailError('<b>nope</b>')).toContain('&lt;b&gt;nope');
  });
});

describe('editing a goal from the drawer', () => {
  it('title and notes are click-to-edit, and the drawer knows which goal it shows', () => {
    const html = goalDetailBody(detail(), 'ai-perfectionist', NOW);
    expect(html).toContain('data-edit="title"');
    expect(html).toContain('data-edit="notes"');
    expect(html).toContain('data-goal-id="g-lab00001"');
    expect(html).toContain('data-goal="Monthly &lt;lab&gt;"');
  });

  it('a goal without notes offers to add them', () => {
    const d = detail();
    d.goal.notes = null;
    const html = goalDetailBody(d, 'ai-perfectionist', NOW);
    expect(html).toContain('data-edit="notes"');
    expect(html).toContain('Add notes');
  });

  it('the editor is a textarea holding the current value with Save and Cancel', () => {
    const html = goalEditor('title', 'Say "hi" <now>');
    expect(html).toContain('<textarea');
    expect(html).toContain('Say &quot;hi&quot; &lt;now&gt;');
    expect(html).toContain('maxlength="200"');
    expect(html).toContain('data-edit-save');
    expect(html).toContain('data-edit-cancel');
    expect(goalEditor('notes', '')).toContain('maxlength="600"');
  });

  it('builds the PATCH body by id, falling back to the title', () => {
    expect(goalEditPayload({ id: 'g-1', title: 'T' }, 'title', '  New  ')).toEqual({
      id: 'g-1',
      title: 'New',
    });
    expect(goalEditPayload({ id: '', title: 'T' }, 'notes', 'n')).toEqual({
      goal: 'T',
      notes: 'n',
    });
    expect(goalEditPayload({ id: 'g-1', title: 'T' }, 'title', '   ')).toBeNull();
    expect(goalEditPayload({ id: 'g-1', title: 'T' }, 'notes', '')).toEqual({
      id: 'g-1',
      notes: '',
    });
  });
});
