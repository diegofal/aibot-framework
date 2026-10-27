/**
 * Self-improvement, the bot loop (`docs/plans/self-improve-plan.md`): run
 * after every cycle, it measures the bot's active lessons, closes the ones
 * whose window ended, and writes at most one new lesson for a failure class
 * that kept repeating. Code decides everything except the lesson's wording.
 * Never throws: a failure is logged and the cycle goes on.
 */

import { randomBytes } from 'node:crypto';
import type { Logger } from '../../logger';
import { appendSoulEvent } from '../soul-events';
import type { ToolAuditEntry } from '../tool-audit-log';
import { findCandidates } from './detector';
import { type LessonEvaluation, baselineFor, evaluateLesson } from './measure';
import type { LessonStore } from './store';
import {
  BASELINE_DAYS,
  LESSONS_FILE,
  type Lesson,
  type LessonStatus,
  type LessonsFile,
  type ResolvedSelfImprove,
  isLessonInPrompt,
} from './types';
import { writeLesson } from './writer';

const DAY_MS = 86_400_000;

export interface SelfImproveDeps {
  store: LessonStore;
  /** The bot's tool audit in `[sinceMs, nowMs]`. */
  readAudit(sinceMs: number, nowMs: number): ToolAuditEntry[];
  /** The writer's one LLM call; absent → the fixed sentence per class. */
  generate?: (system: string, prompt: string) => Promise<string>;
  nowMs(): number;
  logger: Pick<Logger, 'warn'>;
  /** Where `soul-events.jsonl` lives (the store's soul dir). */
  soulDir: string;
  newId?: () => string;
}

export interface SelfImproveRunInput {
  botId: string;
  cfg: ResolvedSelfImprove;
  cycleId?: string;
}

export interface SelfImproveRunResult {
  ok: boolean;
  skipped?: 'disabled';
  /** Active lessons checked against their measurement window. */
  evaluated?: number;
  /** Lessons whose status changed this run. */
  changed?: Array<{ id: string; from: LessonStatus; to: LessonStatus }>;
  /** Id of the lesson created this run, if any. */
  created?: string;
  error?: string;
}

const newLessonId = () => `l-${randomBytes(4).toString('hex')}`;

/**
 * Classes that must not get a new lesson: those with a lesson in the prompt,
 * and those whose lesson was retired or found unproven in the last
 * `measureDays` days (a lesson that just failed is not rewritten at once).
 */
export function blockedClassKeys(
  lessons: Lesson[],
  cfg: ResolvedSelfImprove,
  nowMs: number
): Set<string> {
  const coolDownSince = nowMs - cfg.measureDays * DAY_MS;
  const keys = new Set<string>();
  for (const l of lessons) {
    if (isLessonInPrompt(l)) {
      keys.add(l.classKey);
    } else if (l.status === 'retired' || l.status === 'unproven') {
      const at = Date.parse(l.updatedAt);
      if (Number.isFinite(at) && at >= coolDownSince) keys.add(l.classKey);
    }
  }
  return keys;
}

export async function runSelfImprove(
  deps: SelfImproveDeps,
  input: SelfImproveRunInput
): Promise<SelfImproveRunResult> {
  const { botId, cfg, cycleId } = input;
  if (!cfg.enabled) return { ok: true, skipped: 'disabled' };
  try {
    const nowMs = deps.nowMs();
    const nowIso = new Date(nowMs).toISOString();
    // One read: the baseline window plus a measurement window that may have
    // been extended once.
    const entries = deps.readAudit(nowMs - (BASELINE_DAYS + 2 * cfg.measureDays) * DAY_MS, nowMs);
    const file = deps.store.read();

    // b) Measure every active lesson.
    const evaluations = new Map<string, LessonEvaluation>();
    let evaluated = 0;
    for (const l of file.lessons) {
      if (l.status !== 'active') continue;
      evaluated++;
      const result = evaluateLesson(l, entries, cfg, nowMs);
      if (result) evaluations.set(l.id, result);
    }
    const afterEval = file.lessons.map((l) => {
      const e = evaluations.get(l.id);
      // Stamped now: a lesson retired in this run starts its cool-down now.
      return e ? { ...l, status: e.status, updatedAt: nowIso } : l;
    });

    // c) Detect: at most one new lesson, only while there is room in the prompt.
    let created: Lesson | undefined;
    if (afterEval.filter(isLessonInPrompt).length < cfg.maxActive) {
      const [candidate] = findCandidates({
        entries,
        nowMs,
        minRepeats: cfg.minRepeats,
        activeClassKeys: blockedClassKeys(afterEval, cfg, nowMs),
        suppressedClassKeys: new Set(file.suppressed.map((s) => s.classKey)),
      });
      if (candidate) {
        const written = await writeLesson(candidate, { generate: deps.generate });
        created = {
          id: (deps.newId ?? newLessonId)(),
          classKey: candidate.cls.key,
          tool: candidate.cls.tool,
          errorClass: candidate.cls.errorClass,
          text: written.text,
          textSource: written.textSource,
          evidence: written.evidence,
          source: 'own',
          status: 'active',
          createdAt: nowIso,
          updatedAt: nowIso,
          ...(cycleId ? { cycleId } : {}),
          baseline: baselineFor(entries, candidate.cls, nowMs),
        };
      }
    }

    if (evaluations.size === 0 && !created) return { ok: true, evaluated, changed: [] };

    // d) One write, applied to the file as it is now: a lesson someone else
    // already moved is left alone, and a class that got a lesson meanwhile
    // does not get a second one.
    const changed: Array<{ id: string; from: LessonStatus; to: LessonStatus; lesson: Lesson }> = [];
    let createdId: string | undefined;
    deps.store.update((current): LessonsFile => {
      changed.length = 0;
      createdId = undefined;
      const lessons = current.lessons.map((l) => {
        const e = evaluations.get(l.id);
        if (!e || l.status !== 'active') return l;
        const next: Lesson = {
          ...l,
          status: e.status,
          statusReason: e.statusReason,
          measure: e.measure,
          extended: e.extended,
          updatedAt: nowIso,
        };
        if (e.status !== l.status)
          changed.push({ id: l.id, from: l.status, to: e.status, lesson: next });
        return next;
      });
      // Re-checked on the file as it is now: the writer call may have taken a
      // while, and the watcher may have suppressed the class or the prompt
      // may have filled up meanwhile.
      if (
        created &&
        !blockedClassKeys(lessons, cfg, nowMs).has(created.classKey) &&
        !current.suppressed.some((sc) => sc.classKey === created.classKey) &&
        lessons.filter(isLessonInPrompt).length < cfg.maxActive
      ) {
        lessons.push(created);
        createdId = created.id;
      }
      return { ...current, lessons };
    });

    // e) Record: one soul event per change.
    const event = (summary: string, detail: string[]) =>
      appendSoulEvent(deps.soulDir, {
        file: LESSONS_FILE,
        op: 'lesson',
        actor: 'agent',
        summary,
        detail,
        ...(cycleId ? { cycleId } : {}),
        now: () => new Date(nowMs),
        onError: (err) => deps.logger.warn({ botId, err }, 'Self-improve: soul event not written'),
      });
    for (const c of changed) {
      event(`Lesson ${c.to}: ${c.lesson.text}`, [c.lesson.classKey, c.lesson.statusReason ?? '']);
    }
    if (createdId && created) {
      const b = created.baseline;
      event(`New lesson: ${created.text}`, [
        created.classKey,
        `baseline ${b.failures} of ${b.calls} calls failed this way in the ${BASELINE_DAYS} days before`,
      ]);
    }

    return {
      ok: true,
      evaluated,
      changed: changed.map(({ id, from, to }) => ({ id, from, to })),
      ...(createdId ? { created: createdId } : {}),
    };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    deps.logger.warn({ botId, err: error }, 'Self-improve: run failed, cycle continues');
    return { ok: false, error };
  }
}
