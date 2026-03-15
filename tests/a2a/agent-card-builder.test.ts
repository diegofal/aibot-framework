import { describe, expect, it } from 'bun:test';
import { type AgentCardOptions, buildAgentCard } from '../../src/a2a/agent-card-builder';
import type { BotConfig } from '../../src/config';
import type { ToolDefinition } from '../../src/tools/types';

describe('buildAgentCard', () => {
  const baseBotConfig: BotConfig = {
    id: 'bot-1',
    name: 'TestBot',
    token: '',
    enabled: true,
    skills: [],
    disabledSkills: [],
    plan: 'free',
    description: 'A test bot',
  };

  const toolDefs: ToolDefinition[] = [
    {
      type: 'function',
      function: {
        name: 'web_search',
        description: 'Search the web',
        parameters: { type: 'object', properties: {} },
      },
    },
    {
      type: 'function',
      function: {
        name: 'file_read',
        description: 'Read a file',
        parameters: { type: 'object', properties: {} },
      },
    },
  ];

  it('builds a valid agent card with all fields', () => {
    const opts: AgentCardOptions = {
      baseUrl: 'http://localhost:3000',
      botConfig: baseBotConfig,
      toolDefinitions: toolDefs,
    };

    const card = buildAgentCard(opts);

    expect(card.name).toBe('TestBot');
    expect(card.description).toBe('A test bot');
    expect(card.url).toBe('http://localhost:3000/a2a/bot-1');
    expect(card.version).toBe('1.0.0');
    expect(card.capabilities.streaming).toBe(false);
    expect(card.capabilities.pushNotifications).toBe(false);
    expect(card.capabilities.stateTransitionHistory).toBe(true);
    expect(card.defaultInputModes).toEqual(['text']);
    expect(card.defaultOutputModes).toEqual(['text']);
  });

  it('maps tool definitions to skills', () => {
    const opts: AgentCardOptions = {
      baseUrl: 'http://localhost:3000',
      botConfig: baseBotConfig,
      toolDefinitions: toolDefs,
    };

    const card = buildAgentCard(opts);

    expect(card.skills).toHaveLength(2);
    expect(card.skills[0].id).toBe('web_search');
    expect(card.skills[0].name).toBe('web_search');
    expect(card.skills[0].description).toBe('Search the web');
    expect(card.skills[1].id).toBe('file_read');
  });

  it('uses custom version when provided', () => {
    const opts: AgentCardOptions = {
      baseUrl: 'http://localhost:3000',
      botConfig: baseBotConfig,
      toolDefinitions: [],
      version: '2.0.0',
    };

    const card = buildAgentCard(opts);
    expect(card.version).toBe('2.0.0');
  });

  it('uses fallback description when bot has no description', () => {
    const botWithoutDesc: BotConfig = {
      ...baseBotConfig,
      description: undefined,
    };

    const opts: AgentCardOptions = {
      baseUrl: 'http://localhost:3000',
      botConfig: botWithoutDesc,
      toolDefinitions: [],
    };

    const card = buildAgentCard(opts);
    expect(card.description).toBe('Agent TestBot');
  });

  it('produces empty skills list with no tools', () => {
    const opts: AgentCardOptions = {
      baseUrl: 'http://localhost:3000',
      botConfig: baseBotConfig,
      toolDefinitions: [],
    };

    const card = buildAgentCard(opts);
    expect(card.skills).toHaveLength(0);
  });

  it('constructs correct URL with base path', () => {
    const opts: AgentCardOptions = {
      baseUrl: 'https://example.com',
      botConfig: { ...baseBotConfig, id: 'my-agent' },
      toolDefinitions: [],
    };

    const card = buildAgentCard(opts);
    expect(card.url).toBe('https://example.com/a2a/my-agent');
  });
});
