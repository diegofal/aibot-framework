/**
 * "What I'm doing now" — a first-person, deterministic sentence derived from
 * an agent's live state. No LLM: the line must be cheap, instant and stable
 * so the dashboard can show it on every card and update it on every event.
 *
 * Branch order matters: a running cycle beats everything, then a pending
 * question for the human, then blocked / skipped / idle / standby, then the
 * plain "between cycles" default.
 */
import type { Posture } from './types';

export type NowTone = 'ok' | 'warn' | 'danger' | 'info' | 'muted';

export interface NowInput {
  enabled: boolean;
  /** Bot process is up (Telegram poller or headless runtime). */
  running: boolean;
  posture: Posture;
  /** A cycle is executing right now. */
  isExecuting: boolean;
  /** Last agent:phase seen while executing (start, planner:start, executor:start, …). */
  phase: string | null;
  /** Tool currently running, when known. */
  currentTool: string | null;
  lastRunAt: number | null;
  nextRunAt: number | null;
  skippedReason: string | null;
  lastError: string | null;
  pendingAsks: number;
  nowMs: number;
}

export interface NowLine {
  text: string;
  tone: NowTone;
}

/** "now", "in 5m", "in 2h", "in 3d" — never negative. */
export function relativeIn(nowMs: number, ts: number | null | undefined): string {
  if (ts == null || !Number.isFinite(ts)) return 'soon';
  const diff = ts - nowMs;
  if (diff <= 30_000) return 'now';
  const m = Math.round(diff / 60_000);
  if (m < 60) return `in ${m}m`;
  const h = Math.round(diff / 3_600_000);
  if (h < 48) return `in ${h}h`;
  return `in ${Math.round(diff / 86_400_000)}d`;
}

/** Human label for a loop phase, optionally naming the running tool. */
export function phaseLabel(phase: string | null, currentTool: string | null): string {
  if (currentTool) return `I'm working: running ${currentTool}.`;
  switch (phase) {
    case 'strategist:start':
      return "I'm reflecting on my goals and focus.";
    case 'strategist:end':
    case 'planner:start':
      return "I'm deciding what to do next.";
    case 'planner:end':
    case 'executor:start':
      return "I'm executing my plan.";
    case 'start':
      return "I'm starting a new cycle.";
    default:
      return "I'm in the middle of a cycle.";
  }
}

function trimReason(reason: string, max = 80): string {
  const r = reason.replace(/\s+/g, ' ').trim();
  return r.length > max ? `${r.slice(0, max - 1)}…` : r;
}

export function describeNow(i: NowInput): NowLine {
  if (!i.enabled) {
    return { text: "I'm disabled. Enable me and I'll start on the next boot.", tone: 'muted' };
  }
  if (!i.running) {
    return { text: "I'm not running right now.", tone: 'muted' };
  }
  if (i.isExecuting) {
    return { text: phaseLabel(i.phase, i.currentTool), tone: 'info' };
  }
  if (i.pendingAsks > 0) {
    const n = i.pendingAsks;
    return {
      text: `I'm waiting on you — ${n} question${n === 1 ? '' : 's'} in your inbox.`,
      tone: 'warn',
    };
  }
  if (i.posture === 'blocked') {
    const why = i.lastError ? trimReason(i.lastError) : 'all my goals are blocked';
    return { text: `I'm blocked: ${why}.`, tone: 'danger' };
  }
  if (i.skippedReason) {
    return {
      text: `My last cycle was skipped (${trimReason(i.skippedReason, 40)}); I'll try again ${relativeIn(i.nowMs, i.nextRunAt)}.`,
      tone: 'warn',
    };
  }
  if (i.lastRunAt === null) {
    return {
      text: `I haven't run yet; my first cycle is ${relativeIn(i.nowMs, i.nextRunAt)}.`,
      tone: 'muted',
    };
  }
  if (i.posture === 'idle') {
    return { text: "I have no active goals. Give me one and I'll get going.", tone: 'warn' };
  }
  if (i.posture === 'standby') {
    return {
      text: `I've been quiet for a while; my next check-in is ${relativeIn(i.nowMs, i.nextRunAt)}.`,
      tone: 'warn',
    };
  }
  return { text: `I'm between cycles; next run ${relativeIn(i.nowMs, i.nextRunAt)}.`, tone: 'ok' };
}
