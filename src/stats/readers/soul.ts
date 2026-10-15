/**
 * Per-bot soul directory readers: GOALS.md, TRAITS.json, the core soul files'
 * health and the feedback log. All read-only, all tolerant of a missing dir.
 */
import { join } from 'node:path';
import { getUnconsolidatedLogs } from '../../bot/soul-memory-consolidator';
import { createDefaultTraits } from '../../bot/trait-registers';
import { type StoredTask, liveClaim, readTasksSnapshot } from '../../goals/task-store';
import { type GoalEntry, parseGoals } from '../../tools/goals';
import type { TraitChangeRecord } from '../../why/builders/trait-change';
import type {
  GoalDetail,
  GoalTaskView,
  GoalsStats,
  SoulStats,
  TraitSnapshot,
  TraitStats,
} from '../types';
import { readJsonSafe, readJsonlSafe, readTextSafe, statSizeSafe, toIso, toMs } from '../util';
import { type GoalExtras, goalTitleKey, readGoalExtras } from './goal-events';

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

/** A stored task as the boards read it. */
export function toTaskView(t: StoredTask, nowMs: number = Date.now()): GoalTaskView {
  const view: GoalTaskView = {
    id: t.id,
    text: t.text,
    lane: t.lane,
    status: t.lane,
    done: t.lane === 'done',
    by: t.by,
    note: t.note ?? null,
    cycleId: t.createdCycle ?? null,
  };
  const claim = liveClaim(t, nowMs);
  if (claim) view.claim = { runId: claim.runId };
  return view;
}

function toDetail(
  g: GoalEntry,
  section: 'active' | 'completed',
  extras: GoalExtras | undefined,
  tasksOf: (goalId: string | null) => GoalTaskView[]
): GoalDetail {
  const id = g.id ?? extras?.id ?? null;
  return {
    id,
    text: g.text,
    status: g.status,
    priority: g.priority,
    notes: g.notes ?? null,
    notesLength: g.notes?.length ?? 0,
    completed: g.completed ?? null,
    outcome: g.outcome ?? null,
    source: g.source ?? null,
    section,
    tasks: tasksOf(id),
    headline: g.headline ?? null,
    parent: g.parent ?? null,
    kind: g.kind ?? null,
    dropped: g.dropped ?? null,
  };
}

export function readGoals(soulDir: string): {
  stats: GoalsStats;
  detail: GoalDetail[];
  /** Revision of the task store (TASKS.json); 0 before the first write. */
  tasksRev: number;
} {
  const { active, completed } = parseGoals(readTextSafe(join(soulDir, 'GOALS.md')));
  const extras = readGoalExtras(soulDir);
  let snapshot: { rev: number; tasks: StoredTask[] } = { rev: 0, tasks: [] };
  try {
    snapshot = readTasksSnapshot(soulDir);
  } catch {
    // a missing or unreadable store reads as no tasks
  }
  const nowMs = Date.now();
  const tasksOf = (goalId: string | null) =>
    goalId
      ? snapshot.tasks
          .filter((t) => t.goalId === goalId)
          .sort((a, b) => a.order - b.order)
          .map((t) => toTaskView(t, nowMs))
      : [];

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
      ...active.map((g) => toDetail(g, 'active', extras.get(goalTitleKey(g.text)), tasksOf)),
      ...completed.map((g) => toDetail(g, 'completed', extras.get(goalTitleKey(g.text)), tasksOf)),
    ],
    tasksRev: snapshot.rev,
  };
}

// ── Traits ──

interface TraitSnapshotLike {
  timestamp?: number;
  source?: string;
  traits?: Record<string, number>;
  cycleId?: string;
  reasons?: Record<string, unknown>;
  changes?: Record<string, { from?: unknown; to?: unknown; requested?: unknown }>;
  rejected?: Record<string, { requested?: unknown; rule?: unknown }>;
}

interface TraitFileLike {
  current?: Record<string, number>;
  history?: TraitSnapshotLike[];
  rejections?: TraitSnapshotLike[];
}

function readTraitFile(soulDir: string): TraitFileLike | null {
  // TraitRegisters writes `<botDir>/TRAITS.json`, a sibling of `soul/`; older
  // layouts kept it inside the soul dir. Accept both.
  return (
    readJsonSafe<TraitFileLike>(join(soulDir, 'TRAITS.json')) ??
    readJsonSafe<TraitFileLike>(join(soulDir, '..', 'TRAITS.json'))
  );
}

/** How many trait changes the Agent Home lists. */
export const TRAIT_CHANGES_LIMIT = 8;

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Recorded fields of one snapshot → a change record (`derived` false). */
function recordedChange(s: TraitSnapshotLike): Omit<TraitChangeRecord, 'ts' | 'source'> {
  const changes: TraitChangeRecord['changes'] = [];
  for (const [trait, c] of Object.entries(s.changes ?? {})) {
    const from = num(c?.from);
    const to = num(c?.to);
    if (from === null || to === null) continue;
    const requested = num(c?.requested);
    changes.push({ trait, from, to, ...(requested !== null ? { requested } : {}) });
  }
  const rejected: TraitChangeRecord['rejected'] = [];
  for (const [trait, r] of Object.entries(s.rejected ?? {})) {
    const requested = num(r?.requested);
    if (requested === null || (r?.rule !== 'pinned' && r?.rule !== 'locked')) continue;
    rejected.push({ trait, requested, rule: r.rule });
  }
  const reasons: Record<string, string> = {};
  for (const [trait, text] of Object.entries(s.reasons ?? {})) {
    if (typeof text === 'string' && text.trim()) reasons[trait] = text.trim();
  }
  return { cycleId: s.cycleId ?? null, changes, rejected, reasons, derived: false };
}

/**
 * A bot's trait changes, newest first (Agent Home → Traits): history
 * snapshots with their recorded `changes`/`rejected`/`reasons`, proposals
 * refused entirely (`rejections`), and legacy snapshots diffed against the
 * one before them (`derived`). The first snapshot is the baseline, not a
 * change; snapshots where nothing moved are left out.
 */
export function readTraitChanges(
  soulDir: string,
  limit: number = TRAIT_CHANGES_LIMIT
): TraitChangeRecord[] {
  const raw = readTraitFile(soulDir);
  if (!raw) return [];
  const out: TraitChangeRecord[] = [];
  const history = (Array.isArray(raw.history) ? raw.history : []).filter(
    (h) => h?.traits && typeof h.traits === 'object'
  );
  history.forEach((snap, i) => {
    const ts = toIso(Number(snap.timestamp) || 0) ?? new Date(0).toISOString();
    const source = String(snap.source ?? 'unknown');
    if (snap.changes || snap.rejected) {
      const rec = recordedChange(snap);
      if (rec.changes.length + rec.rejected.length > 0) out.push({ ts, source, ...rec });
      return;
    }
    const prev = history[i - 1]?.traits;
    if (!prev) return;
    const changes: TraitChangeRecord['changes'] = [];
    for (const [trait, value] of Object.entries(snap.traits ?? {})) {
      const from = num(prev[trait]);
      const to = num(value);
      if (from === null || to === null || Math.abs(to - from) < 0.005) continue;
      changes.push({ trait, from, to });
    }
    if (changes.length === 0) return;
    out.push({
      ts,
      source,
      cycleId: snap.cycleId ?? null,
      changes,
      rejected: [],
      reasons: {},
      derived: true,
    });
  });
  for (const snap of Array.isArray(raw.rejections) ? raw.rejections : []) {
    const rec = recordedChange(snap);
    if (rec.rejected.length === 0) continue;
    out.push({
      ts: toIso(Number(snap.timestamp) || 0) ?? new Date(0).toISOString(),
      source: String(snap.source ?? 'unknown'),
      ...rec,
    });
  }
  return out.sort((a, b) => (toMs(b.ts) ?? 0) - (toMs(a.ts) ?? 0)).slice(0, Math.max(0, limit));
}

export function readTraits(soulDir: string): { stats: TraitStats; history: TraitSnapshot[] } {
  const raw = readTraitFile(soulDir);
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
