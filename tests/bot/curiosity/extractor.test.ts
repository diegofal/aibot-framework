import { describe, expect, it } from 'bun:test';
import { CURIOSITY_PRESETS } from '../../../src/bot/curiosity/config';
import {
  MIN_DIRECTIVE_CHARS,
  buildExtractorPrompt,
  parseExtractorResult,
  runExtractor,
} from '../../../src/bot/curiosity/extractor';
import type { ExtractorInput } from '../../../src/bot/curiosity/extractor';

const logger = { warn: () => {}, info: () => {}, debug: () => {}, error: () => {} } as any;

const input = (over: Partial<ExtractorInput> = {}): ExtractorInput => ({
  identity: 'AI Perfectionist',
  deliverable: 'Write a reranking eval',
  plan: ['Read cookbook', 'Write eval'],
  summary: 'Wrote productions/22_rerank.ts; reranking lifted top-1 from 5% to 18%.',
  toolCalls: [{ name: 'file_write', args: { path: 'productions/22_rerank.ts' }, success: true }],
  mode: 'exploit',
  knownTopics: ['harness evaluation'],
  directives: '## Operator Instructions\n- [ab12] Research Jev',
  limits: CURIOSITY_PRESETS.explorer,
  ...over,
});

const goodJson = JSON.stringify({
  topic: 'Retrieval reranking',
  findings: [
    {
      claim: 'Reranking lifts top-1 5%→18%',
      evidence: 'productions/22_rerank.ts',
      confidence: 'medium',
    },
  ],
  surprises: ['bigger embeddings did less than a cheap reranker'],
  open_questions: ['Does it hold on code search?'],
  answered_questions: [],
  frontier: [
    {
      question: 'Do rerankers reduce eval variance?',
      why_interesting: 'could flip rankings',
      bridge: 'evals are core',
      distance: 1,
      surprise_score: 0.7,
    },
  ],
  served_directive_ids: ['ab12'],
  no_surprise: false,
  interests: [],
  dispatch: {
    hook: 'A cheap reranker beat a 4x bigger embedding model',
    why_care: 'you are choosing an embedding model this month',
    evidence: '5%→18% top-1 on the cookbook corpus',
    action: 'try a reranker before upgrading embeddings',
  },
});

describe('buildExtractorPrompt', () => {
  it('includes the cycle, known topics, directives and asks for surprises', () => {
    const { system, prompt } = buildExtractorPrompt(input());
    const all = system + prompt;
    expect(all).toContain('Write a reranking eval');
    expect(all).toContain('productions/22_rerank.ts');
    expect(all).toContain('harness evaluation');
    expect(all).toContain('[ab12]');
    expect(all).toContain('What did you NOT expect');
  });

  it('marks exploration cycles and the frontier target', () => {
    const { system } = buildExtractorPrompt(
      input({ mode: 'explore', frontierQuestion: 'Do rerankers reduce variance?' })
    );
    expect(system).toContain('exploration cycle');
    expect(system).toContain('Do rerankers reduce variance?');
  });

  it('truncates a huge summary', () => {
    const { prompt } = buildExtractorPrompt(input({ summary: 'x'.repeat(20_000) }));
    expect(prompt.length).toBeLessThan(10_000);
  });
});

describe('parseExtractorResult', () => {
  it('parses snake_case JSON into an extraction + dispatch candidate', () => {
    const r = parseExtractorResult(goodJson, logger)!;
    expect(r.extraction.topic).toBe('Retrieval reranking');
    expect(r.extraction.findings[0].confidence).toBe('medium');
    expect(r.extraction.openQuestions).toEqual(['Does it hold on code search?']);
    expect(r.extraction.frontier[0]).toMatchObject({
      whyInteresting: 'could flip rankings',
      surpriseScore: 0.7,
      distance: 1,
    });
    expect(r.extraction.servedDirectiveIds).toEqual(['ab12']);
    expect(r.extraction.noSurprise).toBe(false);
    expect(r.dispatch?.hook).toContain('cheap reranker');
    expect(r.dispatch?.whyCare).toContain('embedding model');
  });

  it('accepts camelCase too and tolerates surrounding prose', () => {
    const raw = `Here you go:\n${JSON.stringify({
      topic: 'X',
      findings: [],
      surprises: [],
      openQuestions: [],
      frontier: [],
      servedDirectiveIds: [],
      noSurprise: true,
    })}\nthanks`;
    const r = parseExtractorResult(raw, logger)!;
    expect(r.extraction.topic).toBe('X');
    expect(r.extraction.noSurprise).toBe(true);
    expect(r.dispatch).toBeNull();
  });

  it('derives noSurprise from an empty surprises list when missing', () => {
    const r = parseExtractorResult(JSON.stringify({ topic: 'X', surprises: [] }), logger)!;
    expect(r.extraction.noSurprise).toBe(true);
  });

  it('drops malformed entries and bad confidence', () => {
    const r = parseExtractorResult(
      JSON.stringify({
        topic: 'X',
        findings: [{ claim: '' }, { claim: 'ok', confidence: 'certain' }, 'junk'],
        frontier: [{ question: '' }, { question: 'q?', distance: 'far' }],
        surprises: ['s', 3],
      }),
      logger
    )!;
    expect(r.extraction.findings).toEqual([
      { claim: 'ok', evidence: undefined, confidence: 'low' },
    ]);
    expect(r.extraction.frontier).toHaveLength(1);
    expect(r.extraction.frontier[0].distance).toBe(1);
    expect(r.extraction.surprises).toEqual(['s']);
  });

  it('rejects a dispatch without a hook', () => {
    const r = parseExtractorResult(
      JSON.stringify({ topic: 'X', dispatch: { hook: '', why_care: 'y' } }),
      logger
    )!;
    expect(r.dispatch).toBeNull();
  });

  it('returns null without a topic', () => {
    expect(parseExtractorResult('{"findings":[]}', logger)).toBeNull();
    expect(parseExtractorResult('not json', logger)).toBeNull();
  });
});

describe('runExtractor', () => {
  it('retries once on parse failure', async () => {
    const temps: number[] = [];
    const client = {
      generate: async (_p: string, o: { temperature: number }) => {
        temps.push(o.temperature);
        return { text: temps.length === 1 ? 'garbage' : goodJson };
      },
    } as any;
    const r = await runExtractor(client, 'm', input(), logger);
    expect(r?.extraction.topic).toBe('Retrieval reranking');
    expect(temps).toEqual([0.3, 0]);
  });

  it('returns null after two failures', async () => {
    const client = { generate: async () => ({ text: 'nope' }) } as any;
    expect(await runExtractor(client, 'm', input(), logger)).toBeNull();
  });
});

describe('MIN_DIRECTIVE_CHARS', () => {
  it('filters chatter like "thanks!"', () => {
    expect(MIN_DIRECTIVE_CHARS).toBeGreaterThan('thanks!'.length);
  });
});
