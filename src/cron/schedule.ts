import { Cron } from 'croner';
import type { CronSchedule } from './types';

function resolveCronTimezone(tz?: string) {
  const trimmed = typeof tz === 'string' ? tz.trim() : '';
  if (trimmed) {
    return trimmed;
  }
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

export function computeNextRunAtMs(schedule: CronSchedule, nowMs: number): number | undefined {
  if (schedule.kind === 'at') {
    const atMs = new Date(schedule.at).getTime();
    if (!Number.isFinite(atMs)) {
      return undefined;
    }
    return atMs > nowMs ? atMs : undefined;
  }

  if (schedule.kind === 'every') {
    const everyMs = Math.max(1, Math.floor(schedule.everyMs));
    const anchor = Math.max(0, Math.floor(schedule.anchorMs ?? nowMs));
    if (nowMs < anchor) {
      return anchor;
    }
    const elapsed = nowMs - anchor;
    const steps = Math.max(1, Math.floor((elapsed + everyMs - 1) / everyMs));
    return anchor + steps * everyMs;
  }

  const expr = schedule.expr.trim();
  if (!expr) {
    return undefined;
  }
  const cron = new Cron(expr, {
    timezone: resolveCronTimezone(schedule.tz),
  });
  const nowSecondMs = Math.floor(nowMs / 1000) * 1000;
  const next = cron.nextRun(new Date(nowSecondMs));
  if (!next) {
    return undefined;
  }
  const nextMs = next.getTime();
  return Number.isFinite(nextMs) && nextMs >= nowSecondMs ? nextMs : undefined;
}

/**
 * Every run of `schedule` in `[fromMs, untilMs)`, oldest first, at most `max`
 * (the Automations page draws the next 7 days). Never throws: a schedule
 * croner rejects yields no runs.
 */
export function upcomingRunsMs(
  schedule: CronSchedule,
  fromMs: number,
  untilMs: number,
  max = 50
): number[] {
  const out: number[] = [];
  let cursor = fromMs;
  try {
    while (out.length < max) {
      const next = computeNextRunAtMs(schedule, cursor);
      if (next === undefined || next >= untilMs || next < cursor) break;
      out.push(next);
      if (schedule.kind === 'at') break;
      // Cron runs on whole seconds; an interval can be shorter than one.
      cursor = next + (schedule.kind === 'every' ? 1 : 1000);
    }
  } catch {
    return out;
  }
  return out;
}
