import { describe, expect, test } from 'bun:test';
import { NEURON_KINDS, type Neuron } from '../../src/watcher/types';
import { neuronToWhy } from '../../src/why/builders/watcher';
import { WhySchema } from '../../src/why/types';
import { whyPanel } from '../../web/pages/why-helpers.js';

const base: Neuron = {
  id: 'n-00000001',
  kind: 'fact',
  text: 'Acme ships on Mondays',
  support: { bots: ['b1'] },
  createdBy: 'bot:b1',
  createdAt: '2026-10-23T10:00:00.000Z',
  lastActivatedAt: '2026-10-23T10:00:00.000Z',
  activations: 0,
  meta: { key: 'fact:b1:f1', stage: 'birth:knowledge' },
};

const topic: Neuron = { ...base, id: 'n-00000002', kind: 'topic', text: 'Suppliers' };

describe('neuronToWhy', () => {
  for (const kind of NEURON_KINDS) {
    test(`${kind}: a valid Why rendered by the shared panel`, () => {
      const why = neuronToWhy({ neuron: { ...base, kind }, edges: [], neighbours: [] });
      const parsed = WhySchema.safeParse(why);
      expect(parsed.success ? null : parsed.error.issues).toBeNull();
      expect(whyPanel(why)).toStartWith('<details class="why">');
    });
  }

  test('a bot-made neuron is by the agent and names the bot and the birth stage', () => {
    const why = neuronToWhy({ neuron: base, edges: [], neighbours: [] });
    expect(why.what).toBe('Fact: "Acme ships on Mondays"');
    expect(why.by).toBe('agent');
    expect(why.notes).toContainEqual({ label: 'Brought by', text: 'b1' });
    expect(why.notes).toContainEqual({
      label: 'Created',
      text: 'At birth, reading the knowledge map',
    });
    expect(why.outcome).toBe('Never activated since it was created.');
  });

  test('a watcher-made neuron is by the watcher', () => {
    const why = neuronToWhy({
      neuron: { ...base, createdBy: 'watcher', meta: {} },
      edges: [],
      neighbours: [],
    });
    expect(why.by).toBe('watcher');
    expect(why.notes?.some((n) => n.label === 'Brought by')).toBe(false);
  });

  test('neighbours are the related items', () => {
    const edge = {
      id: 'e-1',
      from: base.id,
      to: topic.id,
      rel: 'about' as const,
      weight: 1,
      createdAt: base.createdAt,
      createdBy: 'bot:b1' as const,
    };
    const why = neuronToWhy({ neuron: base, edges: [edge], neighbours: [{ neuron: topic, edge }] });
    expect(why.related?.items).toEqual([{ text: 'about → topic: Suppliers' }]);
  });

  test('activations and archive become the outcome', () => {
    const why = neuronToWhy({
      neuron: {
        ...base,
        activations: 3,
        lastActivatedAt: '2026-10-22T09:00:00.000Z',
        archivedAt: '2026-10-23T00:00:00.000Z',
      },
      edges: [],
      neighbours: [],
    });
    expect(why.outcome).toBe('Activated 3 times, last on 2026-10-22. Archived on 2026-10-23.');
  });

  test('the cycle it came from, with plan and goal from the cycle log', () => {
    const why = neuronToWhy({
      neuron: { ...base, support: { bots: ['b1'], cycles: ['c1'] } },
      edges: [],
      neighbours: [],
      cycle: {
        cycleId: 'c1',
        startedAt: '2026-10-22T08:00:00Z',
        planSummary: 'Look into Acme',
        goalTitle: 'Research',
      },
    });
    expect(why.cycle?.id).toBe('c1');
    expect(why.cycle?.plan).toBe('Look into Acme');
    expect(why.goal?.title).toBe('Research');
  });

  test('confidence and source path are notes', () => {
    const why = neuronToWhy({
      neuron: { ...base, confidence: 'high', meta: { source: 'memory/2026-10-01.md' } },
      edges: [],
      neighbours: [],
    });
    expect(why.notes).toContainEqual({ label: 'Confidence', text: 'high' });
    expect(why.notes).toContainEqual({ label: 'Source', text: 'memory/2026-10-01.md' });
  });
});

describe('neuronToWhy, O10 forgetting and consolidation', () => {
  test('an archived neuron says why it was archived', () => {
    const why = neuronToWhy({
      neuron: {
        ...base,
        archivedAt: '2026-10-24T04:00:00.000Z',
        meta: { archivedReason: 'importance 0.02: never used, one bot, no consequence' },
      },
      edges: [],
      neighbours: [],
    });
    expect(why.notes).toContainEqual({
      label: 'Why archived',
      text: 'importance 0.02: never used, one bot, no consequence',
    });
    expect(WhySchema.safeParse(why).success).toBe(true);
  });

  test('a neuron that came back from the archive says when and why it had gone', () => {
    const why = neuronToWhy({
      neuron: {
        ...base,
        meta: {
          archivedReason: 'importance 0.02: never used, one bot, no consequence',
          returnedAt: '2026-10-25T09:00:00.000Z',
        },
      },
      edges: [],
      neighbours: [],
    });
    expect(why.notes).toContainEqual({
      label: 'Returned',
      text: 'Back from the archive on 2026-10-25 (it had gone: importance 0.02: never used, one bot, no consequence)',
    });
    expect(why.notes?.some((n) => n.label === 'Why archived')).toBe(false);
  });

  test('a summary names how many facts it consolidates', () => {
    const why = neuronToWhy({
      neuron: {
        ...base,
        kind: 'summary',
        createdBy: 'watcher',
        meta: { consolidated: 'true', members: 'n-1,n-2,n-3' },
      },
      edges: [],
      neighbours: [],
    });
    expect(why.what).toBe('Summary: "Acme ships on Mondays"');
    expect(why.notes).toContainEqual({
      label: 'Consolidated',
      text: 'From 3 related facts, while the fleet slept',
    });
  });
});
