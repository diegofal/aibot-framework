/**
 * goal-lint — structural checks on GOALS.md.
 *
 * Reuses the canonical parser/serializer from src/tools/goals.ts so the file
 * is rewritten exactly the way the manage_goals tool would write it.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type GoalEntry, parseGoals, serializeGoals } from '../../tools/goals';
import { assertWithinRoots, backupFile } from '../fs-safe';
import {
  daysBetween,
  extractDates,
  jaccard,
  localDate,
  localTime,
  titleTokens,
} from '../text-utils';
import type { HygieneApplyResult, HygieneContext, HygieneFinding, HygieneRoutine } from '../types';

const GOALS_FILE = 'GOALS.md';
const NOTES_LIMIT = 1000;
const NOTES_KEEP = 600;
const DUPLICATE_THRESHOLD = 0.6;
const STALE_DAYS = 14;
const ARCHIVED_STATUSES = new Set(['archived', 'completed', 'done']);
const BLOCKED_STATUSES = new Set(['blocked', 'stalled']);
const CHANNEL_KEYWORDS = /\b(telegram|career|carrera|chat)\b/i;

function goalLine(lines: string[], text: string): number | null {
  const needle = `- [ ] ${text}`;
  const idx = lines.findIndex((l) => l.trim() === needle);
  return idx === -1 ? null : idx + 1;
}

function trimmedNotes(original: string, today: string): string {
  return `${original.slice(0, NOTES_KEEP)} … [trimmed by goal-lint; full text in memory/${today}.md]`;
}

export const goalLint: HygieneRoutine = {
  id: 'goal-lint',
  name: 'Goal lint',
  description:
    'Checks GOALS.md for archived goals left under Active, duplicate titles, oversized notes, stale blocks and triggers tied to a dead channel.',
  scope: 'bot',
  canApply: true,

  preview(ctx: HygieneContext): HygieneFinding[] {
    if (!ctx.soulDir || !ctx.botId) return [];
    const path = join(ctx.soulDir, GOALS_FILE);
    if (!existsSync(path)) return [];

    const content = readFileSync(path, 'utf-8');
    const lines = content.split('\n');
    const { active } = parseGoals(content);
    const findings: HygieneFinding[] = [];
    const today = localDate(ctx.now);

    active.forEach((goal, index) => {
      const line = goalLine(lines, goal.text);
      const base = { file: GOALS_FILE, line, data: { index, title: goal.text } };
      const status = goal.status.toLowerCase();

      if (ARCHIVED_STATUSES.has(status)) {
        findings.push({
          ...base,
          id: `goal-lint:archived-in-active:${index}`,
          kind: 'archived-in-active',
          severity: 'warn',
          message: `"${goal.text}" is under Active Goals but has status=${goal.status}`,
          fixable: true,
          fix: {
            action: 'move-to-completed',
            details: `Move to Completed with completed: ${today}, outcome: moved by goal-lint (was status=${goal.status})`,
          },
        });
      }

      if (goal.notes && goal.notes.length > NOTES_LIMIT) {
        findings.push({
          ...base,
          id: `goal-lint:oversized-notes:${index}`,
          kind: 'oversized-notes',
          severity: 'info',
          message: `Notes of "${goal.text}" are ${goal.notes.length} chars (limit ${NOTES_LIMIT})`,
          fixable: true,
          fix: {
            action: 'trim-notes',
            details: `Keep the first ${NOTES_KEEP} chars; append the full text to memory/${today}.md`,
          },
        });
      }

      if (BLOCKED_STATUSES.has(status) && goal.notes) {
        const stale = extractDates(goal.notes, ctx.now).filter(
          (d) => daysBetween(d, ctx.now) > STALE_DAYS
        );
        if (stale.length > 0) {
          findings.push({
            ...base,
            id: `goal-lint:stale-block:${index}`,
            kind: 'stale-block',
            severity: 'warn',
            message: `"${goal.text}" has been ${goal.status} since ${localDate(stale[0])} (${daysBetween(stale[0], ctx.now)} days)`,
            fixable: false,
          });
        }
      }

      const haystack = `${goal.text} ${goal.notes ?? ''}`;
      if (CHANNEL_KEYWORDS.test(haystack)) {
        const state = ctx.deps.channelStateOf(ctx.botId as string);
        if (state !== undefined && state !== 'ok') {
          findings.push({
            ...base,
            id: `goal-lint:dead-trigger:${index}`,
            kind: 'dead-trigger',
            severity: 'warn',
            message: `"${goal.text}" depends on the bot's channel, whose state is "${state}"`,
            fixable: false,
          });
        }
      }
    });

    // Pairwise duplicate detection over normalised titles
    const tokens = active.map((g) => titleTokens(g.text));
    for (let i = 0; i < active.length; i++) {
      for (let j = i + 1; j < active.length; j++) {
        const score = jaccard(tokens[i], tokens[j]);
        if (score >= DUPLICATE_THRESHOLD) {
          findings.push({
            id: `goal-lint:duplicate-title:${i}-${j}`,
            kind: 'duplicate-title',
            severity: 'warn',
            file: GOALS_FILE,
            line: goalLine(lines, active[i].text),
            message: `"${active[i].text}" and "${active[j].text}" look like the same goal (similarity ${score.toFixed(2)})`,
            fixable: false,
            data: { indices: [i, j], titles: [active[i].text, active[j].text] },
          });
        }
      }
    }

    return findings;
  },

  apply(ctx: HygieneContext, findings: HygieneFinding[]): HygieneApplyResult {
    const result: HygieneApplyResult = { applied: [], skipped: [], backups: [] };
    if (!ctx.soulDir) return result;
    const path = join(ctx.soulDir, GOALS_FILE);
    if (!existsSync(path)) {
      for (const f of findings)
        result.skipped.push({ findingId: f.id, reason: 'GOALS.md missing' });
      return result;
    }
    assertWithinRoots(path, ctx.allowedRoots);

    const { active, completed } = parseGoals(readFileSync(path, 'utf-8'));
    const today = localDate(ctx.now);
    const toMove = new Set<number>();
    const memoryAppends: string[] = [];
    let dirty = false;

    for (const f of findings) {
      if (!f.fixable) {
        result.skipped.push({
          findingId: f.id,
          reason: f.kind === 'duplicate-title' ? 'manual review required' : 'not fixable',
        });
        continue;
      }
      const index = Number(f.data?.index);
      const goal: GoalEntry | undefined = active[index];
      if (!goal || goal.text !== f.data?.title) {
        result.skipped.push({ findingId: f.id, reason: 'goal changed since preview' });
        continue;
      }

      if (f.kind === 'archived-in-active') {
        toMove.add(index);
        result.applied.push({
          findingId: f.id,
          action: 'move-to-completed',
          result: `"${goal.text}" moved to Completed`,
        });
        dirty = true;
      } else if (f.kind === 'oversized-notes') {
        if (!goal.notes || goal.notes.length <= NOTES_LIMIT) {
          result.skipped.push({ findingId: f.id, reason: 'notes already within limit' });
          continue;
        }
        memoryAppends.push(
          `- [${localTime(ctx.now)}] [goal-lint] Trimmed notes of goal: ${goal.text}\n  ${goal.notes}`
        );
        goal.notes = trimmedNotes(goal.notes, today);
        result.applied.push({
          findingId: f.id,
          action: 'trim-notes',
          result: `Notes of "${goal.text}" trimmed to ${NOTES_KEEP} chars`,
        });
        dirty = true;
      } else {
        result.skipped.push({ findingId: f.id, reason: `unknown fix for ${f.kind}` });
      }
    }

    if (!dirty) return result;

    const nextActive: GoalEntry[] = [];
    const nextCompleted = [...completed];
    active.forEach((goal, index) => {
      if (toMove.has(index)) {
        nextCompleted.push({
          ...goal,
          status: 'completed',
          completed: today,
          outcome: `moved by goal-lint (was status=${goal.status})`,
        });
      } else {
        nextActive.push(goal);
      }
    });

    const backup = backupFile(path, ctx.logger, ctx.now);
    if (backup) result.backups.push(backup);
    writeFileSync(path, serializeGoals(nextActive, nextCompleted), 'utf-8');

    if (memoryAppends.length > 0) {
      const memoryDir = join(ctx.soulDir, 'memory');
      mkdirSync(memoryDir, { recursive: true });
      const logPath = join(memoryDir, `${today}.md`);
      assertWithinRoots(logPath, ctx.allowedRoots);
      if (existsSync(logPath)) {
        const logBackup = backupFile(logPath, ctx.logger, ctx.now);
        if (logBackup) result.backups.push(logBackup);
      }
      appendFileSync(logPath, `${memoryAppends.join('\n')}\n`, 'utf-8');
    }

    return result;
  },
};
