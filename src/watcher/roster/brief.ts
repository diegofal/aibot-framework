/**
 * The operator's brief: what he wants from the fleet, in his words, ≤ 5
 * wants plus notes, in `<watcherDir>/self/brief.json`. The roster designer
 * reads it; every bot it proposes must serve one of these wants.
 */
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeJsonFileAtomic } from '../../config';
import {
  BRIEF_MAX_WANTS,
  BRIEF_NOTES_MAX,
  BRIEF_SHORT_MAX,
  BRIEF_SUCCESS_MAX,
  BRIEF_WHAT_MAX,
  type BriefWant,
  type OperatorBrief,
} from './types';

const WANT_ID = /^w-[0-9a-f]{6}$/;

export function briefPath(watcherDir: string): string {
  return join(watcherDir, 'self', 'brief.json');
}

export function newWantId(): string {
  return `w-${randomBytes(3).toString('hex')}`;
}

/** The saved brief; a missing or unreadable file is an empty one. Never throws. */
export function readBrief(watcherDir: string): OperatorBrief {
  try {
    const raw = JSON.parse(readFileSync(briefPath(watcherDir), 'utf-8')) as OperatorBrief;
    if (!raw || !Array.isArray(raw.wants)) return { wants: [], notes: '' };
    return {
      wants: raw.wants.filter((w) => w && typeof w.id === 'string' && typeof w.what === 'string'),
      notes: typeof raw.notes === 'string' ? raw.notes : '',
      ...(typeof raw.updatedAt === 'string' ? { updatedAt: raw.updatedAt } : {}),
    };
  } catch {
    return { wants: [], notes: '' };
  }
}

const FIELDS: Array<[keyof Omit<BriefWant, 'id'>, number]> = [
  ['what', BRIEF_WHAT_MAX],
  ['cadence', BRIEF_SHORT_MAX],
  ['delivery', BRIEF_SHORT_MAX],
  ['success', BRIEF_SUCCESS_MAX],
];

const clean = (v: unknown) => (typeof v === 'string' ? v.trim().replace(/\s+/g, ' ') : '');

/**
 * Validate a `PUT /api/watcher/brief` body. Wants with an empty `what` are
 * dropped; a well-formed id not used twice is kept, anything else gets a
 * fresh one (`newId`). Over-long fields are rejected, never cut.
 */
export function parseBriefInput(
  body: unknown,
  newId: () => string = newWantId
): { ok: true; brief: OperatorBrief } | { ok: false; error: string } {
  if (!body || typeof body !== 'object') return { ok: false, error: 'Expected a JSON object' };
  const b = body as { wants?: unknown; notes?: unknown };
  if (b.wants !== undefined && !Array.isArray(b.wants))
    return { ok: false, error: 'wants must be a list' };
  const notes = typeof b.notes === 'string' ? b.notes.trim() : '';
  if (notes.length > BRIEF_NOTES_MAX)
    return { ok: false, error: `notes is longer than ${BRIEF_NOTES_MAX} characters` };
  const raw = ((b.wants as unknown[] | undefined) ?? []).filter(
    (w): w is Record<string, unknown> =>
      !!w && typeof w === 'object' && clean((w as Record<string, unknown>).what) !== ''
  );
  if (raw.length > BRIEF_MAX_WANTS) return { ok: false, error: `At most ${BRIEF_MAX_WANTS} wants` };
  const used = new Set<string>();
  const wants: BriefWant[] = [];
  for (const [i, w] of raw.entries()) {
    const want: BriefWant = { id: '', what: '', cadence: '', delivery: '', success: '' };
    for (const [field, max] of FIELDS) {
      const value = clean(w[field]);
      if (value.length > max)
        return { ok: false, error: `Want ${i + 1}: ${field} is longer than ${max} characters` };
      want[field] = value;
    }
    const kept = typeof w.id === 'string' && WANT_ID.test(w.id) && !used.has(w.id);
    want.id = kept ? (w.id as string) : newId();
    used.add(want.id);
    wants.push(want);
  }
  return { ok: true, brief: { wants, notes } };
}

/** Save the brief with `updatedAt` = now (atomic). Returns what was written. */
export function writeBrief(watcherDir: string, brief: OperatorBrief, nowMs: number): OperatorBrief {
  const saved: OperatorBrief = {
    wants: brief.wants,
    notes: brief.notes,
    updatedAt: new Date(nowMs).toISOString(),
  };
  mkdirSync(join(watcherDir, 'self'), { recursive: true });
  writeJsonFileAtomic(briefPath(watcherDir), saved);
  return saved;
}

/** The brief as the designer's prompt shows it: one block per want, id first. */
export function renderBriefForPrompt(brief: OperatorBrief): string {
  if (brief.wants.length === 0 && !brief.notes) return '(The operator has not written a brief.)';
  const blocks = brief.wants.map((w) =>
    [
      `- [${w.id}] ${w.what}`,
      w.cadence ? `  How often: ${w.cadence}` : '',
      w.delivery ? `  Delivered by: ${w.delivery}` : '',
      w.success ? `  Good looks like: ${w.success}` : '',
    ]
      .filter(Boolean)
      .join('\n')
  );
  if (brief.notes) blocks.push(`Notes from the operator:\n${brief.notes}`);
  return blocks.join('\n');
}
