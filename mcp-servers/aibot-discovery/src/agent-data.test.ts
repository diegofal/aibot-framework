import { describe, expect, test } from 'bun:test';
import { type BotConfigEntry, createAgentDataLoaderFromBots } from './agent-data.js';

// Test fixtures
const testBots: BotConfigEntry[] = [
  {
    id: 'job-seeker',
    name: 'Cazador',
    enabled: true,
    skills: ['humanizer', 'reflection'],
    description: 'Autonomous job search agent for senior tech roles',
    model: 'claude-opus-4-6',
    llmBackend: 'claude-cli',
    agentLoop: { mode: 'continuous', every: '30m' },
  },
  {
    id: 'myfirstmillion',
    name: 'My First Million',
    enabled: true,
    skills: ['humanizer', 'reflection', 'calibrate'],
    description: 'Revenue strategy agent for independent income streams',
  },
  {
    id: 'cryptik',
    name: 'cryptik',
    enabled: false,
    skills: ['humanizer', 'reflection'],
    description: 'Crypto research and trading agent',
    agentLoop: { mode: 'periodic', every: '3h' },
  },
  {
    id: 'moltbook',
    name: 'MoltBook',
    enabled: true,
    skills: ['humanizer'],
    description: 'Agent ecosystem connector and network diplomat',
  },
  {
    id: 'openclone',
    name: 'OpenClone',
    enabled: true,
    skills: ['humanizer', 'reflection', 'improve'],
    description: 'Digital clone gap analysis agent',
  },
];

function createTestLoader() {
  return createAgentDataLoaderFromBots(testBots);
}

describe('AgentDataLoader', () => {
  describe('listAgents', () => {
    test('returns only active agents by default', () => {
      const loader = createTestLoader();
      const agents = loader.listAgents();

      expect(agents.length).toBe(4); // cryptik is disabled
      expect(agents.every((a) => a.status === 'active')).toBe(true);
      expect(agents.find((a) => a.id === 'cryptik')).toBeUndefined();
    });

    test('returns all agents when status=all', () => {
      const loader = createTestLoader();
      const agents = loader.listAgents({ status: 'all' });

      expect(agents.length).toBe(5);
      expect(agents.find((a) => a.id === 'cryptik')).toBeDefined();
    });

    test('returns only disabled agents when status=disabled', () => {
      const loader = createTestLoader();
      const agents = loader.listAgents({ status: 'disabled' });

      expect(agents.length).toBe(1);
      expect(agents[0].id).toBe('cryptik');
    });

    test('filters by capability keyword in tags', () => {
      const loader = createTestLoader();
      const agents = loader.listAgents({ capability: 'job-search' });

      expect(agents.length).toBe(1);
      expect(agents[0].id).toBe('job-seeker');
    });

    test('filters by capability keyword in description', () => {
      const loader = createTestLoader();
      const agents = loader.listAgents({ capability: 'revenue' });

      expect(agents.length).toBe(1);
      expect(agents[0].id).toBe('myfirstmillion');
    });

    test('filters by capability keyword in skills', () => {
      const loader = createTestLoader();
      const agents = loader.listAgents({ capability: 'improve' });

      expect(agents.length).toBe(1);
      expect(agents[0].id).toBe('openclone');
    });

    test('filters by capability keyword in name', () => {
      const loader = createTestLoader();
      const agents = loader.listAgents({ capability: 'moltbook' });

      expect(agents.length).toBe(1);
      expect(agents[0].id).toBe('moltbook');
    });

    test('capability filter is case-insensitive', () => {
      const loader = createTestLoader();
      const agents = loader.listAgents({ capability: 'CRYPTO' });

      // cryptik is disabled so won't appear with default status=active,
      // but status isn't set so it defaults to active
      expect(agents.length).toBe(0);

      // With status=all, cryptik shows up
      const allAgents = loader.listAgents({ capability: 'CRYPTO', status: 'all' });
      expect(allAgents.length).toBe(1);
      expect(allAgents[0].id).toBe('cryptik');
    });

    test('returns empty array when no agents match', () => {
      const loader = createTestLoader();
      const agents = loader.listAgents({ capability: 'nonexistent-capability' });

      expect(agents).toEqual([]);
    });

    test('combines status and capability filters', () => {
      const loader = createTestLoader();

      // Search for 'crypto' in disabled agents
      const agents = loader.listAgents({ capability: 'crypto', status: 'disabled' });
      expect(agents.length).toBe(1);
      expect(agents[0].id).toBe('cryptik');

      // Search for 'crypto' in active agents
      const active = loader.listAgents({ capability: 'crypto', status: 'active' });
      expect(active.length).toBe(0);
    });
  });

  describe('getAgent', () => {
    test('returns agent by id', () => {
      const loader = createTestLoader();
      const agent = loader.getAgent('job-seeker');

      expect(agent).toBeDefined();
      expect(agent?.id).toBe('job-seeker');
      expect(agent?.name).toBe('Cazador');
      expect(agent?.status).toBe('active');
      expect(agent?.description).toBe('Autonomous job search agent for senior tech roles');
      expect(agent?.skills).toEqual(['humanizer', 'reflection']);
      expect(agent?.model).toBe('claude-opus-4-6');
    });

    test('returns disabled agent by id', () => {
      const loader = createTestLoader();
      const agent = loader.getAgent('cryptik');

      expect(agent).toBeDefined();
      expect(agent?.status).toBe('disabled');
    });

    test('returns undefined for unknown agent', () => {
      const loader = createTestLoader();
      const agent = loader.getAgent('nonexistent');

      expect(agent).toBeUndefined();
    });

    test('includes agent loop config when present', () => {
      const loader = createTestLoader();
      const agent = loader.getAgent('job-seeker');

      expect(agent?.agentLoop).toBeDefined();
      expect(agent?.agentLoop?.mode).toBe('continuous');
      expect(agent?.agentLoop?.schedule).toBe('30m');
    });

    test('agent loop is undefined when not configured', () => {
      const loader = createTestLoader();
      const agent = loader.getAgent('moltbook');

      expect(agent?.agentLoop).toBeUndefined();
    });

    test('includes inferred tags', () => {
      const loader = createTestLoader();

      const cazador = loader.getAgent('job-seeker');
      expect(cazador?.tags).toContain('job-search');

      const mfm = loader.getAgent('myfirstmillion');
      expect(mfm?.tags).toContain('monetization');

      const cryptik = loader.getAgent('cryptik');
      expect(cryptik?.tags).toContain('crypto');

      const moltbook = loader.getAgent('moltbook');
      expect(moltbook?.tags).toContain('networking');
    });
  });

  describe('edge cases', () => {
    test('handles empty bots array', () => {
      const loader = createAgentDataLoaderFromBots([]);
      expect(loader.listAgents()).toEqual([]);
      expect(loader.getAgent('anything')).toBeUndefined();
    });

    test('handles bot with minimal config', () => {
      const loader = createAgentDataLoaderFromBots([
        {
          id: 'minimal',
          name: 'Minimal Bot',
          enabled: true,
          skills: [],
        },
      ]);

      const agents = loader.listAgents();
      expect(agents.length).toBe(1);
      expect(agents[0].id).toBe('minimal');
      expect(agents[0].description).toBe('Minimal Bot agent'); // fallback
      expect(agents[0].skills).toEqual([]);
    });
  });
});
