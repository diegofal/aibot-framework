/**
 * Knowledge map — the "compounding" gene. Pure functions over `KnowledgeMap`;
 * all I/O lives in store.ts. Every mutation returns a new map.
 */
import { randomUUID } from 'node:crypto';
import { textSimilarity } from '../../hygiene/text-utils';
import type {
  Confidence,
  FrontierItem,
  FrontierStatus,
  KnowledgeMap,
  KnowledgeTopic,
} from './types';

export const KNOWLEDGE_CAPS = {
  topics: 40,
  findingsPerTopic: 20,
  surprisesPerTopic: 10,
  openQuestionsPerTopic: 8,
  outputsPerTopic: 20,
  frontier: 30,
  interests: 12,
};

/** Two texts at or above this similarity are the same entry. */
const DUP_THRESHOLD = 0.8;
/** Topic names at or above this similarity are the same topic. */
const TOPIC_MATCH_THRESHOLD = 0.75;

/** What the post-cycle extractor returns (validated in extractor.ts). */
export interface CycleExtraction {
  topic: string;
  findings: Array<{ claim: string; evidence?: string; confidence: Confidence }>;
  surprises: string[];
  openQuestions: string[];
  answeredQuestions?: string[];
  frontier: Array<{
    question: string;
    whyInteresting: string;
    bridge?: string;
    distance: number;
    surpriseScore: number;
  }>;
  servedDirectiveIds: string[];
  noSurprise: boolean;
  outputs?: string[];
  interests?: string[];
}

export function emptyKnowledgeMap(): KnowledgeMap {
  return { version: 1, topics: [], frontier: [], interests: [], updatedAt: null };
}

export function topicId(name: string): string {
  const slug = name
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return slug || 'general';
}

const shortId = () => randomUUID().slice(0, 8);

const isDup = (a: string, b: string) => textSimilarity(a, b) >= DUP_THRESHOLD;

function depthFor(findingCount: number): number {
  if (findingCount >= 10) return 3;
  if (findingCount >= 5) return 2;
  if (findingCount >= 2) return 1;
  return 0;
}

function clamp(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return lo;
  return Math.max(lo, Math.min(hi, n));
}

function cloneMap(map: KnowledgeMap): KnowledgeMap {
  return structuredClone(map);
}

function findTopic(map: KnowledgeMap, name: string): KnowledgeTopic | undefined {
  const id = topicId(name);
  return (
    map.topics.find((t) => t.id === id) ??
    map.topics.find((t) => textSimilarity(t.name, name) >= TOPIC_MATCH_THRESHOLD)
  );
}

/** Fold one cycle's extraction into the map. */
export function mergeExtraction(
  map: KnowledgeMap,
  ex: CycleExtraction,
  now: string = new Date().toISOString()
): KnowledgeMap {
  const next = cloneMap(map);
  const name = ex.topic.trim() || 'general';
  let topic = findTopic(next, name);
  if (!topic) {
    topic = {
      id: topicId(name),
      name,
      depth: 0,
      firstSeen: now,
      lastTouched: now,
      cycles: 0,
      findings: [],
      surprises: [],
      openQuestions: [],
      outputs: [],
    };
    next.topics.push(topic);
  }
  topic.cycles += 1;
  topic.lastTouched = now;

  for (const f of ex.findings) {
    const claim = f.claim.trim();
    if (!claim || topic.findings.some((x) => isDup(x.claim, claim))) continue;
    topic.findings.push({
      id: shortId(),
      claim,
      evidence: f.evidence?.trim() || undefined,
      confidence: f.confidence,
      at: now,
    });
  }
  for (const s of ex.surprises) {
    const text = s.trim();
    if (!text || topic.surprises.some((x) => isDup(x.text, text))) continue;
    topic.surprises.push({ id: shortId(), text, at: now });
  }
  for (const answered of ex.answeredQuestions ?? []) {
    topic.openQuestions = topic.openQuestions.filter((q) => !isDup(q, answered));
  }
  for (const q of ex.openQuestions) {
    const text = q.trim();
    if (!text || topic.openQuestions.some((x) => isDup(x, text))) continue;
    topic.openQuestions.push(text);
  }
  for (const o of ex.outputs ?? []) {
    if (o && !topic.outputs.includes(o)) topic.outputs.push(o);
  }

  for (const f of ex.frontier) {
    const question = f.question.trim();
    if (!question || next.frontier.some((x) => isDup(x.question, question))) continue;
    next.frontier.push({
      id: shortId(),
      question,
      whyInteresting: f.whyInteresting.trim(),
      bridge: f.bridge?.trim() || undefined,
      distance: Math.round(clamp(f.distance, 0, 5)),
      surpriseScore: clamp(f.surpriseScore, 0, 1),
      fromTopic: topic.id,
      createdAt: now,
      status: 'open',
    });
  }

  for (const interest of ex.interests ?? []) {
    const text = interest.trim();
    if (text && !next.interests.some((x) => isDup(x, text))) next.interests.push(text);
  }

  next.updatedAt = now;
  const pruned = pruneKnowledgeMap(next);
  for (const t of pruned.topics) t.depth = Math.max(t.depth, depthFor(t.findings.length));
  return pruned;
}

/** Enforce KNOWLEDGE_CAPS, keeping the newest entries and the live frontier. */
export function pruneKnowledgeMap(map: KnowledgeMap): KnowledgeMap {
  const next = cloneMap(map);
  const c = KNOWLEDGE_CAPS;
  for (const t of next.topics) {
    t.findings = t.findings.slice(-c.findingsPerTopic);
    t.surprises = t.surprises.slice(-c.surprisesPerTopic);
    t.openQuestions = t.openQuestions.slice(-c.openQuestionsPerTopic);
    t.outputs = t.outputs.slice(-c.outputsPerTopic);
  }
  if (next.topics.length > c.topics) {
    // Keep the deepest and most recently touched.
    next.topics = [...next.topics]
      .sort((a, b) => b.depth - a.depth || b.lastTouched.localeCompare(a.lastTouched))
      .slice(0, c.topics);
  }
  if (next.frontier.length > c.frontier) {
    const rank = (f: FrontierItem) =>
      f.status === 'dropped' ? 0 : f.status === 'explored' ? 1 : 2;
    const keep = [...next.frontier]
      .map((f, i) => ({ f, i }))
      .sort((a, b) => rank(b.f) - rank(a.f) || b.i - a.i)
      .slice(0, c.frontier)
      .sort((a, b) => a.i - b.i)
      .map((x) => x.f);
    next.frontier = keep;
  }
  next.interests = next.interests.slice(-c.interests);
  return next;
}

export function markFrontier(
  map: KnowledgeMap,
  id: string,
  status: FrontierStatus,
  now: string = new Date().toISOString()
): KnowledgeMap {
  const next = cloneMap(map);
  const item = next.frontier.find((f) => f.id === id);
  if (!item) return next;
  item.status = status;
  if (status === 'explored') item.exploredAt = now;
  return next;
}

/** Operator verdict on a frontier item. 'down' drops it. Null when unknown. */
export function setFrontierSignal(
  map: KnowledgeMap,
  id: string,
  signal: 'up' | 'down'
): KnowledgeMap | null {
  const next = cloneMap(map);
  const item = next.frontier.find((f) => f.id === id);
  if (!item) return null;
  item.operatorSignal = signal;
  if (signal === 'down') item.status = 'dropped';
  else if (item.status === 'dropped') item.status = 'open';
  return next;
}

/** "What you have learned" block for strategist/navigator prompts. */
export function renderKnowledgeForPrompt(map: KnowledgeMap, maxChars = 3500): string {
  const header = '## What You Have Learned (knowledge map)\n';
  if (map.topics.length === 0) {
    return `${header}\n(nothing yet — every finding you make from now on compounds here)`;
  }
  const lines: string[] = [header];
  let used = header.length;
  const topics = [...map.topics].sort((a, b) => b.lastTouched.localeCompare(a.lastTouched));
  for (const t of topics) {
    const block: string[] = [
      `### ${t.name} — depth ${t.depth}/3, ${t.cycles} cycle${t.cycles === 1 ? '' : 's'}, last ${t.lastTouched.slice(0, 10)}`,
    ];
    for (const f of t.findings.slice(-3)) block.push(`- finding (${f.confidence}): ${f.claim}`);
    for (const s of t.surprises.slice(-2)) block.push(`- surprise: ${s.text}`);
    for (const q of t.openQuestions.slice(-3)) block.push(`- open: ${q}`);
    const text = `${block.join('\n')}\n`;
    if (used + text.length + 1 > maxChars) {
      const more = `(+${topics.length - (lines.length - 1)} more topics)`;
      if (used + more.length <= maxChars) lines.push(more);
      break;
    }
    lines.push(text);
    used += text.length + 1;
  }
  if (map.interests.length > 0) {
    const text = `Interests you have grown into: ${map.interests.join('; ')}`;
    if (used + text.length + 1 <= maxChars) lines.push(text);
  }
  return lines.join('\n').slice(0, maxChars);
}
