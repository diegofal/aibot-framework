import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Hono } from 'hono';
import type { BotManager } from '../../../src/bot';
import type { DynamicToolRegistry } from '../../../src/bot/dynamic-tool-registry';
import { TOOL_CATEGORIES, TOOL_TO_CATEGORY } from '../../../src/bot/tool-registry';
import type { Logger } from '../../../src/logger';
import { DynamicToolStore } from '../../../src/tools/dynamic-tool-store';
import type { Tool, ToolDefinition } from '../../../src/tools/types';
import { toolsRoutes } from '../../../src/web/routes/tools';

const noopLogger: Logger = {
  info: () => {},
  warn: () => {},
  debug: () => {},
  error: () => {},
  child: () => noopLogger,
};

const TEST_DIR = join(process.cwd(), '.test-tools-routes');

// Minimal mock tools for testing
const mockDatetimeTool: Tool = {
  definition: {
    type: 'function',
    function: {
      name: 'get_datetime',
      description: 'Get current date and time',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  execute: async () => ({ success: true, content: '2026-02-25T12:00:00Z' }),
};

const mockEchoTool: Tool = {
  definition: {
    type: 'function',
    function: {
      name: 'echo_test',
      description: 'Echoes back the input message',
      parameters: {
        type: 'object',
        properties: {
          message: { type: 'string', description: 'Message to echo' },
        },
        required: ['message'],
      },
    },
  },
  execute: async (args) => ({ success: true, content: `Echo: ${args.message}` }),
};

const mockFailTool: Tool = {
  definition: {
    type: 'function',
    function: {
      name: 'fail_tool',
      description: 'Always fails',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  execute: async () => {
    throw new Error('Tool exploded');
  },
};

const mockMcpEverythingTool: Tool = {
  definition: {
    type: 'function',
    function: {
      name: 'mcp_everything_echo',
      description: '[MCP:everything] Echoes input',
      parameters: {
        type: 'object',
        properties: { input: { type: 'string', description: 'Input text' } },
        required: ['input'],
      },
    },
  },
  execute: async (args) => ({ success: true, content: `echo: ${args.input}` }),
};

const mockMcpGithubTool: Tool = {
  definition: {
    type: 'function',
    function: {
      name: 'mcp_github_create_issue',
      description: '[MCP:github] Create a GitHub issue',
      parameters: {
        type: 'object',
        properties: { title: { type: 'string', description: 'Issue title' } },
        required: ['title'],
      },
    },
  },
  execute: async (args) => ({ success: true, content: `created: ${args.title}` }),
};

function createMockToolRegistry() {
  const tools = [
    mockDatetimeTool,
    mockEchoTool,
    mockFailTool,
    mockMcpEverythingTool,
    mockMcpGithubTool,
  ];
  const definitions = tools.map((t) => t.definition);
  return {
    getTools: () => tools,
    getDefinitions: () => definitions,
  };
}

function createMockBotManager(toolRegistry: ReturnType<typeof createMockToolRegistry>) {
  return {
    getToolRegistry: () => toolRegistry,
  } as unknown as BotManager;
}

const mockDynamicRegistry = {
  approve: () => null,
  reject: () => null,
} as unknown as DynamicToolRegistry;

function makeApp(opts: { withBotManager?: boolean; storePath?: string } = {}) {
  const storePath = opts.storePath ?? join(TEST_DIR, 'tools');
  const store = new DynamicToolStore(storePath);
  const toolRegistry = createMockToolRegistry();
  const botManager = opts.withBotManager !== false ? createMockBotManager(toolRegistry) : undefined;

  const app = new Hono();
  app.route(
    '/api/tools',
    toolsRoutes({
      store,
      registry: mockDynamicRegistry,
      botManager,
      logger: noopLogger,
    })
  );

  return { app, store };
}

function addDynamicTool(storePath: string, id: string, meta: Record<string, unknown>) {
  const dir = join(storePath, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'meta.json'),
    JSON.stringify({
      id,
      name: meta.name || id,
      description: meta.description || 'A test tool',
      type: 'typescript',
      status: meta.status || 'pending',
      createdBy: 'test-bot',
      scope: 'all',
      parameters: meta.parameters || {},
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
  );
  writeFileSync(join(dir, 'tool.ts'), 'export default () => "ok"');
}

describe('tools routes — /all and /execute', () => {
  beforeEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
    // Register MCP tool names in the category map so the route can classify them
    TOOL_TO_CATEGORY.set('mcp_everything_echo', 'mcp');
    TOOL_TO_CATEGORY.set('mcp_github_create_issue', 'mcp');
    if (!TOOL_CATEGORIES.mcp.includes('mcp_everything_echo')) {
      TOOL_CATEGORIES.mcp.push('mcp_everything_echo', 'mcp_github_create_issue');
    }
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    // Cleanup MCP entries
    TOOL_TO_CATEGORY.delete('mcp_everything_echo');
    TOOL_TO_CATEGORY.delete('mcp_github_create_issue');
    TOOL_CATEGORIES.mcp = TOOL_CATEGORIES.mcp.filter(
      (n) => n !== 'mcp_everything_echo' && n !== 'mcp_github_create_issue'
    );
  });

  describe('GET /api/tools/all', () => {
    test('returns built-in tools', async () => {
      const { app } = makeApp();
      const res = await app.request('http://localhost/api/tools/all');
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(Array.isArray(data)).toBe(true);
      expect(data.length).toBe(5); // datetime, echo, fail + 2 MCP

      const builtInTools = data.filter((t: any) => t.source === 'built-in');
      expect(builtInTools.length).toBe(3);
      const builtInNames = builtInTools.map((t: any) => t.name);
      expect(builtInNames).toContain('get_datetime');
      expect(builtInNames).toContain('echo_test');
      expect(builtInNames).toContain('fail_tool');
    });

    test('MCP tools get source mcp with category', async () => {
      const { app } = makeApp();
      const res = await app.request('http://localhost/api/tools/all');
      const data = await res.json();

      const mcpTools = data.filter((t: any) => t.source === 'mcp');
      expect(mcpTools.length).toBe(2);

      const everythingTool = mcpTools.find((t: any) => t.name === 'mcp_everything_echo');
      expect(everythingTool).toBeTruthy();
      expect(everythingTool.source).toBe('mcp');
      expect(everythingTool.category).toBe('everything');

      const githubTool = mcpTools.find((t: any) => t.name === 'mcp_github_create_issue');
      expect(githubTool).toBeTruthy();
      expect(githubTool.source).toBe('mcp');
      expect(githubTool.category).toBe('github');
    });

    test('includes dynamic tools', async () => {
      const storePath = join(TEST_DIR, 'tools');
      addDynamicTool(storePath, 'dyn-1', {
        name: 'my_dynamic_tool',
        description: 'A dynamic tool',
        status: 'pending',
        parameters: { query: { type: 'string', description: 'Search query', required: true } },
      });

      const { app } = makeApp({ storePath });
      const res = await app.request('http://localhost/api/tools/all');
      const data = await res.json();

      const dynTool = data.find((t: any) => t.name === 'my_dynamic_tool');
      expect(dynTool).toBeTruthy();
      expect(dynTool.source).toBe('dynamic');
      expect(dynTool.status).toBe('pending');
    });

    test('returns full parameter schemas for built-in tools', async () => {
      const { app } = makeApp();
      const res = await app.request('http://localhost/api/tools/all');
      const data = await res.json();

      const echo = data.find((t: any) => t.name === 'echo_test');
      expect(echo.parameters).toBeTruthy();
      expect(echo.parameters.type).toBe('object');
      expect(echo.parameters.properties.message).toBeTruthy();
      expect(echo.parameters.required).toContain('message');
    });
  });

  describe('POST /api/tools/execute', () => {
    test('executes a tool with no args successfully', async () => {
      const { app } = makeApp();
      const res = await app.request('http://localhost/api/tools/execute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'get_datetime', args: {} }),
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.success).toBe(true);
      expect(data.content).toBe('2026-02-25T12:00:00Z');
      expect(typeof data.durationMs).toBe('number');
    });

    test('executes a tool with args', async () => {
      const { app } = makeApp();
      const res = await app.request('http://localhost/api/tools/execute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'echo_test', args: { message: 'hello world' } }),
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.success).toBe(true);
      expect(data.content).toBe('Echo: hello world');
    });

    test('returns 404 for unknown tool', async () => {
      const { app } = makeApp();
      const res = await app.request('http://localhost/api/tools/execute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'nonexistent_tool', args: {} }),
      });

      expect(res.status).toBe(404);
      const data = await res.json();
      expect(data.error).toContain('nonexistent_tool');
    });

    test('returns 400 when name is missing', async () => {
      const { app } = makeApp();
      const res = await app.request('http://localhost/api/tools/execute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ args: {} }),
      });

      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toContain('name');
    });

    test('handles tool execution errors gracefully', async () => {
      const { app } = makeApp();
      const res = await app.request('http://localhost/api/tools/execute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'fail_tool', args: {} }),
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.success).toBe(false);
      expect(data.content).toContain('Tool exploded');
      expect(typeof data.durationMs).toBe('number');
    });

    test('defaults args to empty object when not provided', async () => {
      const { app } = makeApp();
      const res = await app.request('http://localhost/api/tools/execute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'get_datetime' }),
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.success).toBe(true);
    });
  });
});
