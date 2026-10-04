/**
 * Taste model — learned from the operator's signals on dispatches. Drives
 * frontier ranking (liked topics), the editor (what lands / what doesn't),
 * and the dispatch cadence (earned down by signals, decayed up by silence).
 */
import { topicId } from './knowledge-map';
import type { Dispatch, DispatchSettings, DispatchSignal, TasteProfile } from './types';

export const HOOKS_CAP = 15;
/** A sent dispatch with no signal after this long counts as ignored. */
export const IGNORED_AFTER_HOURS = 48;

const LIKE_FACTOR = 0.75;
const DISLIKE_FACTOR = 1.25;
const IGNORED_FACTOR = 1.5;

function clampInterval(hours: number, s: DispatchSettings): number {
  return Math.max(s.minIntervalHours, Math.min(s.maxIntervalHours, hours));
}

function bump(
  bucket: Record<string, { up: number; down: number; more: number }>,
  key: string,
  signal: DispatchSignal
) {
  const counts = bucket[key] ?? { up: 0, down: 0, more: 0 };
  bucket[key] = { ...counts, [signal]: counts[signal] + 1 };
}

export function applySignal(
  taste: TasteProfile,
  dispatch: Dispatch,
  signal: DispatchSignal,
  settings: DispatchSettings,
  now: string = new Date().toISOString()
): TasteProfile {
  const next = structuredClone(taste);
  bump(next.topics, topicId(dispatch.topic), signal);
  bump(next.kinds, dispatch.kind, signal);
  if (signal === 'down') {
    next.dislikedHooks = [...next.dislikedHooks, dispatch.hook].slice(-HOOKS_CAP);
  } else {
    next.likedHooks = [...next.likedHooks, dispatch.hook].slice(-HOOKS_CAP);
  }
  const factor = signal === 'down' ? DISLIKE_FACTOR : LIKE_FACTOR;
  next.cadence = {
    ...next.cadence,
    intervalHours: clampInterval(next.cadence.intervalHours * factor, settings),
  };
  next.updatedAt = now;
  return next;
}

/**
 * Sent dispatches nobody reacted to within IGNORED_AFTER_HOURS lengthen the
 * interval once each. Returns the ids to mark `ignoredCounted`.
 */
export function applyIgnored(
  taste: TasteProfile,
  dispatches: Dispatch[],
  settings: DispatchSettings,
  now: string = new Date().toISOString()
): { taste: TasteProfile; counted: string[] } {
  const nowMs = Date.parse(now);
  const counted = dispatches
    .filter(
      (d) =>
        d.status === 'sent' &&
        d.deliveredVia !== 'inbox' &&
        !d.signal &&
        !d.ignoredCounted &&
        d.sentAt &&
        nowMs - Date.parse(d.sentAt) >= IGNORED_AFTER_HOURS * 3_600_000
    )
    .map((d) => d.id);
  if (counted.length === 0) return { taste, counted };
  let hours = taste.cadence.intervalHours;
  for (let i = 0; i < counted.length; i++) hours *= IGNORED_FACTOR;
  return {
    taste: {
      ...taste,
      cadence: { ...taste.cadence, intervalHours: clampInterval(hours, settings) },
      updatedAt: now,
    },
    counted,
  };
}

/** topicId → up + more − down. */
export function likedTopicScores(taste: TasteProfile): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [topic, c] of Object.entries(taste.topics)) out[topic] = c.up + c.more - c.down;
  return out;
}

export function renderTasteForPrompt(taste: TasteProfile): string {
  const scores = Object.entries(likedTopicScores(taste));
  if (scores.length === 0 && taste.likedHooks.length === 0 && taste.dislikedHooks.length === 0) {
    return '';
  }
  const liked = scores
    .filter(([, s]) => s > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([t, s]) => `${t} (+${s})`);
  const disliked = scores
    .filter(([, s]) => s < 0)
    .sort((a, b) => a[1] - b[1])
    .map(([t, s]) => `${t} (${s})`);
  const lines = ['## What lands with the operator (learned taste)'];
  if (liked.length > 0) lines.push(`Topics that land: ${liked.join(', ')}`);
  if (disliked.length > 0) lines.push(`Topics that fall flat: ${disliked.join(', ')}`);
  if (taste.likedHooks.length > 0) {
    lines.push(`Hooks the operator liked:\n${taste.likedHooks.slice(-5).map((h) => `- ${h}`).join('\n')}`);
  }
  if (taste.dislikedHooks.length > 0) {
    lines.push(
      `Hooks that fell flat:\n${taste.dislikedHooks.slice(-5).map((h) => `- ${h}`).join('\n')}`
    );
  }
  return lines.join('\n');
}
