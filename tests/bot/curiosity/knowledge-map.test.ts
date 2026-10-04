import { describe, expect, it } from 'bun:test';
import {
  KNOWLEDGE_CAPS,
  emptyKnowledgeMap,
  markFrontier,
  mergeExtraction,
  pruneKnowledgeMap,
  renderKnowledgeForPrompt,
  setFrontierSignal,
  topicId,
} from '../../../src/bot/curiosity/knowledge-map';
import type { CycleExtraction } from '../../../src/bot/curiosity/knowledge-map';

const NOW = '2026-10-03T12:00:00.000Z';

const extraction = (over: Partial<CycleExtraction> = {}): CycleExtraction => ({
  topic: 'Harness evaluation',
  findings: [{ claim: 'Retry harnesses inflate pass@1', evidence: 'p/03.ts', confidence: 'high' }],
  surprises: ['k=8 beats a stronger model'],
  openQuestions: ['Does it hold on SWE-bench?'],
  frontier: [
    {
      question: 'How do retrieval rerankers change eval variance?',
      whyInteresting: 'could invert rankings',
      bridge: 'evals are the operator craft',
      distance: 1,
      surpriseScore: 0.7,
    },
  ],
  servedDirectiveIds: [],
  noSurprise: false,
  outputs: ['productions/03.ts'],
  ...over,
});

describe('topicId', () => {
  it('slugs names stably', () => {
    expect(topicId('Harness Evaluation!')).toBe('harness-evaluation');
    expect(topicId('  KV  cache / budget ')).toBe('kv-cache-budget');
  });
  it('never returns empty', () => {
    expect(topicId('???')).toBe('general');
  });
});

describe('mergeExtraction', () => {
  it('creates a topic with findings, surprises, questions, outputs', () => {
    const map = mergeExtraction(emptyKnowledgeMap(), extraction(), NOW);
    expect(map.topics).toHaveLength(1);
    const t = map.topics[0];
    expect(t.id).toBe('harness-evaluation');
    expect(t.cycles).toBe(1);
    expect(t.depth).toBe(0);
    expect(t.findings[0].claim).toBe('Retry harnesses inflate pass@1');
    expect(t.surprises[0].text).toBe('k=8 beats a stronger model');
    expect(t.openQuestions).toEqual(['Does it hold on SWE-bench?']);
    expect(t.outputs).toEqual(['productions/03.ts']);
    expect(map.updatedAt).toBe(NOW);
  });

  it('adds frontier items as open, tagged with the source topic', () => {
    const map = mergeExtraction(emptyKnowledgeMap(), extraction(), NOW);
    expect(map.frontier).toHaveLength(1);
    expect(map.frontier[0].status).toBe('open');
    expect(map.frontier[0].fromTopic).toBe('harness-evaluation');
  });

  it('merges into an existing topic and deduplicates near-identical text', () => {
    let map = mergeExtraction(emptyKnowledgeMap(), extraction(), NOW);
    map = mergeExtraction(map, extraction({ topic: 'harness evaluation' }), NOW);
    expect(map.topics).toHaveLength(1);
    const t = map.topics[0];
    expect(t.cycles).toBe(2);
    expect(t.findings).toHaveLength(1);
    expect(t.surprises).toHaveLength(1);
    expect(t.openQuestions).toHaveLength(1);
    expect(map.frontier).toHaveLength(1);
  });

  it('grows depth with findings', () => {
    let map = emptyKnowledgeMap();
    for (let i = 0; i < 8; i++) {
      map = mergeExtraction(
        map,
        extraction({
          findings: [{ claim: `distinct finding number ${i} about x${i}`, confidence: 'medium' }],
        }),
        NOW
      );
    }
    expect(map.topics[0].depth).toBeGreaterThanOrEqual(2);
  });

  it('removes open questions the cycle answered', () => {
    let map = mergeExtraction(emptyKnowledgeMap(), extraction(), NOW);
    map = mergeExtraction(
      map,
      extraction({ openQuestions: [], answeredQuestions: ['Does it hold on SWE-bench?'] }),
      NOW
    );
    expect(map.topics[0].openQuestions).toEqual([]);
  });

  it('records grown interests', () => {
    const map = mergeExtraction(
      emptyKnowledgeMap(),
      extraction({ interests: ['information theory'] }),
      NOW
    );
    expect(map.interests).toEqual(['information theory']);
  });

  it('does not mutate the input map', () => {
    const base = emptyKnowledgeMap();
    mergeExtraction(base, extraction(), NOW);
    expect(base.topics).toHaveLength(0);
  });

  it('clamps frontier distance and surprise score', () => {
    const map = mergeExtraction(
      emptyKnowledgeMap(),
      extraction({
        frontier: [{ question: 'x?', whyInteresting: 'y', distance: -3, surpriseScore: 7 }],
      }),
      NOW
    );
    expect(map.frontier[0].distance).toBe(0);
    expect(map.frontier[0].surpriseScore).toBe(1);
  });
});

describe('pruneKnowledgeMap', () => {
  it('caps per-topic lists, keeping the newest', () => {
    let map = emptyKnowledgeMap();
    for (let i = 0; i < KNOWLEDGE_CAPS.findingsPerTopic + 5; i++) {
      map = mergeExtraction(
        map,
        extraction({
          findings: [{ claim: `unique claim ${i} zz${i * 7}`, confidence: 'low' }],
          surprises: [],
          frontier: [],
        }),
        NOW
      );
    }
    expect(map.topics[0].findings.length).toBe(KNOWLEDGE_CAPS.findingsPerTopic);
    expect(map.topics[0].findings.at(-1)?.claim).toContain(
      `unique claim ${KNOWLEDGE_CAPS.findingsPerTopic + 4}`
    );
  });

  it('drops dropped/explored frontier first when over the cap', () => {
    const map = emptyKnowledgeMap();
    for (let i = 0; i < KNOWLEDGE_CAPS.frontier + 3; i++) {
      map.frontier.push({
        id: `f${i}`,
        question: `q${i}`,
        whyInteresting: 'w',
        distance: 1,
        surpriseScore: 0.5,
        createdAt: NOW,
        status: i < 3 ? 'dropped' : 'open',
      });
    }
    const pruned = pruneKnowledgeMap(map);
    expect(pruned.frontier).toHaveLength(KNOWLEDGE_CAPS.frontier);
    expect(pruned.frontier.some((f) => f.status === 'dropped')).toBe(false);
  });
});

describe('frontier mutations', () => {
  it('markFrontier sets status and explored time', () => {
    const map = mergeExtraction(emptyKnowledgeMap(), extraction(), NOW);
    const id = map.frontier[0].id;
    const next = markFrontier(map, id, 'explored', NOW);
    expect(next.frontier[0].status).toBe('explored');
    expect(next.frontier[0].exploredAt).toBe(NOW);
  });

  it('setFrontierSignal down drops the item, up keeps it open', () => {
    const map = mergeExtraction(emptyKnowledgeMap(), extraction(), NOW);
    const id = map.frontier[0].id;
    expect(setFrontierSignal(map, id, 'down').frontier[0].status).toBe('dropped');
    const up = setFrontierSignal(map, id, 'up').frontier[0];
    expect(up.operatorSignal).toBe('up');
    expect(up.status).toBe('open');
  });

  it('returns null for an unknown id', () => {
    expect(setFrontierSignal(emptyKnowledgeMap(), 'nope', 'up')).toBeNull();
  });
});

describe('renderKnowledgeForPrompt', () => {
  it('says so when empty', () => {
    expect(renderKnowledgeForPrompt(emptyKnowledgeMap())).toContain('nothing yet');
  });

  it('lists topics with depth, latest findings, surprises and open questions', () => {
    const map = mergeExtraction(emptyKnowledgeMap(), extraction(), NOW);
    const text = renderKnowledgeForPrompt(map);
    expect(text).toContain('## What You Have Learned');
    expect(text).toContain('Harness evaluation');
    expect(text).toContain('Retry harnesses inflate pass@1');
    expect(text).toContain('k=8 beats a stronger model');
    expect(text).toContain('Does it hold on SWE-bench?');
  });

  it('stays under the char budget', () => {
    let map = emptyKnowledgeMap();
    for (let i = 0; i < 30; i++) {
      map = mergeExtraction(map, extraction({ topic: `topic number ${i}` }), NOW);
    }
    expect(renderKnowledgeForPrompt(map, 2000).length).toBeLessThanOrEqual(2000);
  });
});
