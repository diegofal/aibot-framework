import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  FLEET_MEMORY_MAX_RESULTS,
  FLEET_PREFETCH_RESULTS,
  buildFleetMemoryPrefetch,
  createFleetMemorySearchTool,
  visibleTo,
} from '../../src/tools/fleet-memory-search';
import { Graph } from '../../src/watcher/graph';

const logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as never;

let dir: string;
let graph: Graph;
const t = Date.parse('2026-10-23T10:00:00Z');

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fleet-memory-'));
  graph = new Graph(dir, { now: () => t });
  graph.load();
  graph.addNeuron({
    kind: 'entity',
    text: 'Jarvis',
    support: { bots: ['b1'] },
    createdBy: 'bot:b1',
    meta: { key: 'bot:b1', name: 'Jarvis' },
  });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function add(text: string, bots = ['b1'], kind: 'fact' | 'topic' = 'fact') {
  return graph.addNeuron({ kind, text, support: { bots }, createdBy: 'watcher' });
}

/** A caller of bot b1 that is not the operator (the default visibility). */
const asB1 = { _botId: 'b1' };

describe('fleet_memory_search', () => {
  test('ranks by text when there are no embeddings, best first', async () => {
    add('The blue heron nests behind the old water tower');
    add('Water bills are paid on the first of the month');
    add('Nothing about birds here');
    const tool = createFleetMemorySearchTool(() => ({ graph }));
    const res = await tool.execute({ query: 'where does the heron nest', ...asB1 }, logger);
    expect(res.success).toBe(true);
    const heron = res.content.indexOf('blue heron');
    expect(heron).toBeGreaterThan(-1);
    const water = res.content.indexOf('Water bills');
    if (water > -1) expect(heron).toBeLessThan(water);
    expect(res.content).not.toContain('Nothing about birds');
  });

  test('says which bots know it and when, by name', async () => {
    add('The blue heron nests behind the old water tower', ['b1', 'b9']);
    const tool = createFleetMemorySearchTool(() => ({ graph }));
    const res = await tool.execute({ query: 'heron nests', ...asB1 }, logger);
    expect(res.content).toContain('fact');
    expect(res.content).toContain('Jarvis, b9');
    expect(res.content).toContain('2026-10-23');
  });

  test('ranks by embedding similarity when embed is available', async () => {
    const a = add('Alpha thing');
    const b = add('Beta thing');
    graph.setEmbedding(a.id, [1, 0]);
    graph.setEmbedding(b.id, [0, 1]);
    const tool = createFleetMemorySearchTool(() => ({ graph, embed: async () => [0.1, 0.99] }));
    const res = await tool.execute({ query: 'zzz', ...asB1 }, logger);
    expect(res.content.indexOf('Beta thing')).toBeGreaterThan(-1);
    expect(res.content).not.toContain('Alpha thing');
  });

  test('a failing embed falls back to text', async () => {
    // The neuron has an embedding, so the query is embedded (and the embed throws).
    const n = add('The blue heron nests behind the old water tower');
    graph.setEmbedding(n.id, [1, 0]);
    let calls = 0;
    const tool = createFleetMemorySearchTool(() => ({
      graph,
      embed: async () => {
        calls++;
        throw new Error('ollama down');
      },
    }));
    const res = await tool.execute({ query: 'heron nests', ...asB1 }, logger);
    expect(calls).toBe(1);
    expect(res.content).toContain('blue heron');
  });

  test('archived neurons are excluded', async () => {
    const n = add('The blue heron nests behind the old water tower');
    graph.archive(n.id);
    const tool = createFleetMemorySearchTool(() => ({ graph }));
    const res = await tool.execute({ query: 'heron nests', ...asB1 }, logger);
    expect(res.content).not.toContain('blue heron');
    expect(res.content).toContain('Nothing in the fleet memory');
  });

  test('results are wrapped as external content', async () => {
    add('The blue heron nests behind the old water tower');
    const tool = createFleetMemorySearchTool(() => ({ graph }));
    const res = await tool.execute({ query: 'heron', ...asB1 }, logger);
    expect(res.content.startsWith('<<<EXTERNAL_UNTRUSTED_CONTENT>>>')).toBe(true);
    expect(res.content.endsWith('<<<END_EXTERNAL_UNTRUSTED_CONTENT>>>')).toBe(true);
  });

  test('limit caps the results, never above the maximum', async () => {
    for (let i = 0; i < 15; i++) add(`heron sighting number ${i}`);
    const tool = createFleetMemorySearchTool(() => ({ graph }));
    const count = (s: string) => (s.match(/^\d+\. /gm) ?? []).length;
    expect(
      count((await tool.execute({ query: 'heron sighting', limit: 3, ...asB1 }, logger)).content)
    ).toBe(3);
    expect(
      count((await tool.execute({ query: 'heron sighting', limit: 50, ...asB1 }, logger)).content)
    ).toBe(FLEET_MEMORY_MAX_RESULTS);
  });

  test('a missing query is an error', async () => {
    const tool = createFleetMemorySearchTool(() => ({ graph }));
    expect((await tool.execute({ query: '  ', ...asB1 }, logger)).success).toBe(false);
  });

  test('without a watcher it says the fleet memory is not available', async () => {
    const tool = createFleetMemorySearchTool(() => undefined);
    const res = await tool.execute({ query: 'heron', ...asB1 }, logger);
    expect(res.success).toBe(false);
    expect(res.content).toContain('not available');
  });

  test('is not sensitive', () => {
    const tool = createFleetMemorySearchTool(() => ({ graph }));
    expect(tool.definition.function.name).toBe('fleet_memory_search');
    expect((tool.definition as { sensitive?: boolean }).sensitive).toBeFalsy();
  });
});

describe('fleet_memory_search: operator-sourced neurons (privacy)', () => {
  const setupPrivate = () => {
    graph.addNeuron({
      kind: 'fact',
      text: 'The operator daughter Emma starts school in March',
      support: { bots: ['b1'] },
      createdBy: 'watcher',
      meta: { operatorSourced: 'true' },
    });
    add('The school calendar changes in March');
    return createFleetMemorySearchTool(() => ({ graph }));
  };
  const query = { query: 'school in March' };
  const sees = async (args: Record<string, unknown>) =>
    (await setupPrivate().execute({ ...query, ...args }, logger)).content.includes('Emma');

  test('the dashboard operator (_actor operator) sees them', async () => {
    expect(await sees({ _actor: 'operator' })).toBe(true);
  });

  test('the operator on Telegram (verified) sees them', async () => {
    expect(
      await sees({ _requester: { isOperator: true, channelKind: 'telegram', address: '42' } })
    ).toBe(true);
  });

  test('the operator in a group does not', async () => {
    expect(
      await sees({
        _isGroup: true,
        _requester: { isOperator: true, channelKind: 'telegram', address: '42' },
      })
    ).toBe(false);
  });

  test('an operator claimed on web (unverified) does not', async () => {
    expect(
      await sees({ _requester: { isOperator: true, channelKind: 'web', address: 'op@x.io' } })
    ).toBe(false);
  });

  test('another user does not', async () => {
    expect(
      await sees({ _requester: { isOperator: false, channelKind: 'telegram', address: '7' } })
    ).toBe(false);
  });

  test('the agent loop (_actor self) does not', async () => {
    expect(await sees({ _actor: 'self' })).toBe(false);
  });

  test('an operator cron run does not', async () => {
    expect(await sees({ _actor: 'operator-cron' })).toBe(false);
  });

  test('collaboration / no caller at all does not', async () => {
    expect(await sees({})).toBe(false);
  });

  test('everyone still gets the neurons with no operator-sourced support', async () => {
    const res = await setupPrivate().execute({ ...query, _actor: 'self', _botId: 'b1' }, logger);
    expect(res.content).toContain('school calendar changes');
  });
});

describe('fleet_memory_search: what a non-operator caller may see (scope)', () => {
  const setup = (opts: { isTenantBot?: (id: string) => boolean } = {}) => {
    graph.addNeuron({
      kind: 'entity',
      text: 'Scout: finds suppliers',
      support: { bots: ['b2'] },
      createdBy: 'bot:b2',
      meta: { key: 'bot:b2', name: 'Scout', botId: 'b2' },
    });
    graph.addNeuron({
      kind: 'entity',
      text: 'Tenant helper: suppliers for a customer',
      support: { bots: ['t1'] },
      createdBy: 'bot:t1',
      meta: { key: 'bot:t1', name: 'Tenant helper', botId: 't1' },
    });
    add('Suppliers in Rosario ship on Tuesdays', ['b1']);
    add('Suppliers in Cordoba ship on Fridays', ['b2']);
    add('Suppliers are discussed fleet-wide', []);
    return createFleetMemorySearchTool(() => ({ graph }), opts);
  };
  const run = async (args: Record<string, unknown>, opts = {}) =>
    (await setup(opts).execute({ query: 'suppliers ship', limit: 10, ...args }, logger)).content;

  test("the bot's own users see what that bot supports", async () => {
    const out = await run({ _botId: 'b1', _requester: { isOperator: false, channelKind: 'web' } });
    expect(out).toContain('Rosario');
  });

  test("they never see what only another bot supports, nor the watcher's own neurons", async () => {
    const out = await run({ _botId: 'b1', _requester: { isOperator: false, channelKind: 'web' } });
    expect(out).not.toContain('Cordoba');
    expect(out).not.toContain('fleet-wide');
  });

  test("the bot's own runs (_actor self) follow the same rule", async () => {
    const out = await run({ _botId: 'b1', _actor: 'self' });
    expect(out).toContain('Rosario');
    expect(out).not.toContain('Cordoba');
  });

  test('general fleet entities (the bots) are visible to everyone', async () => {
    const out = await run({ _botId: 'b1', query: 'Scout suppliers' });
    expect(out).toContain('Scout: finds suppliers');
  });

  test('a caller with no bot sees only fleet entities', async () => {
    const out = await run({});
    expect(out).toContain('Scout: finds suppliers');
    expect(out).not.toContain('Rosario');
  });

  test('the operator sees everything', async () => {
    const out = await run({ _actor: 'operator' });
    for (const t of ['Rosario', 'Cordoba', 'fleet-wide']) expect(out).toContain(t);
  });

  test('a tenant bot is refused, whoever calls', async () => {
    const tool = setup({ isTenantBot: (id) => id === 't1' });
    for (const args of [{ _botId: 't1' }, { _botId: 't1', _actor: 'operator' }]) {
      const res = await tool.execute({ query: 'suppliers', ...args }, logger);
      expect(res.success).toBe(false);
      expect(res.failureKind).toBe('policy');
    }
  });

  test("a tenant bot's entity is not shown to other bots' non-operator callers", async () => {
    const out = await run({ _botId: 'b1' }, { isTenantBot: (id: string) => id === 't1' });
    expect(out).not.toContain('Tenant helper');
    expect(out).toContain('Scout');
  });
});

describe('buildFleetMemoryPrefetch', () => {
  const canary = () =>
    graph.addNeuron({
      kind: 'fact',
      text: 'The canary codeword for the heron project is heliotrope',
      support: { bots: ['b1'] },
      createdBy: 'watcher',
      meta: { operatorSourced: 'true' },
    });

  test('the operator gets a "What the fleet knows" section naming the supporting bot', async () => {
    canary();
    const out = await buildFleetMemoryPrefetch(
      { graph },
      'what is the canary codeword for the heron project',
      { operator: true, botId: 'b2' },
      logger
    );
    expect(out).toContain('## What the fleet knows');
    expect(out).toContain('heliotrope');
    expect(out).toContain('known by Jarvis');
    expect(out).toContain('<<<EXTERNAL_UNTRUSTED_CONTENT>>>');
  });

  test('ranked like the tool: at most 5 lines, best first', async () => {
    for (let i = 0; i < 8; i++) add(`heron sighting number ${i} near the water tower`);
    const out = (await buildFleetMemoryPrefetch(
      { graph },
      'heron sighting near the water tower',
      { operator: true },
      logger
    )) as string;
    expect(out.match(/^- \[/gm)?.length).toBe(FLEET_PREFETCH_RESULTS);
  });

  test('anyone else does not see operator-sourced material', async () => {
    canary();
    const out = await buildFleetMemoryPrefetch(
      { graph },
      'what is the canary codeword for the heron project',
      { operator: false, botId: 'b1' },
      logger
    );
    expect(out).toBeNull();
  });

  test('null for a short query or no match; an embedder that fails falls back to text', async () => {
    // Embedded, so the failing embedder below is actually called.
    graph.setEmbedding(canary().id, [1, 0]);
    expect(
      await buildFleetMemoryPrefetch({ graph }, 'hola', { operator: true }, logger)
    ).toBeNull();
    expect(
      await buildFleetMemoryPrefetch(
        { graph },
        'quarterly tax filing deadline',
        { operator: true },
        logger
      )
    ).toBeNull();
    let calls = 0;
    const failing = {
      graph,
      embed: async () => {
        calls++;
        throw new Error('ollama down');
      },
    };
    const out = await buildFleetMemoryPrefetch(
      failing,
      'canary codeword heron project',
      { operator: true },
      logger
    );
    expect(out).toContain('heliotrope');
    expect(calls).toBe(1);
  });
});

describe('buildFleetMemoryPrefetch: the query embedding', () => {
  const counting = () => {
    const calls: string[] = [];
    return {
      calls,
      embed: async (text: string) => {
        calls.push(text);
        return [1, 0];
      },
    };
  };

  test('not embedded when no visible live neuron has an embedding', async () => {
    add('the canary codeword for the heron project is heliotrope');
    const e = counting();
    const out = await buildFleetMemoryPrefetch(
      { graph, embed: e.embed },
      'canary codeword heron project',
      { operator: true },
      logger
    );
    expect(out).toContain('heliotrope');
    expect(e.calls).toEqual([]);
  });

  test('not embedded when the only embedded neurons are archived or not visible', async () => {
    const other = add('Scout tracks the heron project budget', ['b2']);
    graph.setEmbedding(other.id, [1, 0]);
    const gone = add('the heron project closed last week');
    graph.setEmbedding(gone.id, [1, 0]);
    graph.archive(gone.id);
    const e = counting();
    await buildFleetMemoryPrefetch(
      { graph, embed: e.embed },
      'what about the heron project',
      { operator: false, botId: 'b1' },
      logger
    );
    expect(e.calls).toEqual([]);
  });

  test('embedded once when a visible live neuron has an embedding', async () => {
    const n = add('the canary codeword for the heron project is heliotrope');
    graph.setEmbedding(n.id, [1, 0]);
    const e = counting();
    await buildFleetMemoryPrefetch(
      { graph, embed: e.embed },
      'canary codeword heron project',
      { operator: true },
      logger
    );
    expect(e.calls).toEqual(['canary codeword heron project']);
  });
});

describe('O10 summaries in fleet memory', () => {
  const summary = (meta: Record<string, string>) =>
    ({
      id: 'n-00000009',
      kind: 'summary',
      text: 'Deploys kept failing on a stale cache',
      support: { bots: ['b1', 'b2'] },
      createdBy: 'watcher',
      createdAt: '',
      lastActivatedAt: '',
      activations: 0,
      meta: { consolidated: 'true', ...meta },
    }) as never;

  test('a summary of operator-sourced facts is shown only to the operator', () => {
    const s = summary({ operatorSourced: 'true', operatorMessage: 'true' });
    expect(visibleTo(s, { operator: true })).toBe(true);
    expect(visibleTo(s, { operator: false, botId: 'b1' })).toBe(false);
  });

  test('a public summary is shown to the bots it came from, not to others', () => {
    const s = summary({ operatorMessage: 'false' });
    expect(visibleTo(s, { operator: false, botId: 'b2' })).toBe(true);
    expect(visibleTo(s, { operator: false, botId: 'b3' })).toBe(false);
  });
});
