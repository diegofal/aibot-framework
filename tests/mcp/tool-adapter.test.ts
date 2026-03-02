import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { McpClientPool } from '../../src/mcp/client-pool';
import { adaptAllMcpTools, adaptMcpTool, parseMcpToolName } from '../../src/mcp/tool-adapter';
import type { McpToolCallResult, McpToolDef } from '../../src/mcp/types';

const mockLogger: any = {
  info: mock(() => {}),
  warn: mock(() => {}),
  error: mock(() => {}),
  debug: mock(() => {}),
  child: () => mockLogger,
};

const sampleTool: McpToolDef = {
  name: 'create_issue',
  description: 'Create a GitHub issue',
  inputSchema: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Issue title' },
      body: { type: 'string', description: 'Issue body' },
    },
    required: ['title'],
  },
};

describe('MCP Tool Adapter', () => {
  describe('adaptMcpTool', () => {
    it('should create a namespaced tool with correct definition', () => {
      const pool = new McpClientPool(mockLogger);
      const tool = adaptMcpTool('github', 'github', sampleTool, pool, mockLogger);

      expect(tool.definition.type).toBe('function');
      expect(tool.definition.function.name).toBe('mcp_github_create_issue');
      expect(tool.definition.function.description).toContain('[MCP:github]');
      expect(tool.definition.function.description).toContain('Create a GitHub issue');
      expect(tool.definition.function.parameters.properties).toHaveProperty('title');
      expect(tool.definition.function.parameters.required).toEqual(['title']);
    });

    it('should sanitize prefix (lowercase, replace special chars)', () => {
      const pool = new McpClientPool(mockLogger);
      const tool = adaptMcpTool('My-Server', 'My-Server', sampleTool, pool, mockLogger);
      expect(tool.definition.function.name).toBe('mcp_my_server_create_issue');
    });

    it('should execute and return success result', async () => {
      // Create a pool with a mock callTool method
      const pool = new McpClientPool(mockLogger);
      const originalCallTool = pool.callTool.bind(pool);
      pool.callTool = async (
        _serverName: string,
        _toolName: string,
        _args: Record<string, unknown>
      ): Promise<McpToolCallResult> => ({
        content: [{ type: 'text', text: 'Issue #123 created' }],
        isError: false,
      });

      const tool = adaptMcpTool('github', 'github', sampleTool, pool, mockLogger);
      const result = await tool.execute({ title: 'Bug fix' }, mockLogger);

      expect(result.success).toBe(true);
      expect(result.content).toBe('Issue #123 created');
    });

    it('should handle error results from MCP', async () => {
      const pool = new McpClientPool(mockLogger);
      pool.callTool = async (): Promise<McpToolCallResult> => ({
        content: [{ type: 'text', text: 'Permission denied' }],
        isError: true,
      });

      const tool = adaptMcpTool('github', 'github', sampleTool, pool, mockLogger);
      const result = await tool.execute({ title: 'test' }, mockLogger);

      expect(result.success).toBe(false);
      expect(result.content).toBe('Permission denied');
    });

    it('should handle exceptions during execution', async () => {
      const pool = new McpClientPool(mockLogger);
      pool.callTool = async (): Promise<never> => {
        throw new Error('Connection refused');
      };

      const tool = adaptMcpTool('github', 'github', sampleTool, pool, mockLogger);
      const result = await tool.execute({}, mockLogger);

      expect(result.success).toBe(false);
      expect(result.content).toContain('Connection refused');
    });

    it('should handle empty response', async () => {
      const pool = new McpClientPool(mockLogger);
      pool.callTool = async (): Promise<McpToolCallResult> => ({
        content: [],
      });

      const tool = adaptMcpTool('github', 'github', sampleTool, pool, mockLogger);
      const result = await tool.execute({}, mockLogger);

      expect(result.success).toBe(true);
      expect(result.content).toBe('(empty response)');
    });
  });

  describe('parseMcpToolName', () => {
    it('should parse valid MCP tool names', () => {
      expect(parseMcpToolName('mcp_github_create_issue')).toEqual({
        prefix: 'github',
        toolName: 'create_issue',
      });
    });

    it('should handle multi-part tool names', () => {
      expect(parseMcpToolName('mcp_linear_get_team_members')).toEqual({
        prefix: 'linear',
        toolName: 'get_team_members',
      });
    });

    it('should return null for non-MCP tool names', () => {
      expect(parseMcpToolName('web_search')).toBeNull();
      expect(parseMcpToolName('file_read')).toBeNull();
      expect(parseMcpToolName('mcp_')).toBeNull();
      expect(parseMcpToolName('')).toBeNull();
    });
  });

  describe('adaptAllMcpTools', () => {
    it('should return empty array for empty pool', () => {
      const pool = new McpClientPool(mockLogger);
      const tools = adaptAllMcpTools(pool, mockLogger);
      expect(tools).toEqual([]);
    });
  });
});
