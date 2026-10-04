import { describe, expect, it } from 'bun:test';
import type { FrontierProposal } from '../../../src/bot/curiosity/cycle';
import {
  type DispatchCandidate,
  type EditorInput,
  type EditorResult,
  HYPE_PATTERNS,
  applyHypePenalty,
  applyRevision,
  buildDigestCandidate,
  buildDispatch,
  buildEditorPrompt,
  decideDispatch,
  findHypeWords,
  isCadenceOpen,
  parseEditorResult,
  proposalCandidate,
  renderDispatchBody,
  runEditor,
} from '../../../src/bot/curiosity/dispatch';
import type { Dispatch, DispatchSettings, FrontierItem } from '../../../src/bot/curiosity/types';
import type { LLMClient, LLMGenerateOptions } from '../../../src/core/llm-client';

const NOW = '2026-10-03T12:00:00.000Z';
const NOW_MS = Date.parse(NOW);
const logger = { warn: () => {}, info: () => {}, debug: () => {}, error: () => {} } as any;

const cand = (over: Partial<DispatchCandidate> = {}): DispatchCandidate => ({
  kind: 'insight',
  topic: 'retrieval',
  hook: 'Reranking beats bigger embeddings for our corpus.',
  whyCare: 'Your search bot pays for the large model on every query.',
  evidence: 'Ran 200 queries: rerank@small hit 0.81 vs 0.78 for large. productions/rerank.md',
  action: 'I will switch the bench to the small model next cycle.',
  ...over,
});

const settings = (over: Partial<DispatchSettings> = {}): DispatchSettings => ({
  enabled: true,
  maxChars: 1200,
  minEditorScore: 0.7,
  baseIntervalHours: 24,
  minIntervalHours: 6,
  maxIntervalHours: 168,
  ...over,
});

const editor = (over: Partial<EditorResult> = {}): EditorResult => ({
  insight: 0.9,
  novelty: 0.8,
  backed: 0.9,
  score: 0.87,
  verdict: 'send',
  notes: '',
  ...over,
});

const heldDispatch = (over: Partial<Dispatch> = {}): Dispatch => ({
  id: 'd1',
  botId: 'bot',
  createdAt: NOW,
  kind: 'insight',
  topic: 'retrieval',
  hook: 'hook',
  whyCare: 'w',
  evidence: 'e',
  action: 'a',
  body: 'b',
  editorScore: 0.5,
  status: 'held',
  ...over,
});

// ── hype ─────────────────────────────────────────────────────────────────

describe('findHypeWords', () => {
  it('exports a non-empty pattern list', () => {
    expect(HYPE_PATTERNS.length).toBeGreaterThan(5);
  });

  it('returns nothing for calm text', () => {
    expect(findHypeWords('Reranking beat the large model by 3 points on 200 queries.')).toEqual([]);
  });

  it('detects English hype case-insensitively', () => {
    const hits = findHypeWords('This is a GAME-CHANGER, truly Revolutionary and mind-blowing');
    expect(hits).toContain('game-changer');
    expect(hits).toContain('revolutionary');
    expect(hits).toContain('mind-blowing');
  });

  it('detects cliffhanger phrasing', () => {
    expect(findHypeWords("You won't believe what the logs show")).toContain("you won't believe");
    expect(findHypeWords('An insane, groundbreaking must-see result')).toEqual(
      expect.arrayContaining(['insane', 'groundbreaking', 'must-see'])
    );
  });

  it('detects Spanish equivalents', () => {
    const hits = findHypeWords(
      'Un hallazgo revolucionario, no vas a creer lo que encontré. Imperdible.'
    );
    expect(hits).toContain('revolutionary');
    expect(hits).toContain("you won't believe");
    expect(hits).toContain('must-see');
  });

  it('detects emoji spam but not a single emoji', () => {
    expect(findHypeWords('Done 🚀')).toEqual([]);
    expect(findHypeWords('Done 🚀🔥')).toContain('emoji spam');
  });

  it('detects excessive exclamation marks', () => {
    expect(findHypeWords('It works!')).toEqual([]);
    expect(findHypeWords('It works!!')).toContain('exclamation spam');
  });

  it('detects ALL-CAPS shouting but tolerates single acronyms', () => {
    expect(findHypeWords('The LLM and the API agree.')).toEqual([]);
    expect(findHypeWords('THIS CHANGES EVERYTHING')).toContain('all-caps shouting');
  });

  it('reports each pattern once', () => {
    expect(findHypeWords('insane insane INSANE')).toEqual(['insane']);
  });
});

// ── render ───────────────────────────────────────────────────────────────

describe('renderDispatchBody', () => {
  it('renders the format contract in order', () => {
    const body = renderDispatchBody(cand({ question: 'Should I also try the medium one?' }), {
      botName: 'Scout',
      emoji: '🔎',
      maxChars: 1200,
    });
    const lines = body.split('\n').filter(Boolean);
    expect(lines[0]).toBe('🔎 Scout: Reranking beats bigger embeddings for our corpus.');
    expect(lines[1]).toStartWith('Why it matters to you: ');
    expect(lines[2]).toStartWith('Evidence: ');
    expect(lines[3]).toStartWith('What to do: ');
    expect(lines[lines.length - 1]).toBe('Should I also try the medium one?');
  });

  it('omits the emoji prefix when none is given', () => {
    const body = renderDispatchBody(cand(), { botName: 'Scout', maxChars: 1200 });
    expect(body.split('\n')[0]).toBe('Scout: Reranking beats bigger embeddings for our corpus.');
  });

  it('adds the crossed dials and approve footer for proposals, before the question', () => {
    const body = renderDispatchBody(
      cand({ kind: 'proposal', crossing: ['topic', 'purpose'], question: 'Go?' }),
      { botName: 'Scout', maxChars: 1200 }
    );
    expect(body).toContain('studying outside my field');
    expect(body).toContain('a side quest beyond my job');
    expect(body).toContain('👍 to approve, 👎 to decline');
    expect(body.indexOf('👍')).toBeLessThan(body.indexOf('Go?'));
    expect(body.trimEnd().endsWith('Go?')).toBe(true);
  });

  it('insights carry no approve footer', () => {
    expect(renderDispatchBody(cand(), { botName: 'S', maxChars: 1200 })).not.toContain('👍');
  });

  it('renders a digest as a numbered list of hooks', () => {
    const digest = buildDigestCandidate([
      heldDispatch({ id: 'a', hook: 'First hook', editorScore: 0.6 }),
      heldDispatch({ id: 'b', hook: 'Second hook', editorScore: 0.4 }),
    ]);
    expect(digest).not.toBeNull();
    const body = renderDispatchBody(digest!, { botName: 'Scout', maxChars: 1200 });
    expect(body).toContain('1. First hook');
    expect(body).toContain('2. Second hook');
    expect(body).not.toContain('Evidence:');
  });

  it('never adds Markdown control characters of its own', () => {
    const body = renderDispatchBody(
      cand({
        kind: 'proposal',
        crossing: ['capability'],
        hook: 'h',
        whyCare: 'w',
        evidence: 'e',
        action: 'a',
      }),
      { botName: 'Bot', maxChars: 1200 }
    );
    expect(body).not.toMatch(/[*_`[]/);
  });

  it('leaves content Markdown as-is', () => {
    const body = renderDispatchBody(cand({ hook: 'use snake_case *now*' }), {
      botName: 'B',
      maxChars: 1200,
    });
    expect(body).toContain('use snake_case *now*');
  });

  it('never exceeds maxChars and truncates evidence first', () => {
    const c = cand({ evidence: 'E'.repeat(400) });
    const full = renderDispatchBody(c, { botName: 'Scout', maxChars: 5000 });
    const max = full.length - 100;
    const body = renderDispatchBody(c, { botName: 'Scout', maxChars: max });
    expect(body.length).toBeLessThanOrEqual(max);
    expect(body).toContain(c.whyCare);
    expect(body).toContain(c.action);
    expect(body).toContain('Evidence: EEE');
    expect(body).toContain('…');
  });

  it('truncates whyCare after evidence is exhausted, keeping action', () => {
    const c = cand({ evidence: 'E'.repeat(50), whyCare: 'W'.repeat(300), action: 'act now' });
    const full = renderDispatchBody(c, { botName: 'S', maxChars: 5000 });
    const body = renderDispatchBody(c, { botName: 'S', maxChars: full.length - 150 });
    expect(body.length).toBeLessThanOrEqual(full.length - 150);
    expect(body).not.toContain('Evidence:');
    expect(body).toContain('Why it matters to you: WWW');
    expect(body).toContain('What to do: act now');
  });

  it('truncates action last', () => {
    const c = cand({ evidence: 'E'.repeat(30), whyCare: 'W'.repeat(30), action: 'A'.repeat(300) });
    const body = renderDispatchBody(c, { botName: 'S', maxChars: 200 });
    expect(body.length).toBeLessThanOrEqual(200);
    expect(body).not.toContain('Evidence:');
    expect(body).not.toContain('Why it matters');
    expect(body).toContain('What to do: AAA');
  });

  it('never cuts the hook while it fits on its own', () => {
    const hook = 'H'.repeat(80);
    const c = cand({ hook, question: 'Q'.repeat(100) });
    const body = renderDispatchBody(c, { botName: 'S', maxChars: 90 });
    expect(body.length).toBeLessThanOrEqual(90);
    expect(body).toContain(hook);
  });

  it('cuts the hook with an ellipsis only when it alone exceeds the budget', () => {
    const c = cand({ hook: 'H'.repeat(200) });
    const body = renderDispatchBody(c, { botName: 'S', maxChars: 50 });
    expect(body.length).toBeLessThanOrEqual(50);
    expect(body.startsWith('S: HHH')).toBe(true);
    expect(body.endsWith('…')).toBe(true);
  });
});

// ── editor ───────────────────────────────────────────────────────────────

const editorInput = (over: Partial<EditorInput> = {}): EditorInput => ({
  candidate: cand(),
  knowledge: '## retrieval (depth 2)\n- rerank helps',
  taste: 'Liked: short benchmarks',
  identity: 'I am Scout, a research bot.',
  maxChars: 1200,
  ...over,
});

describe('buildEditorPrompt', () => {
  it('includes the candidate, knowledge, taste and identity', () => {
    const { system, prompt } = buildEditorPrompt(editorInput());
    expect(system.length).toBeGreaterThan(50);
    expect(prompt).toContain('Reranking beats bigger embeddings');
    expect(prompt).toContain('rerank helps');
    expect(prompt).toContain('short benchmarks');
    expect(prompt).toContain('I am Scout');
    expect(prompt).toContain('1200');
  });

  it('scores insight, novelty and backing and forbids manipulation', () => {
    const { system } = buildEditorPrompt(editorInput());
    const s = system.toLowerCase();
    for (const w of [
      'insight',
      'novelty',
      'backed',
      'hype',
      'cliffhanger',
      'withhold',
      'superlative',
    ]) {
      expect(s).toContain(w);
    }
    expect(system).toContain('"verdict"');
  });

  it('marks absent knowledge and taste explicitly', () => {
    const { prompt } = buildEditorPrompt(editorInput({ knowledge: '', taste: '' }));
    expect(prompt).toContain('(empty)');
  });
});

describe('parseEditorResult', () => {
  it('parses a well-formed result and computes the score in code', () => {
    const r = parseEditorResult(
      JSON.stringify({
        insight: 1,
        novelty: 0.5,
        backed: 1,
        score: 0.1,
        verdict: 'send',
        notes: 'ok',
      }),
      logger
    );
    expect(r).not.toBeNull();
    expect(r!.score).toBeCloseTo(0.5 * 1 + 0.3 * 0.5 + 0.2 * 1, 5);
    expect(r!.verdict).toBe('send');
    expect(r!.notes).toBe('ok');
  });

  it('strips code fences and surrounding prose', () => {
    const r = parseEditorResult(
      'Here:\n{"insight":0.8,"novelty":0.8,"backed":0.8,"verdict":"hold","notes":""} done',
      logger
    );
    expect(r?.verdict).toBe('hold');
    const f = parseEditorResult(
      '```json\n{"insight":0.8,"novelty":0.8,"backed":0.8,"verdict":"send"}\n```',
      logger
    );
    expect(f?.verdict).toBe('send');
  });

  it('clamps scores to 0–1', () => {
    const r = parseEditorResult('{"insight":7,"novelty":-2,"backed":1.5,"verdict":"send"}', logger);
    expect(r!.insight).toBe(1);
    expect(r!.novelty).toBe(0);
    expect(r!.backed).toBe(1);
    expect(r!.score).toBeCloseTo(0.7, 5);
  });

  it('forces drop when backed < 0.5', () => {
    const r = parseEditorResult('{"insight":1,"novelty":1,"backed":0.4,"verdict":"send"}', logger);
    expect(r!.verdict).toBe('drop');
  });

  it('defaults an unknown verdict to hold', () => {
    const r = parseEditorResult('{"insight":1,"novelty":1,"backed":1,"verdict":"maybe"}', logger);
    expect(r!.verdict).toBe('hold');
  });

  it('accepts snake_case keys', () => {
    const r = parseEditorResult(
      '{"insight_score":0.9,"novelty_score":0.6,"backed_score":0.7,"verdict":"send","revised":{"why_care":"tighter"}}',
      logger
    );
    expect(r!.insight).toBe(0.9);
    expect(r!.novelty).toBe(0.6);
    expect(r!.backed).toBe(0.7);
    expect(r!.revised).toEqual({ whyCare: 'tighter' });
  });

  it('keeps only non-empty known revision fields', () => {
    const r = parseEditorResult(
      '{"insight":1,"novelty":1,"backed":1,"verdict":"send","revised":{"hook":"Sharper.","evidence":"","body":"x","topic":"y"}}',
      logger
    );
    expect(r!.revised).toEqual({ hook: 'Sharper.' });
    const none = parseEditorResult(
      '{"insight":1,"novelty":1,"backed":1,"verdict":"send","revised":{"x":1}}',
      logger
    );
    expect(none!.revised).toBeUndefined();
  });

  it('returns null for missing scores or garbage', () => {
    expect(parseEditorResult('{"insight":1,"verdict":"send"}', logger)).toBeNull();
    expect(parseEditorResult('not json at all', logger)).toBeNull();
  });
});

describe('applyHypePenalty', () => {
  it('returns the result unchanged when the text is calm', () => {
    const r = editor();
    expect(applyHypePenalty(r, 'Calm, measured text.')).toEqual(r);
  });

  it('subtracts 0.1 per hit and notes the words', () => {
    const r = applyHypePenalty(
      editor({ score: 0.8, notes: 'fine' }),
      'A revolutionary, insane result'
    );
    expect(r.score).toBeCloseTo(0.6, 5);
    expect(r.notes).toContain('fine');
    expect(r.notes).toContain('revolutionary');
    expect(r.notes).toContain('insane');
  });

  it('floors the score at 0', () => {
    const r = applyHypePenalty(
      editor({ score: 0.1 }),
      'revolutionary insane groundbreaking mind-blowing game-changer'
    );
    expect(r.score).toBe(0);
  });
});

function fakeClient(responses: string[]): LLMClient & { calls: LLMGenerateOptions[] } {
  const calls: LLMGenerateOptions[] = [];
  let i = 0;
  return {
    backend: 'ollama',
    calls,
    async generate(_prompt: string, opts?: LLMGenerateOptions) {
      calls.push(opts ?? {});
      const text = responses[Math.min(i, responses.length - 1)];
      i++;
      return {
        text,
        usage: { model: 'm', promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      };
    },
    async chat() {
      return { text: '' };
    },
  };
}

describe('runEditor', () => {
  const good = '{"insight":0.9,"novelty":0.9,"backed":0.9,"verdict":"send","notes":"good"}';

  it('returns the parsed result with usage on the first try at temperature 0.2', async () => {
    const client = fakeClient([good]);
    const r = await runEditor(client, 'model-x', editorInput(), logger);
    expect(r?.verdict).toBe('send');
    expect(r?.usage?.totalTokens).toBe(2);
    expect(client.calls).toHaveLength(1);
    expect(client.calls[0].temperature).toBe(0.2);
    expect(client.calls[0].model).toBe('model-x');
    expect(client.calls[0].system).toBeDefined();
  });

  it('retries once at temperature 0 on a parse failure', async () => {
    const client = fakeClient(['garbage', good]);
    const r = await runEditor(client, 'm', editorInput(), logger);
    expect(r?.notes).toBe('good');
    expect(client.calls.map((c) => c.temperature)).toEqual([0.2, 0]);
  });

  it('returns null after two parse failures', async () => {
    const client = fakeClient(['garbage', 'still garbage']);
    expect(await runEditor(client, 'm', editorInput(), logger)).toBeNull();
    expect(client.calls).toHaveLength(2);
  });

  it('returns null when the client throws', async () => {
    const client = fakeClient([good]);
    client.generate = async () => {
      throw new Error('boom');
    };
    expect(await runEditor(client, 'm', editorInput(), logger)).toBeNull();
  });
});

// ── cadence + decision ───────────────────────────────────────────────────

describe('isCadenceOpen', () => {
  it('is open when nothing was ever sent', () => {
    expect(isCadenceOpen({ intervalHours: 24, lastSentAt: null }, NOW_MS)).toBe(true);
  });

  it('is closed inside the interval and open once it elapses', () => {
    const lastSentAt = new Date(NOW_MS - 23 * 3_600_000).toISOString();
    expect(isCadenceOpen({ intervalHours: 24, lastSentAt }, NOW_MS)).toBe(false);
    expect(isCadenceOpen({ intervalHours: 24, lastSentAt }, NOW_MS + 3_600_000)).toBe(true);
  });

  it('treats an unparseable timestamp as open', () => {
    expect(isCadenceOpen({ intervalHours: 24, lastSentAt: 'nope' }, NOW_MS)).toBe(true);
  });
});

describe('decideDispatch', () => {
  const base = {
    kind: 'insight' as const,
    editor: editor(),
    cadenceOpen: true,
    settings: settings(),
  };

  it('holds everything when dispatch is disabled', () => {
    expect(decideDispatch({ ...base, settings: settings({ enabled: false }) })).toBe('held');
  });

  it('holds when the editor failed', () => {
    expect(decideDispatch({ ...base, editor: null })).toBe('held');
  });

  it('drops on a drop verdict', () => {
    expect(decideDispatch({ ...base, editor: editor({ verdict: 'drop' }) })).toBe('dropped');
  });

  it('sends a strong insight when the cadence is open', () => {
    expect(decideDispatch(base)).toBe('sent');
  });

  it('holds a strong insight when the cadence is closed', () => {
    expect(decideDispatch({ ...base, cadenceOpen: false })).toBe('held');
  });

  it('holds an insight below minEditorScore', () => {
    expect(decideDispatch({ ...base, editor: editor({ score: 0.69 }) })).toBe('held');
  });

  it('holds an insight whose verdict is hold even with a high score', () => {
    expect(decideDispatch({ ...base, editor: editor({ verdict: 'hold' }) })).toBe('held');
  });

  it('sends a proposal at score ≥ 0.5 regardless of verdict hold', () => {
    expect(
      decideDispatch({ ...base, kind: 'proposal', editor: editor({ score: 0.5, verdict: 'hold' }) })
    ).toBe('sent');
  });

  it('holds a proposal below 0.5 or with the cadence closed', () => {
    expect(decideDispatch({ ...base, kind: 'proposal', editor: editor({ score: 0.49 }) })).toBe(
      'held'
    );
    expect(decideDispatch({ ...base, kind: 'proposal', cadenceOpen: false })).toBe('held');
  });

  it('treats a digest like a proposal (≥ 0.5 + cadence)', () => {
    expect(
      decideDispatch({ ...base, kind: 'digest', editor: editor({ score: 0.55, verdict: 'hold' }) })
    ).toBe('sent');
    expect(decideDispatch({ ...base, kind: 'digest', cadenceOpen: false })).toBe('held');
  });
});

// ── builders ─────────────────────────────────────────────────────────────

describe('applyRevision', () => {
  it('returns the candidate untouched without a revision', () => {
    const c = cand();
    expect(applyRevision(c, undefined)).toEqual(c);
  });

  it('overrides only non-empty revised fields', () => {
    const c = cand();
    const r = applyRevision(c, { hook: 'Tighter hook.', evidence: '  ', question: 'Want it?' });
    expect(r.hook).toBe('Tighter hook.');
    expect(r.evidence).toBe(c.evidence);
    expect(r.question).toBe('Want it?');
    expect(r.kind).toBe('insight');
    expect(c.hook).not.toBe('Tighter hook.');
  });
});

describe('buildDispatch', () => {
  it('builds a sent dispatch with sentAt and editor data', () => {
    const d = buildDispatch({
      botId: 'scout',
      candidate: cand({ question: 'Q?' }),
      body: 'BODY',
      editor: editor({ notes: 'n' }),
      status: 'sent',
      now: NOW,
    });
    expect(d.id).toMatch(/^[0-9a-f]{8}$/);
    expect(d.botId).toBe('scout');
    expect(d.createdAt).toBe(NOW);
    expect(d.sentAt).toBe(NOW);
    expect(d.body).toBe('BODY');
    expect(d.editorScore).toBe(0.87);
    expect(d.editorNotes).toBe('n');
    expect(d.question).toBe('Q?');
    expect(d.status).toBe('sent');
  });

  it('leaves sentAt unset when held and scores 0 without an editor', () => {
    const d = buildDispatch({
      botId: 'b',
      candidate: cand({ kind: 'proposal', crossing: ['topic'], frontierId: 'f1' }),
      body: 'x',
      editor: null,
      status: 'held',
      now: NOW,
    });
    expect(d.sentAt).toBeUndefined();
    expect(d.editorScore).toBe(0);
    expect(d.crossing).toEqual(['topic']);
    expect(d.frontierId).toBe('f1');
  });
});

describe('buildDigestCandidate', () => {
  it('returns null without held dispatches', () => {
    expect(buildDigestCandidate([])).toBeNull();
    expect(buildDigestCandidate([heldDispatch({ status: 'sent' })])).toBeNull();
  });

  it('takes the top held dispatches by editor score', () => {
    const d = buildDigestCandidate(
      [
        heldDispatch({ id: 'a', hook: 'low', editorScore: 0.2 }),
        heldDispatch({ id: 'b', hook: 'top', editorScore: 0.9 }),
        heldDispatch({ id: 'c', hook: 'mid', editorScore: 0.5 }),
        heldDispatch({ id: 'd', hook: 'sent one', editorScore: 1, status: 'sent' }),
      ],
      2
    );
    expect(d!.kind).toBe('digest');
    expect(d!.topic).toBe('digest');
    expect(d!.evidence).toBe('1. top\n2. mid');
    expect(d!.hook).toContain('3');
  });
});

describe('proposalCandidate', () => {
  const item: FrontierItem = {
    id: 'f9',
    question: 'Do tide tables predict our traffic dips?',
    whyInteresting: 'Two dips lined up with spring tides.',
    bridge: 'Traffic is the KPI I report on.',
    distance: 2,
    surpriseScore: 0.8,
    fromTopic: 'traffic',
    createdAt: NOW,
    status: 'open',
  };

  it('maps a frontier proposal into a proposal candidate', () => {
    const p: FrontierProposal = { item, crossing: ['topic'] };
    const c = proposalCandidate(p);
    expect(c.kind).toBe('proposal');
    expect(c.hook).toBe(item.question);
    expect(c.whyCare).toBe(item.whyInteresting);
    expect(c.evidence).toContain(item.bridge!);
    expect(c.crossing).toEqual(['topic']);
    expect(c.frontierId).toBe('f9');
    expect(c.topic).toBe('traffic');
  });

  it('says plainly when there is no bridge to the purpose', () => {
    const { bridge: _b, fromTopic: _t, ...rest } = item;
    const c = proposalCandidate({ item: rest as FrontierItem, crossing: ['purpose'] });
    expect(c.evidence.length).toBeGreaterThan(0);
    expect(c.topic).toBe('frontier');
  });
});
