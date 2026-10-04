import { describe, expect, it } from 'bun:test';
import { Hono } from 'hono';
import {
  type NeedsYouActionHandlers,
  type NeedsYouItem,
  type NeedsYouSources,
  needsYouRoutes,
} from '../../../src/web/routes/needs-you';

const noopLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  child: () => noopLogger,
} as never;

const NOW = Date.UTC(2026, 8, 14, 12, 0, 0);
const H = 3_600_000;
const iso = (ms: number) => new Date(ms).toISOString();

const config = {
  bots: [
    { id: 'b1', name: 'Bot One', tenantId: 't1' },
    { id: 'b2', name: 'Bot Two', tenantId: 't2' },
  ],
} as never;

type Call = [string, ...unknown[]];

function recorder(over: Partial<NeedsYouActionHandlers> = {}) {
  const calls: Call[] = [];
  const handlers: NeedsYouActionHandlers = {
    dismissAsk: (qid) => {
      calls.push(['dismissAsk', qid]);
      return true;
    },
    closeInboxConversation: (botId, convId) => {
      calls.push(['closeInboxConversation', botId, convId]);
      return true;
    },
    denyPermission: (id) => {
      calls.push(['denyPermission', id]);
      return true;
    },
    rejectProposal: (id) => {
      calls.push(['rejectProposal', id]);
      return true;
    },
    dismissFeedback: (botId, id) => {
      calls.push(['dismissFeedback', botId, id]);
      return true;
    },
    evaluateProduction: (botId, id, status) => {
      calls.push(['evaluateProduction', botId, id, status]);
      return true;
    },
    archiveProduction: (botId, id) => {
      calls.push(['archiveProduction', botId, id]);
      return true;
    },
    approveTool: (id) => {
      calls.push(['approveTool', id]);
      return true;
    },
    rejectTool: (id) => {
      calls.push(['rejectTool', id]);
      return true;
    },
    deleteTool: (id) => {
      calls.push(['deleteTool', id]);
      return true;
    },
    ...over,
  };
  return { calls, handlers };
}

const conversation = (id: string, botId: string, ageH: number, questionId?: string) => ({
  id,
  botId,
  type: 'inbox',
  title: `Conv ${id}`,
  createdAt: iso(NOW - ageH * H),
  updatedAt: iso(NOW - ageH * H),
  messageCount: 1,
  inboxStatus: 'pending',
  ...(questionId ? { askHumanQuestionId: questionId } : {}),
});

function fullSources(): NeedsYouSources {
  return {
    asks: () => [
      { id: 'q-live', botId: 'b1', chatId: 0, question: 'Live?', createdAt: NOW - 100 * H },
      { id: 'q-store', botId: 'b1', chatId: 0, question: 'Store only?', createdAt: NOW - 1 * H },
    ],
    conversations: {
      getBotIds: () => ['b1', 'b2'],
      listConversations: (botId) =>
        (botId === 'b1'
          ? [conversation('c-live', 'b1', 100, 'q-live'), conversation('c-orphan', 'b1', 200)]
          : [conversation('c-b2', 'b2', 200)]) as never,
      getMessages: () => [],
    },
    permissions: () => [
      {
        id: 'p1',
        botId: 'b1',
        action: 'file_write',
        resource: '/x',
        description: 'x',
        urgency: 'normal',
        status: 'pending',
        createdAt: NOW - 90 * H,
      } as never,
    ],
    proposals: () => [
      {
        id: 'pr1',
        agentId: 'a1',
        agentName: 'A1',
        role: 'r',
        personalityDescription: 'p',
        skills: [],
        justification: 'j',
        proposedBy: 'b1',
        status: 'pending',
        createdAt: iso(NOW - 80 * H),
        updatedAt: iso(NOW - 80 * H),
      } as never,
    ],
    productions: () => [
      {
        id: 'f1',
        timestamp: iso(NOW - 75 * H),
        botId: 'b1',
        tool: 'file_write',
        path: 'notes/a b.md',
        action: 'create',
        description: 'Wrote',
        size: 1,
        trackOnly: false,
      } as never,
      {
        id: 'f2',
        timestamp: iso(NOW - 2 * H),
        botId: 'b1',
        tool: 'file_write',
        path: 'fresh.md',
        action: 'create',
        description: 'Wrote',
        size: 1,
        trackOnly: false,
      } as never,
    ],
    feedback: {
      botIds: () => ['b1'],
      list: () =>
        [
          {
            id: 'fb1',
            botId: 'b1',
            content: 'c',
            status: 'pending',
            createdAt: iso(NOW - 99 * H),
            thread: [{ role: 'bot', content: 'reply', createdAt: iso(NOW - 99 * H) }],
          },
        ] as never,
    },
    tools: () => [
      {
        id: 't-pending',
        name: 'scraper',
        description: 'Scrapes',
        type: 'typescript',
        status: 'pending',
        createdBy: 'b1',
        scope: 'all',
        parameters: { url: { type: 'string', description: 'URL', required: true } },
        createdAt: iso(NOW - 120 * H),
        updatedAt: iso(NOW - 120 * H),
      },
      {
        id: 't-done',
        name: 'done',
        description: 'Done',
        type: 'command',
        status: 'approved',
        createdBy: 'b1',
        scope: 'all',
        parameters: {},
        createdAt: iso(NOW - 120 * H),
        updatedAt: iso(NOW - 120 * H),
      },
    ],
  };
}

function makeApp(
  actions: NeedsYouActionHandlers | undefined,
  tenantId?: string,
  src: NeedsYouSources = fullSources()
) {
  const app = new Hono();
  if (tenantId) {
    app.use('*', async (c, next) => {
      c.set('tenant', { tenantId, apiKey: 'k', plan: 'pro' });
      return next();
    });
  }
  app.route(
    '/api/needs-you',
    needsYouRoutes({ config, logger: noopLogger, sources: src, actions, now: () => NOW })
  );
  return app;
}

async function post(app: Hono, path: string, body: unknown) {
  const res = await app.request(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

describe('tool kind', () => {
  it('lists pending dynamic tools for the admin with approve/reject actions', async () => {
    const body = await (await makeApp(undefined).request('/api/needs-you')).json();
    const tools = body.items.filter((i: NeedsYouItem) => i.kind === 'tool');
    expect(tools.map((i: NeedsYouItem) => i.id)).toEqual(['tool:t-pending']);
    expect(body.byKind.tool).toBe(1);
    const t = tools[0] as NeedsYouItem;
    expect(t.botId).toBe('b1');
    expect(t.title).toContain('scraper');
    expect(t.href).toBe('#/automations/tools');
    expect(t.actions.map((a) => [a.id, a.method, a.path, a.hotkey])).toEqual([
      ['approve', 'POST', '/api/tools/t-pending/approve', 'a'],
      ['reject', 'POST', '/api/tools/t-pending/reject', 'd'],
    ]);
    const count = await (await makeApp(undefined).request('/api/needs-you/count')).json();
    expect(count.byKind.tool).toBe(1);
  });

  it('hides tools from tenants (tool management is admin-only)', async () => {
    const body = await (await makeApp(undefined, 't1').request('/api/needs-you')).json();
    expect(body.byKind.tool).toBe(0);
    const admin = await (await makeApp(undefined, '__admin__').request('/api/needs-you')).json();
    expect(admin.byKind.tool).toBe(1);
  });
});

describe('item actions', () => {
  it('production href uses ?file= like the productions page reads', async () => {
    const body = await (await makeApp(undefined).request('/api/needs-you')).json();
    const p = body.items.find((i: NeedsYouItem) => i.id === 'production:b1:f1');
    expect(p.href).toBe('#/work/productions/b1?file=notes%2Fa%20b.md');
  });

  it('production items carry a neutral archive action without a hotkey', async () => {
    const body = await (await makeApp(undefined).request('/api/needs-you')).json();
    const p = body.items.find((i: NeedsYouItem) => i.id === 'production:b1:f1');
    const archive = p.actions.find((a: { id: string }) => a.id === 'archive');
    expect(archive).toMatchObject({
      method: 'POST',
      path: '/api/productions/b1/f1/archive',
      tone: 'muted',
    });
    expect(archive.hotkey).toBeUndefined();
  });

  it('an orphan ask dismisses (closes) on d and deletes only behind a confirm', async () => {
    const body = await (await makeApp(undefined).request('/api/needs-you')).json();
    const orphan = body.items.find((i: NeedsYouItem) => i.id === 'ask:c-orphan');
    const dismiss = orphan.actions.find((a: { id: string }) => a.id === 'dismiss');
    expect(dismiss).toMatchObject({
      label: 'Dismiss',
      method: 'POST',
      path: '/api/needs-you/act',
      body: { id: 'ask:c-orphan', action: 'dismiss' },
      hotkey: 'd',
    });
    const del = orphan.actions.find((a: { id: string }) => a.id === 'delete');
    expect(del).toMatchObject({ method: 'DELETE', path: '/api/conversations/b1/c-orphan' });
    expect(del.hotkey).toBeUndefined();
    expect(typeof del.confirm).toBe('string');
  });
});

describe('POST /api/needs-you/bulk', () => {
  it('validates the body', async () => {
    const app = makeApp(recorder().handlers);
    expect((await post(app, '/api/needs-you/bulk', { ids: [], action: 'dismiss' })).status).toBe(
      400
    );
    expect((await post(app, '/api/needs-you/bulk', { ids: ['x'], action: 'nuke' })).status).toBe(
      400
    );
    expect((await post(app, '/api/needs-you/bulk', { ids: 'x', action: 'dismiss' })).status).toBe(
      400
    );
  });

  it('maps the action per kind through the handlers', async () => {
    const { calls, handlers } = recorder();
    const app = makeApp(handlers);
    const res = await post(app, '/api/needs-you/bulk', {
      ids: ['ask:c-live', 'ask:c-orphan', 'ask:q-store', 'feedback:b1:fb1'],
      action: 'dismiss',
    });
    expect(res.status).toBe(200);
    expect(res.body.results).toEqual([
      { id: 'ask:c-live', ok: true },
      { id: 'ask:c-orphan', ok: true },
      { id: 'ask:q-store', ok: true },
      { id: 'feedback:b1:fb1', ok: true },
    ]);
    expect(calls).toEqual([
      ['dismissAsk', 'q-live'],
      ['closeInboxConversation', 'b1', 'c-orphan'],
      ['dismissAsk', 'q-store'],
      ['dismissFeedback', 'b1', 'fb1'],
    ]);
  });

  it('a live ask whose question vanished falls back to closing the conversation', async () => {
    const { calls, handlers } = recorder({ dismissAsk: () => false });
    const res = await post(makeApp(handlers), '/api/needs-you/bulk', {
      ids: ['ask:c-live'],
      action: 'dismiss',
    });
    expect(res.body.results[0].ok).toBe(true);
    expect(calls).toEqual([['closeInboxConversation', 'b1', 'c-live']]);
  });

  it('rejects unsupported kind/action pairs per item without failing the rest', async () => {
    const { calls, handlers } = recorder();
    const res = await post(makeApp(handlers), '/api/needs-you/bulk', {
      ids: ['production:b1:f1', 'ask:c-live', 'permission:p1', 'nope:1'],
      action: 'approve',
    });
    expect(res.body.results[0]).toEqual({ id: 'production:b1:f1', ok: true });
    expect(res.body.results[1].ok).toBe(false);
    expect(res.body.results[1].error).toContain('ask');
    expect(res.body.results[2].ok).toBe(false);
    expect(res.body.results[3]).toMatchObject({ ok: false, error: 'Not found' });
    expect(calls).toEqual([['evaluateProduction', 'b1', 'f1', 'approved']]);
  });

  it('archive is neutral (no evaluate) and tool approve/reject reach the registry', async () => {
    const { calls, handlers } = recorder();
    const app = makeApp(handlers);
    await post(app, '/api/needs-you/bulk', { ids: ['production:b1:f1'], action: 'archive' });
    await post(app, '/api/needs-you/bulk', { ids: ['tool:t-pending'], action: 'approve' });
    await post(app, '/api/needs-you/bulk', { ids: ['tool:t-pending'], action: 'reject' });
    await post(app, '/api/needs-you/bulk', { ids: ['permission:p1'], action: 'deny' });
    await post(app, '/api/needs-you/bulk', { ids: ['proposal:pr1'], action: 'reject' });
    expect(calls).toEqual([
      ['archiveProduction', 'b1', 'f1'],
      ['approveTool', 't-pending'],
      ['rejectTool', 't-pending'],
      ['denyPermission', 'p1'],
      ['rejectProposal', 'pr1'],
    ]);
  });

  it('neutral resolves to the no-karma negative action of each kind', async () => {
    const { calls, handlers } = recorder();
    const res = await post(makeApp(handlers), '/api/needs-you/bulk', {
      ids: ['permission:p1', 'proposal:pr1', 'production:b1:f1', 'ask:q-store'],
      action: 'neutral',
    });
    expect(res.body.results.every((r: { ok: boolean }) => r.ok)).toBe(true);
    expect(calls).toEqual([
      ['denyPermission', 'p1'],
      ['rejectProposal', 'pr1'],
      ['archiveProduction', 'b1', 'f1'],
      ['dismissAsk', 'q-store'],
    ]);
  });

  it('delete removes tools and is refused for every other kind', async () => {
    const { calls, handlers } = recorder();
    const res = await post(makeApp(handlers), '/api/needs-you/bulk', {
      ids: ['tool:t-pending', 'production:b1:f1'],
      action: 'delete',
    });
    expect(res.status).toBe(200);
    expect(res.body.results[0]).toEqual({ id: 'tool:t-pending', ok: true });
    expect(res.body.results[1].ok).toBe(false);
    expect(res.body.results[1].error).toContain('not supported');
    expect(calls).toEqual([['deleteTool', 't-pending']]);
  });

  it('tools have no neutral action: neutral never rejects code', async () => {
    const { calls, handlers } = recorder();
    const app = makeApp(handlers);
    const res = await post(app, '/api/needs-you/bulk', {
      ids: ['tool:t-pending', 'permission:p1'],
      action: 'neutral',
    });
    expect(res.body.results[0].ok).toBe(false);
    expect(res.body.results[0].error).toContain('tool');
    expect(res.body.results[1].ok).toBe(true);
    expect(calls).toEqual([['denyPermission', 'p1']]);
    const act = await post(app, '/api/needs-you/act', { id: 'tool:t-pending', action: 'neutral' });
    expect(act.status).toBe(400);
    expect(calls.some((c) => c[0] === 'rejectTool')).toBe(false);
  });

  it('reports a handler that returns false or throws as a per-item failure', async () => {
    const { handlers } = recorder({
      denyPermission: () => false,
      rejectProposal: () => {
        throw new Error('disk full');
      },
    });
    const res = await post(makeApp(handlers), '/api/needs-you/bulk', {
      ids: ['permission:p1', 'proposal:pr1'],
      action: 'neutral',
    });
    expect(res.body.results[0]).toMatchObject({ ok: false });
    expect(res.body.results[1]).toEqual({ id: 'proposal:pr1', ok: false, error: 'disk full' });
  });

  it('is tenant-scoped exactly like GET', async () => {
    const { calls, handlers } = recorder();
    const res = await post(makeApp(handlers, 't2'), '/api/needs-you/bulk', {
      ids: ['ask:c-orphan', 'ask:c-b2', 'tool:t-pending'],
      action: 'dismiss',
    });
    expect(res.body.results).toEqual([
      { id: 'ask:c-orphan', ok: false, error: 'Not found' },
      { id: 'ask:c-b2', ok: true },
      { id: 'tool:t-pending', ok: false, error: 'Not found' },
    ]);
    expect(calls).toEqual([['closeInboxConversation', 'b2', 'c-b2']]);
  });

  it('answers 501-style per item when no handlers are wired', async () => {
    const res = await post(makeApp(undefined), '/api/needs-you/bulk', {
      ids: ['permission:p1'],
      action: 'deny',
    });
    expect(res.status).toBe(200);
    expect(res.body.results[0].ok).toBe(false);
  });
});

describe('POST /api/needs-you/act', () => {
  it('runs one action and answers ok', async () => {
    const { calls, handlers } = recorder();
    const res = await post(makeApp(handlers), '/api/needs-you/act', {
      id: 'ask:c-orphan',
      action: 'dismiss',
    });
    expect(res).toEqual({ status: 200, body: { ok: true } });
    expect(calls).toEqual([['closeInboxConversation', 'b1', 'c-orphan']]);
  });

  it('404s an unknown item and 400s a bad action', async () => {
    const app = makeApp(recorder().handlers);
    const missing = await post(app, '/api/needs-you/act', { id: 'ask:nope', action: 'dismiss' });
    expect(missing.status).toBe(404);
    expect(missing.body.error).toBeTruthy();
    const bad = await post(app, '/api/needs-you/act', { id: 'ask:c-orphan', action: 'approve' });
    expect(bad.status).toBe(400);
  });
});

describe('POST /api/needs-you/clear-stale', () => {
  it('requires olderThanHours >= 1 and valid kinds', async () => {
    const app = makeApp(recorder().handlers);
    expect((await post(app, '/api/needs-you/clear-stale', {})).status).toBe(400);
    expect((await post(app, '/api/needs-you/clear-stale', { olderThanHours: 0.5 })).status).toBe(
      400
    );
    expect(
      (await post(app, '/api/needs-you/clear-stale', { olderThanHours: 72, kinds: ['bogus'] }))
        .status
    ).toBe(400);
  });

  it('applies the neutral action to every item older than the cutoff, never approving', async () => {
    const { calls, handlers } = recorder();
    const res = await post(makeApp(handlers), '/api/needs-you/clear-stale', {
      olderThanHours: 72,
    });
    expect(res.status).toBe(200);
    // Old: c-live(100h) c-orphan(200h) c-b2(200h) p1(90h) pr1(80h) f1(75h) fb1(99h); young q-store, f2.
    // Tools are excluded unless asked for explicitly.
    expect(res.body.cleared).toBe(7);
    expect(res.body.byKind).toEqual({
      ask: 3,
      permission: 1,
      proposal: 1,
      production: 1,
      feedback: 1,
      tool: 0,
    });
    expect(res.body.results).toHaveLength(7);
    expect(calls.some((c) => c[0] === 'evaluateProduction' || c[0] === 'approveTool')).toBe(false);
    expect(calls).toContainEqual(['archiveProduction', 'b1', 'f1']);
  });

  it('filters by kinds and botId', async () => {
    const { calls, handlers } = recorder();
    const res = await post(makeApp(handlers), '/api/needs-you/clear-stale', {
      olderThanHours: 1,
      kinds: ['ask', 'permission'],
      botId: 'b1',
    });
    // q-store is exactly 1 h old: "older than" is strict.
    expect(res.body.byKind.ask).toBe(2);
    expect(res.body.byKind.permission).toBe(1);
    expect(res.body.byKind.production).toBe(0);
    expect(calls.some((c) => c[1] === 'b2')).toBe(false);
  });

  it('rejects kinds without a neutral action (tools need an explicit reject)', async () => {
    const { calls, handlers } = recorder();
    const res = await post(makeApp(handlers), '/api/needs-you/clear-stale', {
      olderThanHours: 1,
      kinds: ['ask', 'tool'],
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('tool');
    expect(calls).toEqual([]);
  });

  it('with ids, only clears those ids (still filtered by age and kind)', async () => {
    const { calls, handlers } = recorder();
    const res = await post(makeApp(handlers), '/api/needs-you/clear-stale', {
      olderThanHours: 72,
      // q-store is young, tool is not a neutral kind, nope is unknown: all skipped.
      ids: ['permission:p1', 'ask:c-orphan', 'ask:q-store', 'tool:t-pending', 'nope'],
    });
    expect(res.status).toBe(200);
    expect(res.body.cleared).toBe(2);
    expect(res.body.results.map((r: { id: string }) => r.id)).toEqual([
      'permission:p1',
      'ask:c-orphan',
    ]);
    expect(calls).toEqual([
      ['denyPermission', 'p1'],
      ['closeInboxConversation', 'b1', 'c-orphan'],
    ]);
  });

  it('400s ids that is not a string array', async () => {
    const app = makeApp(recorder().handlers);
    const res = await post(app, '/api/needs-you/clear-stale', { olderThanHours: 72, ids: 'x' });
    expect(res.status).toBe(400);
    const res2 = await post(app, '/api/needs-you/clear-stale', { olderThanHours: 72, ids: [1] });
    expect(res2.status).toBe(400);
  });

  it('counts only successful items as cleared', async () => {
    const { handlers } = recorder({ denyPermission: () => false });
    const res = await post(makeApp(handlers), '/api/needs-you/clear-stale', {
      olderThanHours: 72,
      kinds: ['permission'],
    });
    expect(res.body.cleared).toBe(0);
    expect(res.body.byKind.permission).toBe(0);
    expect(res.body.results[0].ok).toBe(false);
  });
});

describe('needsYouActionsFromBotManager', () => {
  it('routes every handler to the BotManager call the single routes use', async () => {
    const { needsYouActionsFromBotManager } = await import('../../../src/web/routes/needs-you');
    const calls: Call[] = [];
    const rec = <T>(entry: Call, ret: T): T => {
      calls.push(entry);
      return ret;
    };
    const bm = {
      dismissAskHuman: (id: string) => rec(['dismissAskHuman', id], true),
      denyPermission: (id: string, note?: string) => rec(['deny', id, note], true),
      dismissAgentFeedback: (b: string, id: string) => rec(['dismissFb', b, id], true),
      getConversationsService: () => ({
        markInboxStatus: (b: string, c: string, s: string) => rec(['mark', b, c, s], {}),
      }),
      getAgentProposalStore: () => ({
        get: (id: string) => ({ id, status: id === 'done' ? 'approved' : 'pending' }) as never,
        updateStatus: (id: string, s: string, note?: string) => rec(['proposal', id, s, note], {}),
      }),
      getProductionsService: () => ({
        getEntry: (b: string, id: string) =>
          id === 'gone' ? null : ({ path: `${id}.md` } as never),
        archiveFile: (b: string, p: string, r: string) => rec(['archive', b, p, r], true),
        evaluate: (
          b: string,
          id: string,
          body: { status: string },
          soul: unknown,
          karma: unknown
        ) => rec(['evaluate', b, id, body.status, soul, karma], {}),
      }),
      getDynamicToolRegistry: () => ({
        approve: (id: string) => rec(['approveTool', id], {}),
        reject: (id: string, note?: string) => rec(['rejectTool', id, note], null),
      }),
      findSoulLoader: () => 'SOUL',
      getKarmaService: () => 'KARMA',
      getActivityStream: () => 'ACT',
    };
    const h = needsYouActionsFromBotManager(bm);
    expect(h.dismissAsk?.('q1')).toBe(true);
    expect(h.closeInboxConversation?.('b1', 'c1')).toBe(true);
    expect(h.denyPermission?.('p1', 'n')).toBe(true);
    expect(h.rejectProposal?.('pr1', 'n')).toBe(true);
    expect(h.rejectProposal?.('done')).toBe(false);
    expect(h.dismissFeedback?.('b1', 'fb1')).toBe(true);
    expect(h.evaluateProduction?.('b1', 'f1', 'approved')).toBe(true);
    expect(h.archiveProduction?.('b1', 'f1', 'why')).toBe(true);
    expect(h.archiveProduction?.('b1', 'gone', 'why')).toBe(false);
    expect(h.approveTool?.('t1')).toBe(true);
    expect(h.rejectTool?.('t1')).toBe(false);
    expect(calls).toEqual([
      ['dismissAskHuman', 'q1'],
      ['mark', 'b1', 'c1', 'dismissed'],
      ['deny', 'p1', 'n'],
      ['proposal', 'pr1', 'rejected', 'n'],
      ['dismissFb', 'b1', 'fb1'],
      ['evaluate', 'b1', 'f1', 'approved', 'SOUL', 'KARMA'],
      ['archive', 'b1', 'f1.md', 'why'],
      ['approveTool', 't1'],
      ['rejectTool', 't1', undefined],
    ]);
  });
});
