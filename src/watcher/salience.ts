/**
 * Tier 0 salience: a deterministic score for every sensed event (no model).
 * The table lives in docs/plans/watcher-implementation-plan.md (phase 1).
 * Also the privacy rule: text from anyone but the operator is reduced to topic
 * words before the watcher stores or narrates it. Pure.
 */
import type { HumanInboundEvent } from '../bot/agent-loop-utils';
import type { Graph } from './graph';
import { type SensedEvent, isHumanInbound } from './types';

export interface SalienceContext {
  graph: Pick<Graph, 'findSimilarText' | 'findByKey'>;
  nowMs: number;
}

export interface SalienceScore {
  salience: number;
  reasons: string[];
  touched: string[];
}

/** An event's text this similar to a neuron touches it. */
export const TOUCH_THRESHOLD = 0.5;
export const NOVELTY_BONUS = 0.2;
export const SALIENCE_HALF_LIFE_MS = 3_600_000;

const MESSAGE_TOOLS = new Set(['send_message', 'send_proactive_message']);

export function scoreEvent(event: SensedEvent, ctx: SalienceContext): SalienceScore {
  let salience = 0;
  const reasons: string[] = [];
  const add = (amount: number, reason: string) => {
    salience += amount;
    reasons.push(reason);
  };

  let goalId: unknown;
  if (isHumanInbound(event)) {
    add(0.5, 'human message');
  } else {
    const data = (event.data ?? {}) as Record<string, unknown>;
    goalId = data.goalId;
    switch (event.type) {
      case 'tool:end':
        if (MESSAGE_TOOLS.has(String(data.toolName))) add(0.5, 'message sent');
        break;
      case 'tool:error':
      case 'llm:error':
        add(0.3, 'error');
        break;
      case 'task:changed':
        add(0.2, 'task changed');
        break;
      case 'worker:waiting':
        add(0.4, 'worker waiting');
        break;
      case 'worker:ended':
        if (data.status === 'blocked') add(0.4, 'worker blocked');
        break;
      case 'curiosity:surprise':
        if (hasSurprise(data)) add(0.3, 'surprise');
        break;
      case 'karma:change':
        if (typeof data.delta === 'number' && data.delta !== 0)
          add(Math.abs(data.delta) / 10, 'karma change');
        break;
      case 'memory:flush':
        add(0.1, 'memory saved');
        break;
    }
  }

  const touched: string[] = [];
  if (typeof goalId === 'string' && goalId) {
    const goal = ctx.graph.findByKey(`goal:${event.botId}:${goalId}`);
    if (goal) touched.push(goal.id);
  }
  const text = eventText(event);
  if (text) {
    const matches = ctx.graph.findSimilarText(text, TOUCH_THRESHOLD);
    for (const n of matches.slice(0, 5)) if (!touched.includes(n.id)) touched.push(n.id);
    if (matches.length === 0) add(NOVELTY_BONUS, 'novel');
  }
  return { salience: Math.round(salience * 1000) / 1000, reasons, touched };
}

function hasSurprise(data: Record<string, unknown>): boolean {
  if (Array.isArray(data.surprises)) return data.surprises.length > 0;
  return Boolean(data.surprise);
}

/** The readable part of an event, matched against the graph for novelty and touch. */
export function eventText(event: SensedEvent): string | undefined {
  if (isHumanInbound(event)) return event.text || undefined;
  const data = (event.data ?? {}) as Record<string, unknown>;
  for (const key of ['summary', 'error', 'reason', 'question', 'note']) {
    const v = data[key];
    if (typeof v === 'string' && v.trim()) return v;
  }
  return undefined;
}

/** Salience fades with a one-hour half-life. */
export function decay(salience: number, ageMs: number, halfLifeMs = SALIENCE_HALF_LIFE_MS): number {
  return salience * 0.5 ** (Math.max(0, ageMs) / halfLifeMs);
}

const STOPWORDS = new Set([
  // en
  'this',
  'that',
  'with',
  'from',
  'have',
  'what',
  'when',
  'where',
  'which',
  'there',
  'their',
  'about',
  'would',
  'could',
  'should',
  'your',
  'yours',
  'they',
  'them',
  'then',
  'than',
  'will',
  'just',
  'like',
  'been',
  'were',
  'into',
  'also',
  'some',
  'very',
  'here',
  'want',
  'need',
  // es
  'para',
  'pero',
  'como',
  'esta',
  'este',
  'esto',
  'estoy',
  'tengo',
  'tiene',
  'porque',
  'cuando',
  'donde',
  'desde',
  'hasta',
  'sobre',
  'todo',
  'todos',
  'muy',
  'más',
  'mas',
  'quiero',
  'puedo',
  'hacer',
  'algo',
  'nada',
  'bien',
  'gracias',
  'favor',
]);

/** At most `max` distinct topic words: no stopwords, numbers, emails, handles, urls or short words. */
export function topicWords(text: string, max = 6): string {
  const cleaned = text
    .replace(/https?:\/\/\S+/gi, ' ')
    .replace(/\S+@\S+/g, ' ')
    .replace(/(^|\s)@\w+/g, ' ');
  const out: string[] = [];
  for (const raw of cleaned.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (raw.length < 4 || /\d/.test(raw) || STOPWORDS.has(raw) || out.includes(raw)) continue;
    out.push(raw);
    if (out.length >= max) break;
  }
  return out.join(' ');
}

/** The event as the watcher may keep it: the operator's words verbatim, anyone else's as topic words. */
export function privateView(event: HumanInboundEvent, isOperator: boolean): HumanInboundEvent {
  if (isOperator || !event.text) return event;
  const words = topicWords(event.text);
  const { text: _private, ...rest } = event;
  return words ? { ...rest, text: words } : rest;
}
