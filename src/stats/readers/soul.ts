/**
 * Per-bot soul directory readers: GOALS.md, TRAITS.json, the core soul files'
 * health and the feedback log. All read-only, all tolerant of a missing dir.
 */
import { join } from 'node:path';
import { getUnconsolidatedLogs } from '../../bot/soul-memory-consolidator';
import { createDefaultTraits } from '../../bot/trait-registers';
import { type GoalEntry, parseGoals } from '../../tools/goals';
import type { GoalDetail, GoalsStats, SoulStats, TraitSnapshot, TraitStats } from '../types';
import { readJsonSafe, readJsonlSafe, readTextSafe, statSizeSafe, toIso, toMs } from '../util';

export const CORE_SOUL_FILES = [
  'SOUL.md',
  'IDENTITY.md',
  'GOALS.md',
  'MEMORY.md',
  'MOTIVATIONS.md',
];

/** Notes longer than this are flagged as oversized (they bloat every planner prompt). */
export const OVERSIZED_NOTES_CHARS = 300;

// ── Goals ──

function normaliseGoalText(text: string): string {
  return text
    .toLowerCase()
    .replace(/\*\*/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function toDetail(g: GoalEntry, section: 'active' | 'completed'): GoalDetail {
  return {
    text: g.text,
    status: g.status,
    priority: g.priority,
    notes: g.notes ?? null,
    notesLength: g.notes?.length ?? 0,
    completed: g.completed ?? null,
    outcome: g.outcome ?? null,
    source: g.source ?? null,
    section,
  };
}

export function readGoals(soulDir: string): { stats: GoalsStats; detail: GoalDetail[] } {
  const { active, completed } = parseGoals(readTextSafe(join(soulDir, 'GOALS.md')));

  const byStatus: Record<string, number> = {};
  const seen = new Set<string>();
  let duplicates = 0;
  let archivedInActive = 0;
  let oversizedNotes = 0;
  for (const g of active) {
    byStatus[g.status] = (byStatus[g.status] ?? 0) + 1;
    if (/archiv/i.test(g.status)) archivedInActive++;
    if ((g.notes?.length ?? 0) > OVERSIZED_NOTES_CHARS) oversizedNotes++;
    const key = normaliseGoalText(g.text);
    if (seen.has(key)) duplicates++;
    else seen.add(key);
  }

  let lastCompletedAt: string | null = null;
  for (const g of completed) {
    if (!g.completed) continue;
    if (lastCompletedAt === null || g.completed > lastCompletedAt) lastCompletedAt = g.completed;
  }

  return {
    stats: {
      active: active.length,
      completed: completed.length,
      byStatus,
      archivedInActive,
      duplicates,
      oversizedNotes,
      lastCompletedAt,
    },
    detail: [
      ...active.map((g) => toDetail(g, 'active')),
      ...completed.map((g) => toDetail(g, 'completed')),
    ],
  };
}

// ── Traits ──

interface TraitFileLike {
  current?: Record<string, number>;
  history?: Array<{ timestamp?: number; source?: string; traits?: Record<string, number> }>;
}

export function readTraits(soulDir: string): { stats: TraitStats; history: TraitSnapshot[] } {
  // TraitRegisters writes `<botDir>/TRAITS.json`, a sibling of `soul/`; older
  // layouts kept it inside the soul dir. Accept both.
  const raw =
    readJsonSafe<TraitFileLike>(join(soulDir, 'TRAITS.json')) ??
    readJsonSafe<TraitFileLike>(join(soulDir, '..', 'TRAITS.json'));
  if (!raw || !raw.current || typeof raw.current !== 'object') {
    return { stats: { current: null, baseline: null, drift: null, adjustments: 0 }, history: [] };
  }
  const history: TraitSnapshot[] = (Array.isArray(raw.history) ? raw.history : [])
    .filter((h) => h?.traits && typeof h.traits === 'object')
    .map((h) => ({
      timestamp: Number(h.timestamp) || 0,
      source: String(h.source ?? 'unknown'),
      traits: h.traits as Record<string, number>,
    }));

  const current = raw.current;
  const baseline: Record<string, number> =
    history.length > 0
      ? history[0].traits
      : (createDefaultTraits() as unknown as Record<string, number>);
  const drift: Record<string, number> = {};
  for (const [name, value] of Object.entries(current)) {
    const base = baseline[name] ?? 0.5;
    drift[name] = Math.round((Number(value) - base) * 1000) / 1000;
  }
  return {
    stats: { current, baseline, drift, adjustments: history.length },
    history,
  };
}

// ── Soul health ──

export function readSoulHealth(soulDir: string): SoulStats {
  const missingFiles = CORE_SOUL_FILES.filter(
    (f) => statSizeSafe(join(soulDir, f)) === 0 && !exists(join(soulDir, f))
  );

  const motivations = readTextSafe(join(soulDir, 'MOTIVATIONS.md'));
  let lastReflectionAt: string | null = null;
  if (motivations) {
    // Reflection writers vary: "- date: …", "- Date: …", "- **Date:** …", "- **Fecha**: …".
    for (const m of motivations.matchAll(
      /^-\s*\**(?:date|fecha):?\**:?\s*(\d{4}-\d{2}-\d{2})\b/gim
    )) {
      if (lastReflectionAt === null || m[1] > lastReflectionAt) lastReflectionAt = m[1];
    }
  }

  const cooldown = readTextSafe(join(soulDir, '.last-health-check'));
  const lastHealthCheckAt = cooldown ? toIso(Number(cooldown.trim()) || 0) : null;

  const soul = readTextSafe(join(soulDir, 'SOUL.md'));
  const soulEqualsMotivations =
    soul !== null && motivations !== null && soul.trim() === motivations.trim();

  let dailyLogsPending = 0;
  try {
    dailyLogsPending = getUnconsolidatedLogs(soulDir).length;
  } catch {
    dailyLogsPending = 0;
  }

  return {
    lastReflectionAt,
    lastHealthCheckAt,
    memoryBytes: statSizeSafe(join(soulDir, 'MEMORY.md')),
    goalsBytes: statSizeSafe(join(soulDir, 'GOALS.md')),
    dailyLogsPending,
    soulEqualsMotivations,
    missingFiles,
  };
}

function exists(path: string): boolean {
  return readTextSafe(path) !== null;
}

// ── Feedback ──

export function readFeedbackLastAt(soulDir: string): number | null {
  let best: number | null = null;
  for (const e of readJsonlSafe<{ createdAt?: string }>(join(soulDir, 'feedback.jsonl'))) {
    const t = toMs(e.createdAt);
    if (t !== null && (best === null || t > best)) best = t;
  }
  return best;
}
