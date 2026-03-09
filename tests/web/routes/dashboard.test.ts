import { describe, expect, it } from 'bun:test';
import { Hono } from 'hono';
import { dashboardRoutes } from '../../../src/web/routes/dashboard';

const noopLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  child: () => noopLogger,
} as any;

function makeMockBotManager(
  overrides: Partial<{
    askHumanCount: number;
    feedbackCount: number;
    permissionsCount: number;
    proposals: { status: string }[];
  }> = {}
) {
  return {
    getConversationsService: () => null,
    getAskHumanCount: () => overrides.askHumanCount ?? 0,
    getAskHumanPending: () => [],
    getAgentFeedbackPendingCount: () => overrides.feedbackCount ?? 0,
    getPermissionsCount: () => overrides.permissionsCount ?? 0,
    getPermissionsPending: () => [],
    getAgentProposalStore: () =>
      overrides.proposals ? { list: () => overrides.proposals! } : null,
  } as any;
}

const mockConfig = { bots: [] } as any;

describe('GET /badges', () => {
  it('returns all badge counts in a single response', async () => {
    const botManager = makeMockBotManager({
      askHumanCount: 3,
      feedbackCount: 1,
      permissionsCount: 2,
      proposals: [{ status: 'pending' }, { status: 'approved' }, { status: 'pending' }],
    });

    const app = new Hono();
    app.route(
      '/api/dashboard',
      dashboardRoutes({ config: mockConfig, botManager, logger: noopLogger })
    );

    const res = await app.request('/api/dashboard/badges');
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.askHuman).toBe(3);
    expect(body.agentFeedback).toBe(1);
    expect(body.askPermission).toBe(2);
    expect(body.agentProposals).toBe(2); // 2 pending out of 3
  });

  it('returns zeros when no pending items', async () => {
    const botManager = makeMockBotManager();

    const app = new Hono();
    app.route(
      '/api/dashboard',
      dashboardRoutes({ config: mockConfig, botManager, logger: noopLogger })
    );

    const res = await app.request('/api/dashboard/badges');
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.askHuman).toBe(0);
    expect(body.agentFeedback).toBe(0);
    expect(body.askPermission).toBe(0);
    expect(body.agentProposals).toBe(0);
  });

  it('returns 0 proposals when store is null', async () => {
    const botManager = makeMockBotManager();

    const app = new Hono();
    app.route(
      '/api/dashboard',
      dashboardRoutes({ config: mockConfig, botManager, logger: noopLogger })
    );

    const res = await app.request('/api/dashboard/badges');
    const body = (await res.json()) as any;
    expect(body.agentProposals).toBe(0);
  });
});
