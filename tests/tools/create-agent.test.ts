import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { BotConfig } from '../../src/config';
import type { Logger } from '../../src/logger';
import { AgentProposalStore } from '../../src/tools/agent-proposal-store';
import { createCreateAgentTool } from '../../src/tools/create-agent';

const noopLogger: Logger = {
  info: () => {},
  warn: () => {},
  debug: () => {},
  error: () => {},
  child: () => noopLogger,
};

const TEST_DIR = join(process.cwd(), '.test-create-agent');

function makeValidArgs(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    agent_id: 'content-creator',
    name: 'ContentBot',
    role: 'Content creation and editorial planning',
    personality_description:
      'A creative, enthusiastic content strategist who loves storytelling and helping teams produce engaging content across all formats.',
    skills: ['web-search'],
    justification: 'The ecosystem lacks a dedicated content creation agent for editorial planning.',
    _botId: 'moltbook',
    ...overrides,
  };
}

describe('create_agent tool', () => {
  let store: AgentProposalStore;
  let configBots: BotConfig[];

  beforeEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
    store = new AgentProposalStore(join(TEST_DIR, 'proposals'));
    configBots = [
      {
        id: 'moltbook',
        name: 'MoltBook',
        skills: [],
        token: '',
        enabled: true,
        disabledSkills: [],
        plan: 'free',
      },
      {
        id: 'finny',
        name: 'Finny',
        skills: [],
        token: '',
        enabled: true,
        disabledSkills: [],
        plan: 'free',
      },
    ];
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  test('definition has correct shape', () => {
    const tool = createCreateAgentTool(store, configBots, 20, 3);
    expect(tool.definition.type).toBe('function');
    expect(tool.definition.function.name).toBe('create_agent');
    expect(tool.definition.function.parameters.required).toContain('agent_id');
    expect(tool.definition.function.parameters.required).toContain('name');
    expect(tool.definition.function.parameters.required).toContain('role');
    expect(tool.definition.function.parameters.required).toContain('personality_description');
    expect(tool.definition.function.parameters.required).toContain('skills');
    expect(tool.definition.function.parameters.required).toContain('justification');
  });

  test('missing required fields returns error', async () => {
    const tool = createCreateAgentTool(store, configBots, 20, 3);
    const result = await tool.execute({ _botId: 'moltbook' }, noopLogger);
    expect(result.success).toBe(false);
    expect(result.content).toContain('Missing required');
  });

  test('invalid agent_id format returns error', async () => {
    const tool = createCreateAgentTool(store, configBots, 20, 3);

    // starts with number
    let result = await tool.execute(makeValidArgs({ agent_id: '1bad' }), noopLogger);
    expect(result.success).toBe(false);
    expect(result.content).toContain('agent_id must be');

    // uppercase
    result = await tool.execute(makeValidArgs({ agent_id: 'BadName' }), noopLogger);
    expect(result.success).toBe(false);

    // too short
    result = await tool.execute(makeValidArgs({ agent_id: 'ab' }), noopLogger);
    expect(result.success).toBe(false);
  });

  test('reserved ID returns error', async () => {
    const tool = createCreateAgentTool(store, configBots, 20, 3);
    const result = await tool.execute(makeValidArgs({ agent_id: 'admin' }), noopLogger);
    expect(result.success).toBe(false);
    expect(result.content).toContain('reserved');
  });

  test('duplicate against existing bot returns error', async () => {
    const tool = createCreateAgentTool(store, configBots, 20, 3);
    const result = await tool.execute(makeValidArgs({ agent_id: 'moltbook' }), noopLogger);
    expect(result.success).toBe(false);
    expect(result.content).toContain('already exists');
  });

  test('duplicate against pending proposal returns error', async () => {
    const tool = createCreateAgentTool(store, configBots, 20, 3);

    // First proposal succeeds
    const first = await tool.execute(makeValidArgs(), noopLogger);
    expect(first.success).toBe(true);

    // Same agent_id fails
    const second = await tool.execute(makeValidArgs(), noopLogger);
    expect(second.success).toBe(false);
    expect(second.content).toContain('pending proposal');
  });

  test('max agents limit returns error', async () => {
    const tool = createCreateAgentTool(store, configBots, 3, 5);
    // 2 bots + 1 pending = 3 = maxAgents
    await tool.execute(makeValidArgs({ agent_id: 'agent-one', _botId: 'finny' }), noopLogger);
    const result = await tool.execute(
      makeValidArgs({ agent_id: 'agent-two', _botId: 'finny' }),
      noopLogger
    );
    expect(result.success).toBe(false);
    expect(result.content).toContain('Agent limit reached');
  });

  test('per-bot proposal limit returns error', async () => {
    const tool = createCreateAgentTool(store, configBots, 20, 2);

    await tool.execute(makeValidArgs({ agent_id: 'agent-one' }), noopLogger);
    await tool.execute(makeValidArgs({ agent_id: 'agent-two' }), noopLogger);
    const result = await tool.execute(makeValidArgs({ agent_id: 'agent-three' }), noopLogger);
    expect(result.success).toBe(false);
    expect(result.content).toContain('pending proposals');
  });

  test('personality_description too short returns error', async () => {
    const tool = createCreateAgentTool(store, configBots, 20, 3);
    const result = await tool.execute(
      makeValidArgs({ personality_description: 'Too short' }),
      noopLogger
    );
    expect(result.success).toBe(false);
    expect(result.content).toContain('at least 50 characters');
  });

  test('justification too short returns error', async () => {
    const tool = createCreateAgentTool(store, configBots, 20, 3);
    const result = await tool.execute(makeValidArgs({ justification: 'Short' }), noopLogger);
    expect(result.success).toBe(false);
    expect(result.content).toContain('at least 20 characters');
  });

  test('successful proposal creation', async () => {
    const tool = createCreateAgentTool(store, configBots, 20, 3);
    const result = await tool.execute(makeValidArgs(), noopLogger);

    expect(result.success).toBe(true);
    expect(result.content).toContain('submitted successfully');
    expect(result.content).toContain('ContentBot');
    expect(result.content).toContain('content-creator');

    // Verify stored
    const proposals = store.list();
    expect(proposals.length).toBe(1);
    expect(proposals[0].agentId).toBe('content-creator');
    expect(proposals[0].agentName).toBe('ContentBot');
    expect(proposals[0].status).toBe('pending');
    expect(proposals[0].proposedBy).toBe('moltbook');
  });

  test('successful proposal with optional fields', async () => {
    const tool = createCreateAgentTool(store, configBots, 20, 3);
    const result = await tool.execute(
      makeValidArgs({
        emoji: '✍️',
        language: 'English',
        model: 'claude-cli',
        llm_backend: 'claude-cli',
        agent_loop: { mode: 'continuous', every: '2h' },
      }),
      noopLogger
    );

    expect(result.success).toBe(true);

    const proposals = store.list();
    expect(proposals[0].emoji).toBe('✍️');
    expect(proposals[0].language).toBe('English');
    expect(proposals[0].model).toBe('claude-cli');
    expect(proposals[0].llmBackend).toBe('claude-cli');
    expect(proposals[0].agentLoop).toEqual({ mode: 'continuous', every: '2h' });
  });

  test('invalid llm_backend returns error', async () => {
    const tool = createCreateAgentTool(store, configBots, 20, 3);
    const result = await tool.execute(makeValidArgs({ llm_backend: 'invalid' }), noopLogger);
    expect(result.success).toBe(false);
    expect(result.content).toContain('llm_backend');
  });
});
