import { describe, expect, test } from 'bun:test';
import { type BotConfigEntry, createAgentDataLoaderFromBots } from './agent-data.js';
import { type JsonRpcRequest, createMcpServer } from './mcp-server.js';

const testBots: BotConfigEntry[] = [
  {
    id: 'job-seeker',
    name: 'Cazador',
    enabled: true,
    skills: ['humanizer', 'reflection'],
    description: 'Job search agent',
    model: 'claude-opus-4-6',
  },
  {
    id: 'moltbook',
    name: 'MoltBook',
    enabled: true,
    skills: ['humanizer'],
    description: 'Agent ecosystem connector',
  },
  {
    id: 'cryptik',
    name: 'cryptik',
    enabled: false,
    skills: ['humanizer'],
    description: 'Crypto research agent',
  },
];

function createTestServer() {
  const loader = createAgentDataLoaderFromBots(testBots);
  return createMcpServer(loader);
}

function request(method: string, params?: Record<string, unknown>, id = 1): JsonRpcRequest {
  return { jsonrpc: '2.0', id, method, params };
}

describe('MCP Server', () => {
  describe('initialize', () => {
    test('returns server info and capabilities', () => {
      const server = createTestServer();
      const res = server.handleRequest(request('initialize'));

      expect(res.error).toBeUndefined();
      expect(res.result).toBeDefined();

      const result = res.result as Record<string, unknown>;
      expect(result.protocolVersion).toBe('2024-11-05');
      expect(result.serverInfo).toEqual({
        name: 'aibot-agent-discovery',
        version: '0.1.0',
      });
      expect(result.capabilities).toEqual({ tools: {} });
    });
  });

  describe('ping', () => {
    test('responds with empty result', () => {
      const server = createTestServer();
      const res = server.handleRequest(request('ping'));

      expect(res.error).toBeUndefined();
      expect(res.result).toEqual({});
    });
  });

  describe('tools/list', () => {
    test('returns both tool definitions', () => {
      const server = createTestServer();
      const res = server.handleRequest(request('tools/list'));

      expect(res.error).toBeUndefined();
      const result = res.result as { tools: Array<{ name: string }> };
      expect(result.tools.length).toBe(2);

      const names = result.tools.map((t) => t.name);
      expect(names).toContain('discover_agents');
      expect(names).toContain('get_agent_card');
    });

    test('discover_agents tool has correct schema', () => {
      const server = createTestServer();
      const res = server.handleRequest(request('tools/list'));

      const result = res.result as {
        tools: Array<{ name: string; inputSchema: Record<string, unknown> }>;
      };
      const tool = result.tools.find((t) => t.name === 'discover_agents');
      expect(tool).toBeDefined();
      expect(tool?.inputSchema.type).toBe('object');
      expect(tool?.inputSchema.properties).toBeDefined();
    });

    test('get_agent_card tool requires agent_id', () => {
      const server = createTestServer();
      const res = server.handleRequest(request('tools/list'));

      const result = res.result as {
        tools: Array<{ name: string; inputSchema: { required?: string[] } }>;
      };
      const tool = result.tools.find((t) => t.name === 'get_agent_card');
      expect(tool).toBeDefined();
      expect(tool?.inputSchema.required).toContain('agent_id');
    });
  });

  describe('tools/call — discover_agents', () => {
    test('returns active agents by default', () => {
      const server = createTestServer();
      const res = server.handleRequest(
        request('tools/call', { name: 'discover_agents', arguments: {} })
      );

      expect(res.error).toBeUndefined();
      const result = res.result as { content: Array<{ type: string; text: string }> };
      expect(result.content.length).toBe(1);
      expect(result.content[0].type).toBe('text');

      const data = JSON.parse(result.content[0].text);
      expect(data.count).toBe(2); // job-seeker + moltbook (cryptik disabled)
      expect(data.agents.find((a: { id: string }) => a.id === 'cryptik')).toBeUndefined();
    });

    test('filters by capability', () => {
      const server = createTestServer();
      const res = server.handleRequest(
        request('tools/call', { name: 'discover_agents', arguments: { capability: 'job' } })
      );

      const result = res.result as { content: Array<{ text: string }> };
      const data = JSON.parse(result.content[0].text);
      expect(data.count).toBe(1);
      expect(data.agents[0].id).toBe('job-seeker');
    });

    test('returns all agents when status=all', () => {
      const server = createTestServer();
      const res = server.handleRequest(
        request('tools/call', { name: 'discover_agents', arguments: { status: 'all' } })
      );

      const result = res.result as { content: Array<{ text: string }> };
      const data = JSON.parse(result.content[0].text);
      expect(data.count).toBe(3);
    });

    test('returns helpful message when no agents match', () => {
      const server = createTestServer();
      const res = server.handleRequest(
        request('tools/call', {
          name: 'discover_agents',
          arguments: { capability: 'nonexistent' },
        })
      );

      const result = res.result as { content: Array<{ text: string }> };
      expect(result.content[0].text).toContain('No agents found');
      expect(result.content[0].text).toContain('nonexistent');
    });
  });

  describe('tools/call — get_agent_card', () => {
    test('returns full agent card', () => {
      const server = createTestServer();
      const res = server.handleRequest(
        request('tools/call', { name: 'get_agent_card', arguments: { agent_id: 'job-seeker' } })
      );

      expect(res.error).toBeUndefined();
      const result = res.result as { content: Array<{ text: string }>; isError?: boolean };
      expect(result.isError).toBeUndefined();

      const card = JSON.parse(result.content[0].text);
      expect(card.id).toBe('job-seeker');
      expect(card.name).toBe('Cazador');
      expect(card.status).toBe('active');
      expect(card.model).toBe('claude-opus-4-6');
      expect(card.skills).toEqual(['humanizer', 'reflection']);
    });

    test('returns error for missing agent_id', () => {
      const server = createTestServer();
      const res = server.handleRequest(
        request('tools/call', { name: 'get_agent_card', arguments: {} })
      );

      const result = res.result as { content: Array<{ text: string }>; isError?: boolean };
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('agent_id is required');
    });

    test('returns error with available IDs for unknown agent', () => {
      const server = createTestServer();
      const res = server.handleRequest(
        request('tools/call', { name: 'get_agent_card', arguments: { agent_id: 'nope' } })
      );

      const result = res.result as { content: Array<{ text: string }>; isError?: boolean };
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('not found');
      expect(result.content[0].text).toContain('job-seeker'); // lists available
    });
  });

  describe('error handling', () => {
    test('returns error for unknown method', () => {
      const server = createTestServer();
      const res = server.handleRequest(request('unknown/method'));

      expect(res.error).toBeDefined();
      expect(res.error?.code).toBe(-32601);
      expect(res.error?.message).toContain('Method not found');
    });

    test('returns error for unknown tool name', () => {
      const server = createTestServer();
      const res = server.handleRequest(
        request('tools/call', { name: 'nonexistent_tool', arguments: {} })
      );

      expect(res.error).toBeDefined();
      expect(res.error?.code).toBe(-32601);
      expect(res.error?.message).toContain('Unknown tool');
    });

    test('preserves request id in response', () => {
      const server = createTestServer();

      const res1 = server.handleRequest(request('ping', undefined, 42));
      expect(res1.id).toBe(42);

      const res2 = server.handleRequest(request('ping', undefined, 99));
      expect(res2.id).toBe(99);
    });

    test('handles notification (no id) without crashing', () => {
      const server = createTestServer();
      const res = server.handleRequest({
        jsonrpc: '2.0',
        method: 'notifications/initialized',
      });

      // Should return something (not crash)
      expect(res.jsonrpc).toBe('2.0');
    });
  });
});
