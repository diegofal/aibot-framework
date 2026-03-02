import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { AgentRegistry } from '../../src/agent-registry';
import { CollaborationTracker } from '../../src/collaboration-tracker';
import { type ExternalAgent, McpAgentBridge } from '../../src/mcp/agent-bridge';
import { McpClient } from '../../src/mcp/client';

const mockLogger: any = {
  info: mock(() => {}),
  warn: mock(() => {}),
  error: mock(() => {}),
  debug: mock(() => {}),
  child: () => mockLogger,
};

// Patch McpClient.prototype.connect to avoid real spawning
const originalConnect = McpClient.prototype.connect;
const originalDisconnect = McpClient.prototype.disconnect;

beforeEach(() => {
  // Mock connect: just set status to connected with fake tools
  McpClient.prototype.connect = async function () {
    (this as any)._status = 'connected';
    (this as any)._serverInfo = { name: 'mock', version: '1.0.0' };
    (this as any)._tools = [
      {
        name: 'mock_tool',
        description: 'A mock tool',
        inputSchema: { type: 'object', properties: {} },
      },
    ];
  };
  // Mock disconnect: set status to disconnected
  McpClient.prototype.disconnect = async function () {
    (this as any)._status = 'disconnected';
    (this as any)._tools = [];
    (this as any)._serverInfo = null;
  };
});

function makeAgent(id: string): ExternalAgent {
  return {
    agentId: id,
    name: `Agent ${id}`,
    description: `Description for ${id}`,
    mcpConfig: {
      name: id,
      transport: 'stdio',
      command: 'echo',
      timeout: 5000,
      autoReconnect: false,
    },
  };
}

describe('McpAgentBridge', () => {
  let registry: AgentRegistry;
  let tracker: CollaborationTracker;
  let bridge: McpAgentBridge;

  beforeEach(() => {
    registry = new AgentRegistry();
    tracker = new CollaborationTracker(5, 1000);
    bridge = new McpAgentBridge(registry, tracker, mockLogger);
  });

  it('should start empty', () => {
    expect(bridge.size).toBe(0);
    expect(bridge.listAgents()).toEqual([]);
  });

  it('should register an agent and add to agent registry', async () => {
    await bridge.registerAgent(makeAgent('ext1'));

    expect(bridge.size).toBe(1);
    const info = registry.getByBotId('ext1');
    expect(info).toBeDefined();
    expect(info!.name).toBe('Agent ext1');
    expect(info!.tools).toEqual(['mock_tool']);
  });

  it('should reject duplicate agent IDs', async () => {
    await bridge.registerAgent(makeAgent('ext1'));
    await expect(bridge.registerAgent(makeAgent('ext1'))).rejects.toThrow('already registered');
  });

  it('should unregister agents and clean up registry', async () => {
    await bridge.registerAgent(makeAgent('ext2'));
    expect(bridge.size).toBe(1);
    expect(registry.getByBotId('ext2')).toBeDefined();

    await bridge.unregisterAgent('ext2');
    expect(bridge.size).toBe(0);
    expect(registry.getByBotId('ext2')).toBeUndefined();
  });

  it('should return error for unknown agent tool calls', async () => {
    const result = await bridge.callTool('nonexistent', 'some_tool', {});
    expect(result.isError).toBe(true);
    expect((result.content[0] as any).text).toContain('not found');
  });

  it('should return error for disconnected agent tool calls', async () => {
    await bridge.registerAgent(makeAgent('ext3'));
    // Force disconnect
    await bridge.unregisterAgent('ext3');

    const result = await bridge.callTool('ext3', 'mock_tool', {});
    expect(result.isError).toBe(true);
    expect((result.content[0] as any).text).toContain('not found');
  });

  it('should list agents with status', async () => {
    await bridge.registerAgent(makeAgent('ext4'));

    const agents = bridge.listAgents();
    expect(agents.length).toBe(1);
    expect(agents[0].agentId).toBe('ext4');
    expect(agents[0].name).toBe('Agent ext4');
    expect(agents[0].description).toBe('Description for ext4');
    expect(agents[0].status).toBe('connected');
    expect(agents[0].tools).toEqual(['mock_tool']);
  });

  it('should disconnect all on disconnectAll', async () => {
    await bridge.registerAgent(makeAgent('a1'));
    await bridge.registerAgent(makeAgent('a2'));
    expect(bridge.size).toBe(2);

    await bridge.disconnectAll();
    expect(bridge.size).toBe(0);
  });

  it('should noop when unregistering unknown agent', async () => {
    await bridge.unregisterAgent('unknown');
    expect(bridge.size).toBe(0);
  });
});
