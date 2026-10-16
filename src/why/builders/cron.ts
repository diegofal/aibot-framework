import { cronToHuman } from '../../cron/nl-parse';
/**
 * Why for a scheduled job and for one of its runs (Automations → Cron).
 *
 * A job says who set it up (`CronJob.createdBy`: the agent through the `cron`
 * tool, with the cycle and goal it was in, or you on the dashboard), the
 * schedule in words and what it tells the agent. A run says which job, when,
 * and how it went: status plus the head of the output (the agent's reply for
 * an instruction). Jobs written before `createdBy` existed say so.
 */
import type { CronRunLogEntry } from '../../cron/run-log';
import type { CronJob, CronSchedule } from '../../cron/types';
import { type CycleRow, cycleAttribution } from '../cycle-index';
import type { Why } from '../types';
import { NO_CYCLE_TEXT, UNLOGGED_CYCLE_TEXT } from './ask';

export interface CronJobWhyInput {
  job: CronJob;
  /** The cycle-log row for `createdBy.cycleId`, when the log has it. */
  cycle?: CycleRow;
}

export interface CronRunWhyInput {
  run: CronRunLogEntry;
  /** The job the run belongs to; absent when it was deleted. */
  job?: CronJob;
}

const NOTE_CHARS = 300;
const OUTPUT_CHARS = 200;
const ERROR_CHARS = 200;

const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);
const flat = (s: string) => s.replace(/\s+/g, ' ').trim();

const UNITS: Array<[number, string]> = [
  [86_400_000, 'day'],
  [3_600_000, 'hour'],
  [60_000, 'minute'],
  [1_000, 'second'],
];

/** A job's schedule in words ("Every day at 09:00 (UTC)", "Every 30 minutes", "Once, at …"). */
export function describeSchedule(schedule: CronSchedule): string {
  if (schedule.kind === 'cron') return cronToHuman(schedule.expr, schedule.tz);
  if (schedule.kind === 'at') return `Once, at ${schedule.at}`;
  const ms = schedule.everyMs;
  const [unit, word] = UNITS.find(([u]) => ms >= u && ms % u === 0) ??
    UNITS.find(([u]) => ms >= u) ?? [1_000, 'second'];
  const n = Math.max(1, Math.round(ms / unit));
  return `Every ${n} ${word}${n === 1 ? '' : 's'}`;
}

const lowerFirst = (s: string) => (s ? s[0].toLowerCase() + s.slice(1) : s);

function scheduleRule(job: CronJob): string {
  return `Runs ${lowerFirst(describeSchedule(job.schedule))}`;
}

function jobNote(job: CronJob): { label: string; text: string } | undefined {
  const p = job.payload;
  if (p.kind === 'skillJob') return { label: 'Skill job', text: `${p.skillId} / ${p.jobId}` };
  const text = flat(p.text ?? '');
  if (!text) return undefined;
  return { label: p.kind === 'message' ? 'Message' : 'Instruction', text: clip(text, NOTE_CHARS) };
}

function jobOutcome(job: CronJob): string {
  const head = job.enabled ? 'Active' : 'Paused';
  const s = job.state ?? { consecutiveErrors: 0 };
  if (!s.lastStatus) return `${head}; it has not run yet.`;
  if (s.lastStatus === 'ok') return `${head}. Its last run went fine.`;
  if (s.lastStatus === 'skipped') return `${head}. Its last run was skipped.`;
  const n = s.consecutiveErrors ?? 0;
  return `${head}. Its last run failed${n > 1 ? ` (${n} errors in a row)` : ''}.`;
}

/** "Set up by you" / "Set up by the agent" / nothing for old jobs: the run's link back. */
function creatorText(job: CronJob): string | undefined {
  if (!job.createdBy) return undefined;
  if (job.createdBy.kind === 'tenant') return 'Set up through the API';
  return job.createdBy.kind === 'operator' ? 'Set up by you' : 'Set up by the agent';
}

export function cronJobToWhy(input: CronJobWhyInput): Why {
  const { job } = input;
  const by = job.createdBy;
  const why: Why = {
    what:
      by?.kind === 'operator'
        ? 'A scheduled job you set up'
        : by?.kind === 'agent'
          ? 'A scheduled job the agent set up'
          : by?.kind === 'tenant'
            ? 'A scheduled job set up through the API'
            : 'A scheduled job',
  };
  if (by?.kind === 'operator' || by?.kind === 'agent') {
    why.by = by.kind === 'operator' ? 'operator' : 'agent';
  }
  let missing: string | undefined;
  if (by?.kind === 'agent') {
    const { cycle, goal, unlogged } = cycleAttribution(by.botId, by, input.cycle);
    if (cycle) why.cycle = cycle;
    if (goal) why.goal = goal;
    if (!cycle) missing = NO_CYCLE_TEXT;
    else if (unlogged) missing = UNLOGGED_CYCLE_TEXT;
  } else if (!by) {
    missing = 'Created before jobs recorded who made them, so its origin is unknown.';
  }
  why.rule = scheduleRule(job);
  why.outcome = jobOutcome(job);
  const note = jobNote(job);
  if (note) why.notes = [note];
  if (missing) why.missing = missing;
  return why;
}

function seconds(ms: number | undefined): string {
  return typeof ms === 'number' && Number.isFinite(ms) ? ` in ${(ms / 1000).toFixed(1)} s` : '';
}

function runOutcome(run: CronRunLogEntry): string {
  if (run.status === 'error') {
    return `Failed: ${clip(flat(run.error ?? '') || 'no error text was recorded', ERROR_CHARS)}`;
  }
  if (run.status === 'skipped') {
    const why = flat(run.error ?? '');
    return why ? `Skipped: ${clip(why, ERROR_CHARS)}` : 'Skipped.';
  }
  const output = flat(run.output ?? '');
  const head = `Ran fine${seconds(run.durationMs)}.`;
  return output ? `${head} Output: "${clip(output, OUTPUT_CHARS)}"` : head;
}

export function cronRunToWhy(input: CronRunWhyInput): Why {
  const { run, job } = input;
  const why: Why = {
    what: job ? `A run of "${job.name}"` : 'A run of a scheduled job',
    by: 'cron',
  };
  if (job) {
    why.rule = scheduleRule(job);
    const at = Number.isFinite(run.runAtMs) ? new Date(run.runAtMs as number).toISOString() : '';
    const detail = creatorText(job);
    why.related = {
      label: 'Job',
      items: [
        {
          text: job.name,
          ...(at ? { at } : {}),
          ...(detail ? { detail } : {}),
          href: `#/automations/cron/${encodeURIComponent(job.id)}`,
        },
      ],
    };
  }
  why.outcome = runOutcome(run);
  if (!job) why.missing = 'The job is gone, so its schedule and origin are unknown.';
  return why;
}
