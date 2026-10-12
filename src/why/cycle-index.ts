/**
 * The cycle behind an item: lookups over `<data>/agent-cycles` for Why
 * builders. One read per bot per request, spanning that bot's items; a
 * failing reader leaves the bot empty. Pure apart from the injected reader.
 */
import type { WhyCycle } from './types';

/** The fields of an `<data>/agent-cycles` row the Why builders read. */
export interface CycleRow {
  cycleId: string;
  startedAt: string;
  endedAt?: string;
  planSummary?: string | null;
  goalId?: string | null;
  goalTitle?: string | null;
}

/** Cycle rows of a bot started in [sinceMs, untilMs]. */
export type CycleReader = (botId: string, sinceMs: number, untilMs: number) => CycleRow[];

/** A cycle can start this long before an item it produced. */
export const CYCLE_LOOKBACK_MS = 86_400_000;

/** The agent loop runs one cycle per bot at a time: the one whose run contains the time. */
export function findCycleAt(rows: CycleRow[], iso: string): CycleRow | undefined {
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return undefined;
  return rows.find((c) => {
    const start = Date.parse(c.startedAt);
    const end = c.endedAt ? Date.parse(c.endedAt) : Number.NaN;
    return start <= at && at <= end;
  });
}

export class CycleIndex {
  private constructor(private readonly rows: Map<string, CycleRow[]>) {}

  /** Load the cycles spanning every `{ botId, at }` item, one read per bot. */
  static for(
    read: CycleReader | undefined,
    items: Array<{ botId: string; at: string }>,
    onError?: (botId: string, err: unknown) => void
  ): CycleIndex {
    const rows = new Map<string, CycleRow[]>();
    if (!read) return new CycleIndex(rows);
    const span = new Map<string, { min: number; max: number }>();
    for (const { botId, at } of items) {
      const t = Date.parse(at);
      if (!Number.isFinite(t)) continue;
      const s = span.get(botId);
      span.set(
        botId,
        s ? { min: Math.min(s.min, t), max: Math.max(s.max, t) } : { min: t, max: t }
      );
    }
    for (const [botId, { min, max }] of span) {
      try {
        rows.set(botId, read(botId, min - CYCLE_LOOKBACK_MS, max));
      } catch (err) {
        onError?.(botId, err);
      }
    }
    return new CycleIndex(rows);
  }

  rowsFor(botId: string): CycleRow[] {
    return this.rows.get(botId) ?? [];
  }

  byId(botId: string, cycleId: string): CycleRow | undefined {
    return this.rowsFor(botId).find((r) => r.cycleId === cycleId);
  }

  at(botId: string, iso: string): CycleRow | undefined {
    return findCycleAt(this.rowsFor(botId), iso);
  }
}

export function toWhyCycle(
  botId: string,
  row: CycleRow,
  opts: { inferred?: boolean } = {}
): WhyCycle {
  const c: WhyCycle = { id: row.cycleId, botId };
  if (row.startedAt) c.startedAt = row.startedAt;
  if (row.planSummary) c.plan = row.planSummary;
  if (opts.inferred) c.inferred = true;
  return c;
}

/** What an item that recorded its cycle and goal ids can say about them. */
export interface CycleAttribution {
  cycle?: WhyCycle;
  goal?: { id?: string; title: string };
  /** A cycle id was recorded but the cycle log has no row for it. */
  unlogged?: true;
}

/**
 * Cycle and goal of an item that recorded `cycleId` / `goalId` when it was
 * written. The cycle row, when the log has it, adds the plan and the goal's
 * title (the item itself only stores the goal id). No cycle id: nothing.
 */
export function cycleAttribution(
  botId: string,
  ids: { cycleId?: string | null; goalId?: string | null },
  row: CycleRow | undefined
): CycleAttribution {
  if (!ids.cycleId) return {};
  if (!row) return { cycle: { id: ids.cycleId, botId }, unlogged: true };
  const out: CycleAttribution = { cycle: toWhyCycle(botId, row) };
  const goalId = ids.goalId || row.goalId || undefined;
  // The row's title names the row's goal: never put it on a different recorded goal.
  const sameGoal = !ids.goalId || !row.goalId || ids.goalId === row.goalId;
  if (row.goalTitle && sameGoal)
    out.goal = { ...(goalId ? { id: goalId } : {}), title: row.goalTitle };
  return out;
}

const MODE_REASON_TEXT: Record<string, string> = {
  concentration: 'one topic was taking over its recent cycles',
  'no-surprise': 'nothing had surprised it for a while',
  budget: 'its regular exploration turn was due',
  'operator-silent': 'you had been quiet, so it explores more often',
};

/** Why a cycle explored, in plain words; nothing for an ordinary cycle. */
export function describeModeReason(reason: string | undefined): string | undefined {
  return reason ? MODE_REASON_TEXT[reason] : undefined;
}
