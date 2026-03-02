import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Hono } from 'hono';
import type { BotConfig, Config } from '../../../src/config';
import type { Logger } from '../../../src/logger';
import { AgentProposalStore } from '../../../src/tools/agent-proposal-store';
import { agentProposalRoutes } from '../../../src/web/routes/agent-proposals';

const noopLogger: Logger = {
  info: () => {},
  warn: () => {},
  debug: () => {},
  error: () => {},
  child: () => noopLogger,
};

const TEST_DIR = join(process.cwd(), '.test-agent-proposals-routes');

function createTestConfig(): Config {
  return {
    bots: [
      {
        id: 'bot-1',
        name: 'Bot One',
        skills: [],
        token: '',
        enabled: true,
        disabledSkills: [],
        plan: 'free',
      },
    ],
    soul: { dir: join(TEST_DIR, 'soul') },
    ollama: { baseUrl: 'http://localhost:11434', models: { primary: 'llama3' } },
    conversation: {
      systemPrompt: 'You are a helpful assistant.',
      temperature: 0.7,
      maxHistory: 20,
    },
    productions: { baseDir: join(TEST_DIR, 'productions') },
  } as unknown as Config;
}

function createTestConfigPath(): string {
  const configPath = join(TEST_DIR, 'config.json');
  const botsPath = join(TEST_DIR, 'bots.json');
  const bots = [{ id: 'bot-1', name: 'Bot One', skills: [], token: '', enabled: true }];
  writeFileSync(configPath, JSON.stringify({}, null, 2), 'utf-8');
  writeFileSync(botsPath, JSON.stringify(bots, null, 2), 'utf-8');
  return configPath;
}

function makeApp() {
  const storePath = join(TEST_DIR, 'proposals');
  const store = new AgentProposalStore(storePath);
  const config = createTestConfig();
  const configPath = createTestConfigPath();

  const app = new Hono();
  app.route(
    '/api/agent-proposals',
    agentProposalRoutes({ store, config, configPath, logger: noopLogger })
  );

  return { app, store, config, configPath };
}

function addProposal(store: AgentProposalStore, overrides: Partial<Record<string, unknown>> = {}) {
  return store.create({
    agentId: (overrides.agentId as string) ?? 'test-agent',
    agentName: (overrides.agentName as string) ?? 'TestAgent',
    role: (overrides.role as string) ?? 'Testing',
    personalityDescription:
      (overrides.personalityDescription as string) ??
      'A thorough tester who loves finding bugs and ensuring quality in everything.',
    skills: (overrides.skills as string[]) ?? [],
    justification: (overrides.justification as string) ?? 'We need a dedicated testing agent.',
    proposedBy: (overrides.proposedBy as string) ?? 'bot-1',
  });
}

describe('agent proposal routes', () => {
  beforeEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  test('GET / returns empty list initially', async () => {
    const { app } = makeApp();
    const res = await app.request('http://localhost/api/agent-proposals');
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(Array.isArray(data)).toBe(true);
    expect(data.length).toBe(0);
  });

  test('GET / returns proposals', async () => {
    const { app, store } = makeApp();
    addProposal(store);
    addProposal(store, { agentId: 'agent-two', agentName: 'AgentTwo' });

    const res = await app.request('http://localhost/api/agent-proposals');
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.length).toBe(2);
  });

  test('GET /count returns pending count', async () => {
    const { app, store } = makeApp();
    addProposal(store);
    addProposal(store, { agentId: 'agent-two' });
    store.updateStatus(store.list()[0].id, 'approved');

    const res = await app.request('http://localhost/api/agent-proposals/count');
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.count).toBe(1);
  });

  test('POST /:id/reject rejects proposal', async () => {
    const { app, store } = makeApp();
    const proposal = addProposal(store);

    const res = await app.request(`http://localhost/api/agent-proposals/${proposal.id}/reject`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ note: 'Not needed right now' }),
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.status).toBe('rejected');
    expect(data.rejectionNote).toBe('Not needed right now');
  });

  test('POST /:id/reject returns 404 for unknown proposal', async () => {
    const { app } = makeApp();
    const res = await app.request('http://localhost/api/agent-proposals/nonexistent/reject', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(404);
  });

  test('POST /:id/reject returns 400 for already resolved', async () => {
    const { app, store } = makeApp();
    const proposal = addProposal(store);
    store.updateStatus(proposal.id, 'rejected');

    const res = await app.request(`http://localhost/api/agent-proposals/${proposal.id}/reject`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  test('DELETE /:id removes proposal', async () => {
    const { app, store } = makeApp();
    const proposal = addProposal(store);

    const res = await app.request(`http://localhost/api/agent-proposals/${proposal.id}`, {
      method: 'DELETE',
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);

    // Verify gone
    expect(store.get(proposal.id)).toBeNull();
  });

  test('DELETE /:id returns 404 for unknown', async () => {
    const { app } = makeApp();
    const res = await app.request('http://localhost/api/agent-proposals/nonexistent', {
      method: 'DELETE',
    });
    expect(res.status).toBe(404);
  });

  test('POST /:id/approve returns 409 if bot ID already exists in config', async () => {
    const { app, store } = makeApp();
    const proposal = addProposal(store, { agentId: 'bot-1' }); // same as existing bot

    const res = await app.request(`http://localhost/api/agent-proposals/${proposal.id}/approve`, {
      method: 'POST',
    });

    expect(res.status).toBe(409);
    const data = await res.json();
    expect(data.error).toContain('already exists');
  });

  test('POST /:id/approve creates bot config and updates proposal', async () => {
    const { app, store, config } = makeApp();
    const proposal = addProposal(store, { agentId: 'new-agent', agentName: 'NewAgent' });

    const res = await app.request(`http://localhost/api/agent-proposals/${proposal.id}/approve`, {
      method: 'POST',
    });

    expect(res.status).toBe(200);
    const data = await res.json();

    // Proposal should be approved
    expect(data.proposal.status).toBe('approved');
    expect(data.proposal.approvalResult.configCreated).toBe(true);

    // Config should have the new bot
    const newBot = config.bots.find((b: BotConfig) => b.id === 'new-agent');
    expect(newBot).toBeTruthy();
    expect(newBot!.name).toBe('NewAgent');
    expect(newBot!.enabled).toBe(false);
    expect(newBot!.token).toBe('');

    // Soul dir should exist with at least IDENTITY.md
    const soulDir = data.soulDir;
    expect(existsSync(join(soulDir, 'IDENTITY.md'))).toBe(true);

    // Soul generation may or may not succeed depending on Claude CLI availability
    // The important thing is the agent was created regardless
    expect(typeof data.soulGenerated).toBe('boolean');
  }, 60_000); // Extended timeout: soul generation may call Claude CLI

  test('POST /:id/approve returns 404 for unknown', async () => {
    const { app } = makeApp();
    const res = await app.request('http://localhost/api/agent-proposals/nonexistent/approve', {
      method: 'POST',
    });
    expect(res.status).toBe(404);
  });
});
