/**
 * "Why this?" — one model for every surface of the dashboard that shows
 * something an agent (or the system acting on it) produced or decided.
 *
 * Built only from what was recorded when the thing happened (cycle log, tool
 * audit, goal events, editor notes, the strategist's own words); never from
 * an LLM asked to explain it afterwards. Builders (`src/why/builders/`) turn a
 * record into a `Why`; `web/ui/why.js` renders every one the same way:
 * What · By · Goal · Working on (+ Open cycle) · Mode · Reason · Rule ·
 * Related · Outcome · Notes, then footnotes for inferred / missing data.
 * Plan: docs/plans/why-everywhere-plan.md.
 */
import { z } from 'zod';

export const WHY_ACTORS = [
  'agent',
  'strategist',
  'navigator',
  'curiosity',
  'reflection',
  'lint',
  'hygiene',
  'operator',
  'cron',
  'peer',
  'system',
  'watcher',
] as const;

export type WhyActor = (typeof WHY_ACTORS)[number];

/** The agent-loop cycle behind an item; "Open cycle" opens it. */
export interface WhyCycle {
  id: string;
  botId: string;
  startedAt?: string;
  /** What the cycle set out to do (capped). */
  plan?: string;
  mode?: 'explore' | 'exploit';
  /** Why it explored, in plain words. */
  modeReason?: string;
  /** Explore cycle: the question it chased. */
  chasing?: string;
  /** Matched by time after the fact, not recorded. */
  inferred?: boolean;
}

export interface WhyRelatedItem {
  text: string;
  at?: string;
  detail?: string;
  href?: string;
}

export interface Why {
  /** One line: what produced this. */
  what: string;
  by?: WhyActor;
  cycle?: WhyCycle;
  goal?: { id?: string; title: string };
  /** Stated reasoning, and who stated it ("Strategist", "Agent's justification"). */
  reason?: { text: string; source: string };
  /** Deterministic rule that fired, in plain words. */
  rule?: string;
  /** Items it was built from or led to. */
  related?: { label: string; items: WhyRelatedItem[]; note?: string };
  /** One sentence: what happened to it. */
  outcome?: string;
  notes?: Array<{ label: string; text: string }>;
  /** What cannot be known, said plainly. */
  missing?: string;
}

const nonEmpty = z.string().min(1);

export const WhyCycleSchema = z
  .object({
    id: nonEmpty,
    botId: nonEmpty,
    startedAt: z.string().optional(),
    plan: z.string().optional(),
    mode: z.enum(['explore', 'exploit']).optional(),
    modeReason: z.string().optional(),
    chasing: z.string().optional(),
    inferred: z.boolean().optional(),
  })
  .strict();

export const WhySchema = z
  .object({
    what: nonEmpty,
    by: z.enum(WHY_ACTORS).optional(),
    cycle: WhyCycleSchema.optional(),
    goal: z.object({ id: z.string().optional(), title: nonEmpty }).strict().optional(),
    reason: z.object({ text: nonEmpty, source: nonEmpty }).strict().optional(),
    rule: nonEmpty.optional(),
    related: z
      .object({
        label: nonEmpty,
        items: z
          .array(
            z
              .object({
                text: nonEmpty,
                at: z.string().optional(),
                detail: z.string().optional(),
                href: z.string().optional(),
              })
              .strict()
          )
          .min(1),
        note: z.string().optional(),
      })
      .strict()
      .optional(),
    outcome: nonEmpty.optional(),
    notes: z.array(z.object({ label: nonEmpty, text: nonEmpty }).strict()).optional(),
    missing: nonEmpty.optional(),
  })
  .strict();
