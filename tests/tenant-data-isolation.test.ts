import { beforeEach, describe, expect, it } from 'bun:test';
import { AgentRegistry } from '../src/agent-registry';

describe('AgentRegistry tenant isolation', () => {
  let registry: AgentRegistry;

  beforeEach(() => {
    registry = new AgentRegistry();
    // Tenant A bots
    registry.register({ botId: 'a1', name: 'Bot A1', skills: [], tenantId: 'tenant-a' });
    registry.register({ botId: 'a2', name: 'Bot A2', skills: [], tenantId: 'tenant-a' });
    // Tenant B bots
    registry.register({ botId: 'b1', name: 'Bot B1', skills: [], tenantId: 'tenant-b' });
    // No-tenant bot (single-tenant mode)
    registry.register({ botId: 'solo', name: 'Solo Bot', skills: [] });
  });

  it('lists only same-tenant agents when tenantId is provided', () => {
    const others = registry.listOtherAgents('a1', 'tenant-a');
    expect(others).toHaveLength(1);
    expect(others[0].botId).toBe('a2');
  });

  it('excludes agents from other tenants', () => {
    const others = registry.listOtherAgents('a1', 'tenant-a');
    const botIds = others.map((a) => a.botId);
    expect(botIds).not.toContain('b1');
    expect(botIds).not.toContain('solo');
  });

  it('excludes self from listing', () => {
    const others = registry.listOtherAgents('a1', 'tenant-a');
    const botIds = others.map((a) => a.botId);
    expect(botIds).not.toContain('a1');
  });

  it('lists all agents (except self) when no tenantId filter', () => {
    const others = registry.listOtherAgents('a1');
    expect(others).toHaveLength(3); // a2, b1, solo
  });

  it('returns empty when tenant has only one bot', () => {
    const others = registry.listOtherAgents('b1', 'tenant-b');
    expect(others).toHaveLength(0);
  });

  it('returns empty for unknown tenant', () => {
    const others = registry.listOtherAgents('a1', 'tenant-unknown');
    expect(others).toHaveLength(0);
  });

  it('preserves tenantId on registered agents', () => {
    const agent = registry.getByBotId('a1');
    expect(agent?.tenantId).toBe('tenant-a');
  });

  it('unregister removes agent from tenant-filtered lists', () => {
    registry.unregister('a2');
    const others = registry.listOtherAgents('a1', 'tenant-a');
    expect(others).toHaveLength(0);
  });

  it('no-tenant bot is excluded from tenant-filtered lists', () => {
    const others = registry.listOtherAgents('a1', 'tenant-a');
    const botIds = others.map((a) => a.botId);
    expect(botIds).not.toContain('solo');
  });

  it('no-tenant bot sees all other bots when no filter', () => {
    const others = registry.listOtherAgents('solo');
    expect(others).toHaveLength(3); // a1, a2, b1
  });
});
