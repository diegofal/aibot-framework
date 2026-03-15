import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { AgentDirectory } from '../../src/a2a/directory';
import type { AgentCard } from '../../src/a2a/types';

function makeCard(
  name: string,
  skills: { name: string; description: string; tags?: string[] }[] = []
): AgentCard {
  return {
    name,
    description: `Agent ${name}`,
    url: `http://localhost:3000/a2a/${name}`,
    version: '1.0.0',
    capabilities: { streaming: false },
    skills: skills.map((s, i) => ({
      id: `${name}-skill-${i}`,
      name: s.name,
      description: s.description,
      tags: s.tags,
    })),
  };
}

describe('AgentDirectory', () => {
  let dir: AgentDirectory;

  beforeEach(() => {
    dir = new AgentDirectory({ staleTtlMs: 500, maxAgents: 3 });
  });

  afterEach(() => {
    dir.destroy();
  });

  test('register and list agents', () => {
    const card = makeCard('alpha');
    const entry = dir.register(card);

    expect(entry.card.name).toBe('alpha');
    expect(entry.healthy).toBe(true);
    expect(dir.size).toBe(1);
    expect(dir.list()).toHaveLength(1);
  });

  test('register preserves original registeredAt on re-register', () => {
    const card = makeCard('alpha');
    const first = dir.register(card);
    const originalRegisteredAt = first.registeredAt;

    // Small delay to ensure timestamps differ
    const updated = makeCard('alpha');
    updated.description = 'Updated description';
    const second = dir.register(updated);

    expect(second.registeredAt).toBe(originalRegisteredAt);
    expect(second.card.description).toBe('Updated description');
  });

  test('get returns entry by name', () => {
    dir.register(makeCard('alpha'));
    dir.register(makeCard('beta'));

    expect(dir.get('alpha')?.card.name).toBe('alpha');
    expect(dir.get('beta')?.card.name).toBe('beta');
    expect(dir.get('gamma')).toBeUndefined();
  });

  test('unregister removes agent', () => {
    dir.register(makeCard('alpha'));
    dir.register(makeCard('beta'));

    expect(dir.unregister('alpha')).toBe(true);
    expect(dir.size).toBe(1);
    expect(dir.get('alpha')).toBeUndefined();
    expect(dir.unregister('nonexistent')).toBe(false);
  });

  test('heartbeat updates lastHeartbeat and returns true for known agents', () => {
    dir.register(makeCard('alpha'));
    const entry = dir.get('alpha')!;
    const originalHb = entry.lastHeartbeat;

    // Wait a tiny bit to ensure timestamp differs
    const result = dir.heartbeat('alpha');
    expect(result).toBe(true);
    expect(dir.get('alpha')?.lastHeartbeat).toBeGreaterThanOrEqual(originalHb);
  });

  test('heartbeat returns false for unknown agents', () => {
    expect(dir.heartbeat('unknown')).toBe(false);
  });

  test('heartbeat restores health on previously stale agent', () => {
    dir.register(makeCard('alpha'));

    // Manually mark unhealthy to simulate staleness
    const entry = dir.get('alpha')!;
    entry.healthy = false;

    dir.heartbeat('alpha');
    expect(dir.get('alpha')?.healthy).toBe(true);
  });

  test('pruneStale marks agents without recent heartbeat as unhealthy', () => {
    dir.register(makeCard('alpha'));

    // Backdate the heartbeat so it's past the staleTtlMs (500ms)
    const entry = dir.get('alpha')!;
    entry.lastHeartbeat = Date.now() - 1000;

    dir.pruneStale();
    expect(dir.get('alpha')?.healthy).toBe(false);
    // Agent is still in directory, just marked unhealthy
    expect(dir.size).toBe(1);
  });

  test('pruneStale does not affect recent agents', () => {
    dir.register(makeCard('alpha'));
    dir.pruneStale();
    expect(dir.get('alpha')?.healthy).toBe(true);
  });

  test('healthy-only filter excludes unhealthy agents', () => {
    dir.register(makeCard('alpha'));
    dir.register(makeCard('beta'));

    // Make alpha stale
    dir.get('alpha')!.healthy = false;

    const healthy = dir.list(true);
    expect(healthy).toHaveLength(1);
    expect(healthy[0].card.name).toBe('beta');

    const all = dir.list(false);
    expect(all).toHaveLength(2);
  });

  test('searchBySkill matches by skill name', () => {
    dir.register(makeCard('alpha', [{ name: 'web_search', description: 'Search the web' }]));
    dir.register(makeCard('beta', [{ name: 'file_read', description: 'Read files' }]));

    const results = dir.searchBySkill('search');
    expect(results).toHaveLength(1);
    expect(results[0].card.name).toBe('alpha');
  });

  test('searchBySkill matches by skill description', () => {
    dir.register(makeCard('alpha', [{ name: 'tool_a', description: 'Analyze sentiment in text' }]));

    const results = dir.searchBySkill('sentiment');
    expect(results).toHaveLength(1);
    expect(results[0].card.name).toBe('alpha');
  });

  test('searchBySkill matches by skill tags', () => {
    dir.register(
      makeCard('alpha', [{ name: 'tool_a', description: 'Does stuff', tags: ['nlp', 'analysis'] }])
    );
    dir.register(
      makeCard('beta', [{ name: 'tool_b', description: 'Other stuff', tags: ['image', 'vision'] }])
    );

    const results = dir.searchBySkill('nlp');
    expect(results).toHaveLength(1);
    expect(results[0].card.name).toBe('alpha');
  });

  test('searchBySkill is case-insensitive', () => {
    dir.register(makeCard('alpha', [{ name: 'WebSearch', description: 'Search the Web' }]));

    expect(dir.searchBySkill('websearch')).toHaveLength(1);
    expect(dir.searchBySkill('WEBSEARCH')).toHaveLength(1);
  });

  test('searchBySkill only returns healthy agents', () => {
    dir.register(makeCard('alpha', [{ name: 'web_search', description: 'Search the web' }]));
    dir.get('alpha')!.healthy = false;

    expect(dir.searchBySkill('search')).toHaveLength(0);
  });

  test('maxAgents evicts oldest agent when exceeded', () => {
    // maxAgents = 3
    dir.register(makeCard('a'));
    dir.register(makeCard('b'));
    dir.register(makeCard('c'));
    expect(dir.size).toBe(3);

    // Backdate 'a' so it's the oldest by heartbeat
    dir.get('a')!.lastHeartbeat = Date.now() - 10_000;

    dir.register(makeCard('d'));
    // 'a' should have been evicted (oldest heartbeat)
    expect(dir.size).toBe(3);
    expect(dir.get('a')).toBeUndefined();
    expect(dir.get('d')).toBeDefined();
  });

  test('destroy clears all state', () => {
    dir.register(makeCard('alpha'));
    dir.register(makeCard('beta'));
    dir.destroy();
    expect(dir.size).toBe(0);
  });
});
