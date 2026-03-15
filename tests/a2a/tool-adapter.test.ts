import { describe, expect, it } from 'bun:test';
import type { A2AClient } from '../../src/a2a/client';
import { adaptA2AAgentToTools } from '../../src/a2a/tool-adapter';
import type { AgentCard } from '../../src/a2a/types';

describe('adaptA2AAgentToTools', () => {
  const baseCard: AgentCard = {
    name: 'Helper',
    description: 'A helper agent',
    url: 'http://localhost:4000/a2a/helper',
    version: '1.0.0',
    capabilities: { streaming: false },
    skills: [
      {
        id: 'summarize',
        name: 'summarize',
        description: 'Summarize text content',
        tags: ['nlp'],
      },
      {
        id: 'translate',
        name: 'translate',
        description: 'Translate between languages',
        tags: ['nlp', 'i18n'],
      },
    ],
    defaultInputModes: ['text'],
    defaultOutputModes: ['text'],
  };

  it('creates one tool per skill', () => {
    const mockClient = {} as A2AClient;
    const tools = adaptA2AAgentToTools('helper', baseCard, mockClient);
    expect(tools).toHaveLength(2);
  });

  it('names tools with a2a_ prefix', () => {
    const mockClient = {} as A2AClient;
    const tools = adaptA2AAgentToTools('helper', baseCard, mockClient);
    expect(tools[0].definition.function.name).toBe('a2a_helper_summarize');
    expect(tools[1].definition.function.name).toBe('a2a_helper_translate');
  });

  it('includes agent name in description', () => {
    const mockClient = {} as A2AClient;
    const tools = adaptA2AAgentToTools('helper', baseCard, mockClient);
    expect(tools[0].definition.function.description).toContain('[A2A Agent: helper]');
    expect(tools[0].definition.function.description).toContain('Summarize text content');
  });

  it('has message as required parameter', () => {
    const mockClient = {} as A2AClient;
    const tools = adaptA2AAgentToTools('helper', baseCard, mockClient);
    const params = tools[0].definition.function.parameters;
    expect(params.required).toEqual(['message']);
    expect(params.properties).toHaveProperty('message');
    expect(params.properties).toHaveProperty('sessionId');
  });

  it('sanitizes agent name with special characters', () => {
    const mockClient = {} as A2AClient;
    const tools = adaptA2AAgentToTools('my-agent.v2', baseCard, mockClient);
    expect(tools[0].definition.function.name).toBe('a2a_my_agent_v2_summarize');
  });

  it('handles agent with no skills', () => {
    const mockClient = {} as A2AClient;
    const emptyCard: AgentCard = { ...baseCard, skills: [] };
    const tools = adaptA2AAgentToTools('helper', emptyCard, mockClient);
    expect(tools).toHaveLength(0);
  });

  it('tool execute returns success on successful call', async () => {
    const mockClient = {
      sendMessage: async () => ({
        id: 'task-1',
        status: { state: 'completed' as const, timestamp: new Date().toISOString() },
        messages: [
          { role: 'user' as const, parts: [{ type: 'text' as const, text: 'hello' }] },
          { role: 'agent' as const, parts: [{ type: 'text' as const, text: 'response text' }] },
        ],
      }),
    } as unknown as A2AClient;

    const tools = adaptA2AAgentToTools('helper', baseCard, mockClient);
    const mockLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as any;
    const result = await tools[0].execute({ message: 'hello' }, mockLogger);
    expect(result.success).toBe(true);
    expect(result.content).toBe('response text');
  });

  it('tool execute returns failure on error', async () => {
    const mockClient = {
      sendMessage: async () => {
        throw new Error('Connection refused');
      },
    } as unknown as A2AClient;

    const tools = adaptA2AAgentToTools('helper', baseCard, mockClient);
    const mockLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as any;
    const result = await tools[0].execute({ message: 'hello' }, mockLogger);
    expect(result.success).toBe(false);
    expect(result.content).toContain('Connection refused');
  });
});
