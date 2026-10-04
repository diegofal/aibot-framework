import { describe, expect, it } from 'bun:test';
import { Hono } from 'hono';
import {
  NEEDS_YOU_KINDS,
  type NeedsYouItem,
  type NeedsYouSources,
  buildNeedsYou,
  needsYouRoutes,
  sortNeedsYou,
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

function sources(over: Partial<NeedsYouSources> = {}): NeedsYouSources {
  return {
    asks: () => [],
    conversations: null,
    permissions: () => [],
    proposals: () => [],
    productions: () => [],
    feedback: { botIds: () => [], list: () => [] },
    ...over,
  };
}

function makeApp(src: NeedsYouSources, tenantId?: string) {
  const app = new Hono();
  if (tenantId) {
    app.use('*', async (c, next) => {
      c.set('tenant', { tenantId, apiKey: 'k', plan: 'pro' });
      return next();
    });
  }
  app.route(
    '/api/needs-you',
    needsYouRoutes({ config, logger: noopLogger, sources: src, now: () => NOW })
  );
  return app;
}

const ask = (id: string, botId: string, ageH: number, options?: string[]) => ({
  id,
  botId,
  chatId: 0,
  question: `Question ${id}: should I ship?`,
  createdAt: NOW - ageH * H,
  ...(options ? { options } : {}),
});

const permission = (id: string, botId: string, urgency: string, ageH: number) => ({
  id,
  botId,
  action: 'file_write',
  resource: `/tmp/${id}.md`,
  description: `Write ${id}`,
  urgency: urgency as never,
  status: 'pending' as const,
  createdAt: NOW - ageH * H,
});

const proposal = (id: string, proposedBy: string, status = 'pending', ageH = 1) => ({
  id,
  agentId: `agent-${id}`,
  agentName: `Agent ${id}`,
  role: 'Researcher',
  personalityDescription: 'Curious & <bold>',
  skills: ['web_search'],
  justification: 'Because',
  proposedBy,
  status: status as never,
  createdAt: iso(NOW - ageH * H),
  updatedAt: iso(NOW - ageH * H),
});

const production = (
  id: string,
  botId: string,
  path: string,
  ageH: number,
  extra: Record<string, unknown> = {}
) => ({
  id,
  timestamp: iso(NOW - ageH * H),
  botId,
  tool: 'file_write',
  path,
  action: 'create' as const,
  description: `Wrote ${path}`,
  size: 120,
  trackOnly: false,
  ...extra,
});

const feedbackEntry = (
  id: string,
  botId: string,
  thread: Array<{ role: 'human' | 'bot'; content: string; ageH: number }>,
  status = 'pending'
) => ({
  id,
  botId,
  content: 'Stop writing summaries',
  createdAt: iso(NOW - 10 * H),
  status: status as never,
  thread: thread.map((m, i) => ({
    id: `${id}-m${i}`,
    role: m.role,
    content: m.content,
    createdAt: iso(NOW - m.ageH * H),
  })),
});

describe('GET /api/needs-you', () => {
  it('returns the empty state with zero counts', async () => {
    const res = await makeApp(sources()).request('/api/needs-you');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items).toEqual([]);
    expect(body.count).toBe(0);
    expect(body.byKind).toEqual({
      ask: 0,
      permission: 0,
      proposal: 0,
      production: 0,
      feedback: 0,
      tool: 0,
    });
    expect(typeof body.generatedAt).toBe('string');
  });

  it('merges the five sources, most urgent first then newest first', async () => {
    const src = sources({
      asks: () => [ask('q-old', 'b1', 5), ask('q-new', 'b1', 1)],
      permissions: () => [
        permission('p-high', 'b1', 'high', 30),
        permission('p-low', 'b1', 'low', 0),
      ],
      proposals: () => [proposal('pr1', 'b1')],
      productions: () => [production('f1', 'b1', 'notes/a.md', 2)],
      feedback: {
        botIds: () => ['b1'],
        list: () => [
          feedbackEntry('fb1', 'b1', [
            { role: 'human', content: 'hi', ageH: 3 },
            { role: 'bot', content: 'Understood, I will stop.', ageH: 2 },
          ]),
        ],
      },
    });
    const body = await (await makeApp(src).request('/api/needs-you')).json();
    const ids = body.items.map((i: NeedsYouItem) => i.id);
    expect(ids).toEqual([
      'permission:p-high',
      'ask:q-new',
      'feedback:b1:fb1',
      'ask:q-old',
      'permission:p-low',
      'proposal:pr1',
      'production:b1:f1',
    ]);
    expect(body.count).toBe(7);
    expect(body.byKind).toEqual({
      ask: 2,
      permission: 2,
      proposal: 1,
      production: 1,
      feedback: 1,
      tool: 0,
    });
  });

  it('every item carries the frozen shape and a hotkey pair', async () => {
    const src = sources({
      asks: () => [ask('q1', 'b1', 1, ['Yes', 'No'])],
      permissions: () => [permission('p1', 'b1', 'normal', 1)],
      proposals: () => [proposal('pr1', 'b1')],
      productions: () => [production('f1', 'b1', 'a.md', 1)],
      feedback: {
        botIds: () => ['b1'],
        list: () => [feedbackEntry('fb1', 'b1', [{ role: 'bot', content: 'ok', ageH: 1 }])],
      },
    });
    const body = await (await makeApp(src).request('/api/needs-you')).json();
    expect(body.items).toHaveLength(5);
    for (const item of body.items as NeedsYouItem[]) {
      expect(Object.keys(item).sort()).toEqual(
        [
          'actions',
          'body',
          'botId',
          'botName',
          'createdAt',
          'href',
          'id',
          'kind',
          'meta',
          'options',
          'title',
          'urgency',
        ].sort()
      );
      expect(NEEDS_YOU_KINDS).toContain(item.kind);
      expect(item.botName).toBe('Bot One');
      expect(Number.isFinite(Date.parse(item.createdAt))).toBe(true);
      expect(['high', 'normal', 'low']).toContain(item.urgency);
      expect(item.href.startsWith('#/')).toBe(true);
      const hotkeys = item.actions.map((a) => a.hotkey);
      expect(hotkeys).toContain('a');
      expect(hotkeys).toContain('d');
      for (const a of item.actions) {
        expect(a.path.startsWith('/api/')).toBe(true);
        expect(['POST', 'DELETE']).toContain(a.method);
      }
    }
    const askItem = body.items.find((i: NeedsYouItem) => i.kind === 'ask');
    expect(askItem.options).toEqual(['Yes', 'No']);
    const other = body.items.find((i: NeedsYouItem) => i.kind === 'permission');
    expect(other.options).toBeNull();
  });

  it('scopes items to the tenant and lets the admin see everything', async () => {
    const src = sources({
      asks: () => [ask('q1', 'b1', 1), ask('q2', 'b2', 1)],
      permissions: () => [permission('p2', 'b2', 'high', 1)],
      proposals: () => [proposal('pr1', 'b1'), proposal('pr2', 'b2')],
      productions: () => [production('f1', 'b1', 'a.md', 1), production('f2', 'b2', 'b.md', 1)],
      feedback: {
        botIds: () => ['b1', 'b2'],
        list: (botId) => [
          feedbackEntry(`fb-${botId}`, botId, [{ role: 'bot', content: 'x', ageH: 1 }]),
        ],
      },
    });
    const t1 = await (await makeApp(src, 't1').request('/api/needs-you')).json();
    expect(t1.items.every((i: NeedsYouItem) => i.botId === 'b1')).toBe(true);
    expect(t1.count).toBe(4);

    const admin = await (await makeApp(src, '__admin__').request('/api/needs-you')).json();
    expect(admin.count).toBe(9);

    const single = await (await makeApp(src).request('/api/needs-you')).json();
    expect(single.count).toBe(9);

    const count = await (await makeApp(src, 't2').request('/api/needs-you/count')).json();
    expect(count).toEqual({
      count: 5,
      byKind: { ask: 1, permission: 1, proposal: 1, production: 1, feedback: 1, tool: 0 },
    });
  });
});

describe('asks', () => {
  const conversations = {
    getBotIds: () => ['b1', 'ghost'],
    listConversations: (botId: string) =>
      botId === 'b1'
        ? [
            {
              id: 'c-live',
              botId: 'b1',
              type: 'inbox' as const,
              title: 'Ship it?',
              createdAt: iso(NOW - 2 * H),
              updatedAt: iso(NOW - 2 * H),
              messageCount: 1,
              askHumanQuestionId: 'q-live',
              inboxStatus: 'pending' as const,
              askOptions: ['Ship', 'Wait'],
            },
            {
              id: 'c-orphan',
              botId: 'b1',
              type: 'inbox' as const,
              title: 'Old question',
              createdAt: iso(NOW - 90 * H),
              updatedAt: iso(NOW - 90 * H),
              messageCount: 1,
              askHumanQuestionId: 'q-gone',
              inboxStatus: 'pending' as const,
            },
            {
              id: 'c-done',
              botId: 'b1',
              type: 'inbox' as const,
              title: 'Answered',
              createdAt: iso(NOW - 3 * H),
              updatedAt: iso(NOW - 3 * H),
              messageCount: 2,
              inboxStatus: 'answered' as const,
            },
          ]
        : [],
    getMessages: (_botId: string, id: string) =>
      id === 'c-live'
        ? [
            {
              id: 'm1',
              role: 'bot' as const,
              content: 'Full question text with <b>markup</b>. Ship the digest today?',
              files: [{ path: 'digest.md', size: 10 }],
              createdAt: iso(NOW - 2 * H),
            },
          ]
        : [],
  };

  it('reads pending inbox conversations and enriches them with the live question', async () => {
    const src = sources({
      asks: () => [ask('q-live', 'b1', 2, ['Ship', 'Wait']), ask('q-store-only', 'b1', 1)],
      conversations,
    });
    const body = await (await makeApp(src).request('/api/needs-you')).json();
    const asks = body.items.filter((i: NeedsYouItem) => i.kind === 'ask');
    expect(asks.map((i: NeedsYouItem) => i.id).sort()).toEqual([
      'ask:c-live',
      'ask:c-orphan',
      'ask:q-store-only',
    ]);

    const live = asks.find((i: NeedsYouItem) => i.id === 'ask:c-live');
    expect(live.title).toBe('Ship it?');
    expect(live.body).toContain('Full question text with <b>markup</b>');
    expect(live.options).toEqual(['Ship', 'Wait']);
    expect(live.href).toBe('#/needs/inbox/b1/c-live');
    expect(live.meta).toMatchObject({ live: true, conversationId: 'c-live', questionId: 'q-live' });
    expect(live.meta.files).toEqual(['digest.md']);
    const answer = live.actions.find((a) => a.id === 'answer');
    expect(answer).toMatchObject({
      method: 'POST',
      path: '/api/conversations/b1/c-live/messages',
      hotkey: 'a',
      input: { field: 'message', required: true },
    });
    expect(live.actions.find((a) => a.id === 'dismiss')).toMatchObject({
      method: 'DELETE',
      path: '/api/ask-human/q-live',
      hotkey: 'd',
    });

    // The question that outlived its process: still answerable through the
    // conversation; d closes it, deleting needs an explicit confirm.
    const orphan = asks.find((i: NeedsYouItem) => i.id === 'ask:c-orphan');
    expect(orphan.meta.live).toBe(false);
    expect(orphan.body).toBe('Old question');
    expect(orphan.actions.find((a) => a.id === 'dismiss')).toMatchObject({
      method: 'POST',
      path: '/api/needs-you/act',
      body: { id: 'ask:c-orphan', action: 'dismiss' },
    });
    expect(orphan.actions.find((a) => a.id === 'delete')).toMatchObject({
      method: 'DELETE',
      path: '/api/conversations/b1/c-orphan',
    });

    // A live question with no conversation falls back to the ask-human routes.
    const storeOnly = asks.find((i: NeedsYouItem) => i.id === 'ask:q-store-only');
    expect(storeOnly.actions.find((a) => a.id === 'answer')).toMatchObject({
      path: '/api/ask-human/q-store-only/answer',
      input: { field: 'answer', required: true },
    });
    expect(storeOnly.href).toBe('#/needs/inbox');
  });

  it('falls back to the in-memory store when there is no conversations service', async () => {
    const src = sources({ asks: () => [ask('q1', 'b1', 1)] });
    const body = await (await makeApp(src).request('/api/needs-you')).json();
    expect(body.items).toHaveLength(1);
    expect(body.items[0].id).toBe('ask:q1');
    expect(body.items[0].actions.map((a: { path: string }) => a.path)).toEqual([
      '/api/ask-human/q1/answer',
      '/api/ask-human/q1',
    ]);
  });
});

describe('productions', () => {
  it('lists one item per still-active unreviewed file and skips evaluated or archived ones', async () => {
    const src = sources({
      productions: () => [
        production('f1', 'b1', 'a.md', 10),
        production('f2', 'b1', 'a.md', 5, { action: 'edit', description: 'Edited a.md' }),
        production('f3', 'b1', 'b.md', 4, {
          evaluation: { status: 'approved', evaluatedAt: iso(NOW) },
        }),
        production('f4', 'b1', 'c.md', 3),
        production('f5', 'b1', 'archive/c.md', 2, { action: 'archive', archivedFrom: 'c.md' }),
        production('f6', 'b1', 'd.md', 6),
        production('f7', 'b1', 'd.md', 1, { action: 'delete' }),
        production('f8', 'b1', 'e.md', 1, { evaluation: { evaluatedAt: iso(NOW) } }),
      ],
    });
    const body = await (await makeApp(src).request('/api/needs-you')).json();
    const items = body.items as NeedsYouItem[];
    expect(items.map((i) => i.id).sort()).toEqual(['production:b1:f2', 'production:b1:f8']);
    const edited = items.find((i) => i.id === 'production:b1:f2');
    expect(edited?.title).toBe('a.md');
    expect(edited?.body).toContain('Edited a.md');
    expect(edited?.href).toBe('#/work/productions/b1?file=a.md');
    expect(edited?.actions.find((a) => a.id === 'approve')).toMatchObject({
      path: '/api/productions/b1/f2/evaluate',
      body: { status: 'approved' },
      hotkey: 'a',
      input: { field: 'feedback', required: false },
    });
    expect(edited?.actions.find((a) => a.id === 'reject')).toMatchObject({
      body: { status: 'rejected' },
      hotkey: 'd',
    });
  });
});

describe('feedback', () => {
  it('only surfaces pending threads where the bot spoke last', async () => {
    const src = sources({
      feedback: {
        botIds: () => ['b1'],
        list: () => [
          feedbackEntry('waiting-on-bot', 'b1', [{ role: 'human', content: 'hi', ageH: 1 }]),
          feedbackEntry('bot-replied', 'b1', [
            { role: 'human', content: 'hi', ageH: 2 },
            { role: 'bot', content: 'I will change <that>.', ageH: 1 },
          ]),
          feedbackEntry('applied', 'b1', [{ role: 'bot', content: 'x', ageH: 1 }], 'applied'),
          {
            id: 'legacy',
            botId: 'b1',
            content: 'Legacy feedback',
            createdAt: iso(NOW - 4 * H),
            status: 'pending' as const,
            response: 'Legacy reply without a thread',
          },
          {
            id: 'untouched',
            botId: 'b1',
            content: 'Nobody replied',
            createdAt: iso(NOW - 4 * H),
            status: 'pending' as const,
          },
        ],
      },
    });
    const body = await (await makeApp(src).request('/api/needs-you')).json();
    const items = body.items as NeedsYouItem[];
    expect(items.map((i) => i.id).sort()).toEqual([
      'feedback:b1:bot-replied',
      'feedback:b1:legacy',
    ]);
    const replied = items.find((i) => i.id === 'feedback:b1:bot-replied');
    expect(replied?.body).toBe('I will change <that>.');
    expect(replied?.title).toContain('Stop writing summaries');
    expect(replied?.createdAt).toBe(iso(NOW - H));
    expect(replied?.href).toBe('#/needs/feedback/b1');
    expect(replied?.actions.find((a) => a.id === 'reply')).toMatchObject({
      path: '/api/agent-feedback/b1/bot-replied/reply',
      input: { field: 'message', required: true },
      hotkey: 'a',
    });
    expect(replied?.actions.find((a) => a.id === 'dismiss')).toMatchObject({
      method: 'DELETE',
      path: '/api/agent-feedback/b1/bot-replied',
      hotkey: 'd',
    });
  });
});

describe('proposals and permissions', () => {
  it('maps proposals (pending only) and permissions with their own urgency', async () => {
    const src = sources({
      proposals: () => [proposal('ok', 'b1'), proposal('done', 'b1', 'approved')],
      permissions: () => [permission('p1', 'b1', 'weird', 1)],
    });
    const body = await (await makeApp(src).request('/api/needs-you')).json();
    const items = body.items as NeedsYouItem[];
    expect(items.map((i) => i.id).sort()).toEqual(['permission:p1', 'proposal:ok']);
    const pr = items.find((i) => i.kind === 'proposal');
    expect(pr?.title).toContain('Agent ok');
    expect(pr?.body).toContain('Curious & <bold>');
    expect(pr?.urgency).toBe('low');
    expect(pr?.actions.map((a) => [a.id, a.method, a.path])).toEqual([
      ['approve', 'POST', '/api/agent-proposals/ok/approve'],
      ['reject', 'POST', '/api/agent-proposals/ok/reject'],
    ]);
    const perm = items.find((i) => i.kind === 'permission');
    expect(perm?.urgency).toBe('normal');
    expect(perm?.title).toBe('file_write → /tmp/p1.md');
    expect(perm?.actions.map((a) => a.path)).toEqual([
      '/api/ask-permission/p1/approve',
      '/api/ask-permission/p1/deny',
    ]);
  });

  it('returns nothing for proposals when the store is disabled', async () => {
    const src = sources({ proposals: undefined });
    const body = await (await makeApp(src).request('/api/needs-you')).json();
    expect(body.byKind.proposal).toBe(0);
  });
});

describe('robustness', () => {
  it('never throws on malformed rows or throwing sources', async () => {
    const src = sources({
      asks: () => [
        ask('good', 'b1', 1),
        { id: null, botId: 'b1', question: 5, createdAt: 'nope' } as never,
        null as never,
      ],
      permissions: () => {
        throw new Error('store exploded');
      },
      proposals: () => [{ id: 'p', status: 'pending', proposedBy: 'b1' } as never],
      productions: () => [
        { id: 'x', botId: 'b1', path: 42, action: 'create', timestamp: 'garbage' } as never,
        production('ok', 'b1', 'fine.md', 1),
      ],
      feedback: {
        botIds: () => ['b1'],
        list: () => [{ id: 'f', botId: 'b1', status: 'pending', thread: 'not-an-array' } as never],
      },
      conversations: {
        getBotIds: () => ['b1'],
        listConversations: () => [{ id: 'c1', inboxStatus: 'pending' } as never],
        getMessages: () => {
          throw new Error('disk');
        },
      },
    });
    const res = await makeApp(src).request('/api/needs-you');
    expect(res.status).toBe(200);
    const body = await res.json();
    const ids = body.items.map((i: NeedsYouItem) => i.id);
    expect(ids).toContain('ask:good');
    expect(ids).toContain('proposal:p');
    expect(ids).toContain('production:b1:ok');
    expect(ids).toContain('ask:c1');
    expect(body.byKind.permission).toBe(0);
    for (const item of body.items as NeedsYouItem[]) {
      expect(typeof item.title).toBe('string');
      expect(typeof item.body).toBe('string');
      expect(Number.isFinite(Date.parse(item.createdAt))).toBe(true);
    }
  });

  it('count never throws either', async () => {
    const src = sources({
      asks: () => {
        throw new Error('boom');
      },
    });
    const res = await makeApp(src).request('/api/needs-you/count');
    expect(res.status).toBe(200);
    expect((await res.json()).count).toBe(0);
  });
});

describe('pure helpers', () => {
  it('sortNeedsYou orders by urgency then createdAt desc and is stable on ties', () => {
    const mk = (id: string, urgency: NeedsYouItem['urgency'], ageH: number): NeedsYouItem =>
      ({ id, urgency, createdAt: iso(NOW - ageH * H) }) as NeedsYouItem;
    const sorted = sortNeedsYou([
      mk('low-new', 'low', 0),
      mk('normal-old', 'normal', 9),
      mk('high', 'high', 50),
      mk('normal-new', 'normal', 1),
      mk('normal-new-2', 'normal', 1),
    ]);
    expect(sorted.map((i) => i.id)).toEqual([
      'high',
      'normal-new',
      'normal-new-2',
      'normal-old',
      'low-new',
    ]);
  });

  it('buildNeedsYou is usable without HTTP', () => {
    const items = buildNeedsYou(
      { config, logger: noopLogger, sources: sources({ asks: () => [ask('q', 'b2', 1)] }) },
      undefined,
      NOW
    );
    expect(items).toHaveLength(1);
    expect(items[0].botName).toBe('Bot Two');
    expect(
      buildNeedsYou(
        { config, logger: noopLogger, sources: sources({ asks: () => [ask('q', 'b2', 1)] }) },
        new Set(['b1']),
        NOW
      )
    ).toEqual([]);
  });
});
