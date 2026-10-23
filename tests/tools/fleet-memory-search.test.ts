import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  FLEET_MEMORY_MAX_RESULTS,
  createFleetMemorySearchTool,
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

describe('fleet_memory_search', () => {
  test('ranks by text when there are no embeddings, best first', async () => {
    add('The blue heron nests behind the old water tower');
    add('Water bills are paid on the first of the month');
    add('Nothing about birds here');
    const tool = createFleetMemorySearchTool(() => ({ graph }));
    const res = await tool.execute({ query: 'where does the heron nest' }, logger);
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
    const res = await tool.execute({ query: 'heron nests' }, logger);
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
    const res = await tool.execute({ query: 'zzz' }, logger);
    expect(res.content.indexOf('Beta thing')).toBeGreaterThan(-1);
    expect(res.content).not.toContain('Alpha thing');
  });

  test('a failing embed falls back to text', async () => {
    add('The blue heron nests behind the old water tower');
    const tool = createFleetMemorySearchTool(() => ({
      graph,
      embed: async () => {
        throw new Error('ollama down');
      },
    }));
    const res = await tool.execute({ query: 'heron nests' }, logger);
    expect(res.content).toContain('blue heron');
  });

  test('archived neurons are excluded', async () => {
    const n = add('The blue heron nests behind the old water tower');
    graph.archive(n.id);
    const tool = createFleetMemorySearchTool(() => ({ graph }));
    const res = await tool.execute({ query: 'heron nests' }, logger);
    expect(res.content).not.toContain('blue heron');
    expect(res.content).toContain('Nothing in the fleet memory');
  });

  test('results are wrapped as external content', async () => {
    add('The blue heron nests behind the old water tower');
    const tool = createFleetMemorySearchTool(() => ({ graph }));
    const res = await tool.execute({ query: 'heron' }, logger);
    expect(res.content.startsWith('<<<EXTERNAL_UNTRUSTED_CONTENT>>>')).toBe(true);
    expect(res.content.endsWith('<<<END_EXTERNAL_UNTRUSTED_CONTENT>>>')).toBe(true);
  });

  test('limit caps the results, never above the maximum', async () => {
    for (let i = 0; i < 15; i++) add(`heron sighting number ${i}`);
    const tool = createFleetMemorySearchTool(() => ({ graph }));
    const count = (s: string) => (s.match(/^\d+\. /gm) ?? []).length;
    expect(count((await tool.execute({ query: 'heron sighting', limit: 3 }, logger)).content)).toBe(
      3
    );
    expect(
      count((await tool.execute({ query: 'heron sighting', limit: 50 }, logger)).content)
    ).toBe(FLEET_MEMORY_MAX_RESULTS);
  });

  test('a missing query is an error', async () => {
    const tool = createFleetMemorySearchTool(() => ({ graph }));
    expect((await tool.execute({ query: '  ' }, logger)).success).toBe(false);
  });

  test('without a watcher it says the fleet memory is not available', async () => {
    const tool = createFleetMemorySearchTool(() => undefined);
    const res = await tool.execute({ query: 'heron' }, logger);
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
    const res = await setupPrivate().execute({ ...query, _actor: 'self' }, logger);
    expect(res.content).toContain('school calendar changes');
  });
});
