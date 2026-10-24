import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HygieneRegistry } from '../../src/hygiene/registry';
import { isBareDateHeader, watcherGraph } from '../../src/hygiene/routines/watcher-graph';
import { rankFleetMemory } from '../../src/tools/fleet-memory-search';
import { Graph } from '../../src/watcher/graph';
import type { Neuron } from '../../src/watcher/types';
import { makeConfig, makeCtx, makeDeps, noopLogger } from './helpers';

let root: string;
let t: number;
let g: Graph;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'hyg-watcher-graph-'));
  t = Date.parse('2026-10-20T10:00:00Z');
  g = new Graph(join(root, 'data', 'watcher'), { now: () => t });
  g.load();
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function birthFact(text: string, bot = 'b1', extra: Partial<Neuron> = {}): Neuron {
  t += 1000;
  return g.addNeuron({
    kind: 'fact',
    text,
    support: { bots: [bot], paths: ['MEMORY.md'] },
    createdBy: `bot:${bot}`,
    meta: { stage: 'birth:memory', key: `memory:${bot}:${text}` },
    ...extra,
  });
}

const ctx = (options: Record<string, unknown> = {}) =>
  makeCtx(root, {
    botId: null,
    soulDir: null,
    workDir: null,
    options,
    deps: makeDeps({ watcherGraph: () => g }),
  });

const ofKind = (findings: { kind: string }[], kind: string) =>
  findings.filter((f) => f.kind === kind);

describe('isBareDateHeader', () => {
  test('a bold or bracketed date alone is a header; a dated fact is not', () => {
    expect(isBareDateHeader('**[2026-10-16]**')).toBe(true);
    expect(isBareDateHeader('[2026-10-16]')).toBe(true);
    expect(isBareDateHeader('## 2026-10-16:')).toBe(true);
    expect(isBareDateHeader('2026-10-16: the operator moved to Madrid')).toBe(false);
  });
});

describe('watcher-graph routine', () => {
  test('is a fleet routine that can apply', () => {
    expect(watcherGraph.scope).toBe('fleet');
    expect(watcherGraph.canApply).toBe(true);
  });

  test('without a live watcher graph it reports that and changes nothing', () => {
    const findings = watcherGraph.preview(makeCtx(root, { botId: null, soulDir: null }));
    expect(findings).toHaveLength(1);
    expect(findings[0].kind).toBe('watcher-unavailable');
    expect(findings[0].fixable).toBe(false);
  });

  test('preview finds date headers and bookkeeping birth facts, keeps real facts, writes nothing', () => {
    const header = birthFact('**[2026-10-16]**');
    const trace = birthFact('ask_human 3fa9c21e enviada');
    const real = birthFact('The operator prefers short weekly summaries');
    const notBirth = g.addNeuron({
      kind: 'fact',
      text: '**[2026-10-17]**',
      support: { bots: ['b1'] },
      createdBy: 'watcher',
    });
    const rev = g.getRev();
    const findings = watcherGraph.preview(ctx());
    expect(ofKind(findings, 'date-header-fact').map((f) => f.data?.neuronId)).toEqual([header.id]);
    expect(ofKind(findings, 'bookkeeping-fact').map((f) => f.data?.neuronId)).toEqual([trace.id]);
    const ids = findings.flatMap((f) => [f.data?.neuronId, f.data?.keepId]);
    expect(ids).not.toContain(real.id);
    expect(ids).not.toContain(notBirth.id);
    expect(g.getRev()).toBe(rev);
    const summary = ofKind(findings, 'graph-summary')[0];
    expect(summary.message).toContain('1 date header');
    expect(summary.message).toContain('1 bookkeeping');
  });

  test('near-duplicates of one bot merge into the newest; another bot is never merged in', () => {
    const oldest = birthFact('The client invoices on the first Monday of each month', 'b1', {
      activations: 2,
    } as Partial<Neuron>);
    const dup = birthFact('the client invoices on the first monday of each month.', 'b1', {
      activations: 3,
    } as Partial<Neuron>);
    const otherBot = birthFact('The client invoices on the first Monday of each month', 'b2');
    const findings = watcherGraph.preview(ctx());
    const merges = ofKind(findings, 'duplicate-facts');
    expect(merges).toHaveLength(1);
    // The later line is the likelier correction: it is the keeper.
    expect(merges[0].data).toEqual({ keepId: dup.id, dropIds: [oldest.id] });

    const res = watcherGraph.apply(ctx(), findings);
    expect(res.applied.some((a) => a.action === 'merge')).toBe(true);
    expect(g.get(dup.id)?.activations).toBe(5);
    expect(g.get(dup.id)?.archivedAt).toBeUndefined();
    expect(g.get(oldest.id)?.archivedAt).toBeDefined();
    expect(g.get(otherBot.id)?.archivedAt).toBeUndefined();
    expect(res.backups).toEqual([]);
  });

  test('a fact and its negation are never merged, however similar', () => {
    const pays = birthFact('The client will pay the invoice on the first Monday of each month');
    const wontPay = birthFact(
      'The client will not pay the invoice on the first Monday of each month'
    );
    expect(g.findSimilarText(pays.text, 0.9).map((n) => n.id)).toContain(wontPay.id);
    const findings = watcherGraph.preview(ctx());
    expect(ofKind(findings, 'duplicate-facts')).toEqual([]);
    watcherGraph.apply(ctx(), findings);
    expect(g.get(pays.id)?.archivedAt).toBeUndefined();
    expect(g.get(wontPay.id)?.archivedAt).toBeUndefined();
  });

  test("Spanish negations and n't forms count as negations too", () => {
    const paga = birthFact(
      'El cliente paga la factura de la oficina el primer lunes de cada mes por transferencia'
    );
    const nunca = birthFact(
      'El cliente nunca paga la factura de la oficina el primer lunes de cada mes por transferencia'
    );
    const tail =
      ' want the weekly summary of the whole fleet sent by email on monday mornings before nine with every open question and pending approval listed at the very top of it';
    const does = birthFact(`The operator does${tail}`);
    const doesnt = birthFact(`The operator doesn't${tail}`);
    expect(g.findSimilarText(paga.text, 0.9).map((n) => n.id)).toContain(nunca.id);
    expect(g.findSimilarText(does.text, 0.9).map((n) => n.id)).toContain(doesnt.id);
    expect(ofKind(watcherGraph.preview(ctx()), 'duplicate-facts')).toEqual([]);
  });

  test('two facts that differ only by a date or a number are never merged', () => {
    const oct = birthFact(
      'The client pays the office rent invoice for the downtown studio on 2026-10-01 by bank transfer every single quarter'
    );
    const nov = birthFact(
      'The client pays the office rent invoice for the downtown studio on 2026-11-01 by bank transfer every single quarter'
    );
    expect(g.findSimilarText(oct.text, 0.9).map((n) => n.id)).toContain(nov.id);
    expect(ofKind(watcherGraph.preview(ctx()), 'duplicate-facts')).toEqual([]);
  });

  test('apply archives (never deletes) and archived neurons leave fleet_memory_search', async () => {
    const header = birthFact('**[2026-10-16]**');
    const real = birthFact('The operator prefers short weekly summaries');
    const findings = watcherGraph.preview(ctx());
    const res = watcherGraph.apply(ctx(), findings);
    expect(res.applied.map((a) => a.action)).toContain('archive');
    expect(g.get(header.id)?.archivedAt).toBeDefined();
    expect(g.get(header.id)?.meta?.archivedBy).toBe('hygiene:watcher-graph');
    expect(g.size()).toBe(2);

    const hits = await rankFleetMemory(
      { graph: g },
      '2026-10-16 operator summaries',
      {
        operator: true,
      },
      { limit: 5 }
    );
    const hitIds = hits.map((h) => h.n.id);
    expect(hitIds).not.toContain(header.id);
    expect(hitIds).toContain(real.id);

    // a second preview finds nothing left to fix
    const again = watcherGraph.preview(ctx()).filter((f) => f.fixable);
    expect(again).toEqual([]);
  });

  test('apply skips a finding whose neuron changed since the preview', () => {
    const header = birthFact('**[2026-10-16]**');
    const findings = watcherGraph.preview(ctx());
    g.archive(header.id);
    const res = watcherGraph.apply(ctx(), findings);
    expect(res.applied).toEqual([]);
    expect(res.skipped.map((s) => s.findingId)).toContain(
      findings.find((f) => f.kind === 'date-header-fact')?.id ?? ''
    );
  });

  test('registered in the registry, runs through the watcherGraph dep, not part of `all`', async () => {
    birthFact('**[2026-10-16]**');
    const registry = new HygieneRegistry({
      config: makeConfig(root),
      logger: noopLogger,
      watcherGraph: () => g,
    });
    expect(registry.listRoutines().map((r) => r.id)).toContain('watcher-graph');
    const run = await registry.run({ routine: 'watcher-graph', apply: true });
    expect(run.error).toBeUndefined();
    expect(run.applied).toHaveLength(1);
    expect(run.remaining?.filter((f) => f.fixable)).toEqual([]);

    birthFact('**[2026-10-18]**');
    const all = await registry.run({ routine: 'all', apply: true });
    expect(all.findings.some((f) => f.kind === 'date-header-fact')).toBe(false);
  });
});
