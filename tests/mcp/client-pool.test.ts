import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { McpClientPool } from '../../src/mcp/client-pool';

const mockLogger: any = {
  info: mock(() => {}),
  warn: mock(() => {}),
  error: mock(() => {}),
  debug: mock(() => {}),
  child: () => mockLogger,
};

describe('McpClientPool', () => {
  let pool: McpClientPool;

  beforeEach(() => {
    pool = new McpClientPool(mockLogger);
  });

  it('should start empty', () => {
    expect(pool.size).toBe(0);
    expect(pool.connectedCount).toBe(0);
    expect(pool.getStatus()).toEqual([]);
    expect(pool.getAllTools()).toEqual([]);
  });

  it('should add a server and return client', () => {
    const client = pool.addServer({
      name: 'test-server',
      transport: 'stdio',
      command: 'echo',
      timeout: 5000,
      autoReconnect: false,
    });

    expect(client).toBeDefined();
    expect(pool.size).toBe(1);
    expect(pool.getClient('test-server')).toBe(client);
  });

  it('should reject duplicate server names', () => {
    pool.addServer({
      name: 'dup',
      transport: 'stdio',
      command: 'echo',
      timeout: 5000,
      autoReconnect: false,
    });

    expect(() =>
      pool.addServer({
        name: 'dup',
        transport: 'stdio',
        command: 'echo',
        timeout: 5000,
        autoReconnect: false,
      })
    ).toThrow('already registered');
  });

  it('should return status for all servers', () => {
    pool.addServer({
      name: 'a',
      transport: 'stdio',
      command: 'echo',
      timeout: 5000,
      autoReconnect: false,
    });
    pool.addServer({
      name: 'b',
      transport: 'sse',
      url: 'http://localhost:3001/sse',
      timeout: 5000,
      autoReconnect: false,
    });

    const status = pool.getStatus();
    expect(status.length).toBe(2);
    expect(status[0].name).toBe('a');
    expect(status[0].status).toBe('disconnected');
    expect(status[1].name).toBe('b');
    expect(status[1].status).toBe('disconnected');
  });

  it('should remove a server', async () => {
    pool.addServer({
      name: 'temp',
      transport: 'stdio',
      command: 'echo',
      timeout: 5000,
      autoReconnect: false,
    });

    expect(pool.size).toBe(1);
    await pool.removeServer('temp');
    expect(pool.size).toBe(0);
    expect(pool.getClient('temp')).toBeUndefined();
  });

  it('should return error when calling tool on unknown server', async () => {
    const result = await pool.callTool('nonexistent', 'some_tool', {});
    expect(result.isError).toBe(true);
    expect(result.content[0].type).toBe('text');
    expect((result.content[0] as { type: 'text'; text: string }).text).toContain('not found');
  });

  it('should return error when calling tool on disconnected server', async () => {
    pool.addServer({
      name: 'offline',
      transport: 'stdio',
      command: 'echo',
      timeout: 5000,
      autoReconnect: false,
    });

    const result = await pool.callTool('offline', 'some_tool', {});
    expect(result.isError).toBe(true);
    expect((result.content[0] as { type: 'text'; text: string }).text).toContain('not connected');
  });

  it('should clear all on disconnectAll', async () => {
    pool.addServer({
      name: 'a',
      transport: 'stdio',
      command: 'echo',
      timeout: 5000,
      autoReconnect: false,
    });
    pool.addServer({
      name: 'b',
      transport: 'stdio',
      command: 'echo',
      timeout: 5000,
      autoReconnect: false,
    });

    expect(pool.size).toBe(2);
    await pool.disconnectAll();
    expect(pool.size).toBe(0);
  });
});
