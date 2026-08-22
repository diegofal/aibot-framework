/**
 * soul-structure — structural health of a soul directory.
 *
 * Wraps `lintSoulDirectory` (src/bot/soul-lint.ts) and adds a few checks
 * that need context (dates, health-check history, cross-file similarity).
 * Report-only except for creating an empty MEMORY.md when it is missing.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { lintSoulDirectory } from '../../bot/soul-lint';
import { assertWithinRoots } from '../fs-safe';
import { daysBetween, extractDates, localDate, textSimilarity } from '../text-utils';
import type { HygieneApplyResult, HygieneContext, HygieneFinding, HygieneRoutine } from '../types';

const SIMILARITY_THRESHOLD = 0.9;
const STALE_FOCUS_DAYS = 14;
const FOCUS_HEADINGS = /current focus|foco actual|last reflection|[uú]ltima reflexi[oó]n/i;
const FOCUS_LOOKAHEAD_LINES = 6;

const MEMORY_HEADER = '# Memory\n\nLong-term facts consolidated from daily logs.\n';

function readIfExists(path: string): string | null {
  try {
    return existsSync(path) ? readFileSync(path, 'utf-8') : null;
  } catch {
    return null;
  }
}

/** Drop markdown headings and HTML comments so only the prose is compared. */
function stripStructure(content: string): string {
  return content
    .replace(/<!--[\s\S]*?-->/g, '')
    .split('\n')
    .filter((line) => !/^\s*#{1,6}\s/.test(line))
    .join('\n');
}

/** Find a "Current Focus"/"Last Reflection" heading and the nearest date after it. */
function findFocusDate(content: string, now: Date): { date: Date; line: number } | null {
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (!FOCUS_HEADINGS.test(lines[i])) continue;
    const window = lines.slice(i, i + FOCUS_LOOKAHEAD_LINES);
    for (let k = 0; k < window.length; k++) {
      const dates = extractDates(window[k], now);
      if (dates.length > 0) return { date: dates[0], line: i + k + 1 };
    }
  }
  return null;
}

export const soulStructure: HygieneRoutine = {
  id: 'soul-structure',
  name: 'Soul structure',
  description:
    'Runs the soul linter and checks for SOUL/MOTIVATIONS duplication, missing MEMORY.md or TRAITS.json, a stale Current Focus and a failed last review.',
  scope: 'bot',
  canApply: true,

  preview(ctx: HygieneContext): HygieneFinding[] {
    const findings: HygieneFinding[] = [];
    if (!ctx.soulDir || !ctx.botId) return findings;
    const soulDir = ctx.soulDir;

    if (!existsSync(soulDir)) {
      return [
        {
          id: 'soul-structure:missing-soul-dir',
          kind: 'missing-soul-dir',
          severity: 'critical',
          file: null,
          line: null,
          message: `Soul directory does not exist: ${soulDir}`,
          fixable: false,
        },
      ];
    }

    lintSoulDirectory(soulDir).forEach((issue, i) => {
      findings.push({
        id: `soul-structure:soul-lint:${i}`,
        kind: 'soul-lint',
        severity: issue.severity === 'error' ? 'critical' : 'warn',
        file: issue.file,
        line: null,
        message: issue.message,
        fixable: false,
      });
    });

    const soul = readIfExists(join(soulDir, 'SOUL.md'));
    const motivations = readIfExists(join(soulDir, 'MOTIVATIONS.md'));
    if (soul && motivations) {
      const score = textSimilarity(stripStructure(soul), stripStructure(motivations));
      if (score >= SIMILARITY_THRESHOLD) {
        findings.push({
          id: 'soul-structure:soul-equals-motivations',
          kind: 'soul-equals-motivations',
          severity: 'warn',
          file: 'SOUL.md',
          line: null,
          message: `SOUL.md and MOTIVATIONS.md are ${(score * 100).toFixed(0)}% identical — one of them was probably copied over the other`,
          fixable: false,
        });
      }
    }

    if (!existsSync(join(soulDir, 'MEMORY.md'))) {
      findings.push({
        id: 'soul-structure:missing-memory-md',
        kind: 'missing-memory-md',
        severity: 'warn',
        file: 'MEMORY.md',
        line: null,
        message: 'MEMORY.md is missing — consolidation has nowhere to write',
        fixable: true,
        fix: { action: 'create-memory-md', details: 'Create MEMORY.md with a header' },
      });
    }

    // TraitRegisters persists `<botDir>/TRAITS.json` next to `soul/`; accept
    // either that or the legacy in-soul location.
    if (
      !existsSync(join(soulDir, 'TRAITS.json')) &&
      !existsSync(join(soulDir, '..', 'TRAITS.json'))
    ) {
      findings.push({
        id: 'soul-structure:missing-traits',
        kind: 'missing-traits',
        severity: 'info',
        file: 'TRAITS.json',
        line: null,
        message: 'TRAITS.json is missing — trait registers have never been initialised',
        fixable: false,
      });
    }

    if (motivations) {
      const focus = findFocusDate(motivations, ctx.now);
      if (focus && daysBetween(focus.date, ctx.now) > STALE_FOCUS_DAYS) {
        findings.push({
          id: 'soul-structure:stale-current-focus',
          kind: 'stale-current-focus',
          severity: 'warn',
          file: 'MOTIVATIONS.md',
          line: focus.line,
          message: `Current Focus / Last Reflection dated ${localDate(focus.date)} (${daysBetween(focus.date, ctx.now)} days ago)`,
          fixable: false,
        });
      }
    }

    const lastCheck = ctx.deps.lastHealthCheckOf(ctx.botId);
    if (lastCheck && !lastCheck.ok) {
      findings.push({
        id: 'soul-structure:last-review-failed',
        kind: 'last-review-failed',
        severity: 'warn',
        file: null,
        line: null,
        message: `Last soul health check (${lastCheck.at}) failed${lastCheck.error ? `: ${lastCheck.error}` : ''}`,
        fixable: false,
      });
    }

    return findings;
  },

  apply(ctx: HygieneContext, findings: HygieneFinding[]): HygieneApplyResult {
    const result: HygieneApplyResult = { applied: [], skipped: [], backups: [] };
    for (const f of findings) {
      if (f.kind !== 'missing-memory-md' || !ctx.soulDir || !existsSync(ctx.soulDir)) {
        result.skipped.push({ findingId: f.id, reason: 'report only' });
        continue;
      }
      const path = join(ctx.soulDir, 'MEMORY.md');
      if (existsSync(path)) {
        result.skipped.push({ findingId: f.id, reason: 'MEMORY.md already exists' });
        continue;
      }
      assertWithinRoots(path, ctx.allowedRoots);
      writeFileSync(path, MEMORY_HEADER, 'utf-8');
      result.applied.push({
        findingId: f.id,
        action: 'create-memory-md',
        result: 'MEMORY.md created',
      });
    }
    return result;
  },
};
