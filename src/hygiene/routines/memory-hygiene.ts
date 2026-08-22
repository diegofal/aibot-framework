/**
 * memory-hygiene — PII, stale constraints and pending daily logs in
 * MEMORY.md and memory/*.md (memory/archive is left alone).
 *
 * src/redact-pii.ts only offers a whole-string scrubber for log lines, so the
 * line-level detector needed for findings (`detectPii`) lives here.
 */

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { assertWithinRoots, backupFile } from '../fs-safe';
import { daysBetween, localDate } from '../text-utils';
import type { HygieneApplyResult, HygieneContext, HygieneFinding, HygieneRoutine } from '../types';

export type PiiKind = 'email' | 'phone' | 'chat-id' | 'money' | 'custody';

export interface PiiHit {
  /** 1-based line number */
  line: number;
  kind: PiiKind;
  /** Matched text (for custody: the whole redactable part of the line) */
  excerpt: string;
  /** Column span of the match within the line */
  start: number;
  end: number;
}

// Word-bounded family keywords only. Earlier versions also listed age markers
// like "(7)" — unescaped they became regex groups matching any digit, which
// flagged half of every bot's memory as custody talk.
export const DEFAULT_CUSTODY_KEYWORDS = [
  'custodia',
  'custody',
  'hijos',
  'hija',
  'hijo',
  'kids',
  'children',
  'niños',
  'niñas',
];

/**
 * PII kinds that `apply` redacts by default. `money` is report-only: for the
 * business/economics bots amounts are the content, not a leak. Pass
 * `options.redactKinds` to change the set (e.g. add 'money', or drop 'custody'
 * to leave family context to the operator's judgement).
 */
export const DEFAULT_REDACT_KINDS: PiiKind[] = ['email', 'phone', 'chat-id', 'custody'];

const EMAIL_RE = /\b[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}\b/g;
const PHONE_RE = /\+\d[\d\s-]{7,14}\d\b/g;
// 7–12 digit run not glued to date/decimal/id punctuation (no 2026-08-21, no 1.234.567)
const CHAT_ID_RE = /(?<![\d.,/:+-])\d{7,12}(?![\d.,/:-])/g;
const MONEY_RE =
  /(?:(?:\$|€|£|US\$|U\$S|USD|EUR|ARS|MXN)\s?\d[\d.,]*|\b\d[\d.,]*\s?(?:USD|EUR|ARS|MXN|d[oó]lares|pesos|euros)\b)/gi;
const REDACTED_RE = /\[redacted:[a-z-]+\]/g;
// Non-global twin for `.test()` — a /g regex keeps lastIndex between calls.
const REDACTED_TEST_RE = /\[redacted:[a-z-]+\]/;
const LINE_PREFIX_RE = /^(\s*(?:[-*]\s+)?(?:\[\d{1,2}:\d{2}\]\s*)?)/;

const STALE_PHRASE_RE = /(no disponible|not available|unavailable|mcp pool empty|pool vac[ií]o)/i;
const TOOL_NAME_RE = /\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g;
const STALE_MARK = '[stale as of';
const PENDING_LOG_DAYS = 7;
const DATE_FILE_RE = /^(\d{4}-\d{2}-\d{2})\.md$/;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function keywordMatcher(keywords: string[]): RegExp | null {
  if (keywords.length === 0) return null;
  const parts = keywords.map((k) =>
    // Letter-bounded, and not a hyphenated compound ("Self-custody" is crypto talk).
    /^[\p{L}]+$/u.test(k) ? `(?<![\\p{L}-])${escapeRegExp(k)}(?![\\p{L}-])` : escapeRegExp(k)
  );
  return new RegExp(parts.join('|'), 'iu');
}

function overlaps(hits: PiiHit[], start: number, end: number): boolean {
  return hits.some((h) => start < h.end && end > h.start);
}

/** Line-level PII detector. Returns hits ordered by line then column. */
export function detectPii(text: string, opts: { keywords?: string[] } = {}): PiiHit[] {
  const custody = keywordMatcher(opts.keywords ?? DEFAULT_CUSTODY_KEYWORDS);
  const hits: PiiHit[] = [];
  const lines = text.split('\n');

  lines.forEach((line, i) => {
    const lineNo = i + 1;
    const lineHits: PiiHit[] = [];
    for (const m of line.matchAll(REDACTED_RE)) {
      lineHits.push({
        line: lineNo,
        kind: 'email',
        excerpt: m[0],
        start: m.index ?? 0,
        end: (m.index ?? 0) + m[0].length,
      });
    }
    const reservedCount = lineHits.length;

    const scan = (re: RegExp, kind: PiiKind) => {
      for (const m of line.matchAll(re)) {
        const start = m.index ?? 0;
        const end = start + m[0].length;
        if (overlaps(lineHits, start, end)) continue;
        lineHits.push({ line: lineNo, kind, excerpt: m[0], start, end });
      }
    };
    scan(EMAIL_RE, 'email');
    scan(PHONE_RE, 'phone');
    scan(MONEY_RE, 'money');
    scan(CHAT_ID_RE, 'chat-id');

    const real = lineHits.slice(reservedCount);
    if (custody?.test(line) && !REDACTED_TEST_RE.test(line)) {
      const prefix = line.match(LINE_PREFIX_RE)?.[1] ?? '';
      const start = prefix.length;
      const end = line.length;
      if (end > start) {
        // A custody line is redacted wholesale; drop finer-grained hits inside it.
        real.length = 0;
        real.push({ line: lineNo, kind: 'custody', excerpt: line.slice(start), start, end });
      }
    }
    real.sort((a, b) => a.start - b.start);
    hits.push(...real);
  });

  return hits;
}

interface MemoryFile {
  rel: string;
  abs: string;
}

function listMemoryFiles(soulDir: string): MemoryFile[] {
  const files: MemoryFile[] = [];
  const memoryMd = join(soulDir, 'MEMORY.md');
  if (existsSync(memoryMd)) files.push({ rel: 'MEMORY.md', abs: memoryMd });
  const memoryDir = join(soulDir, 'memory');
  if (existsSync(memoryDir)) {
    for (const name of readdirSync(memoryDir).sort()) {
      if (!name.endsWith('.md')) continue;
      const abs = join(memoryDir, name);
      try {
        if (statSync(abs).isFile()) files.push({ rel: `memory/${name}`, abs });
      } catch {
        /* skip */
      }
    }
  }
  return files;
}

function logAge(abs: string, name: string, now: Date): number {
  const m = name.match(DATE_FILE_RE);
  if (m) {
    const [y, mo, d] = m[1].split('-').map(Number);
    return daysBetween(new Date(y, mo - 1, d, 12), now);
  }
  try {
    return daysBetween(statSync(abs).mtime, now);
  } catch {
    return 0;
  }
}

export const memoryHygiene: HygieneRoutine = {
  id: 'memory-hygiene',
  name: 'Memory hygiene',
  description:
    'Finds PII (emails, phones, chat ids, money, custody talk) and stale tool constraints in MEMORY.md and daily logs, and counts logs waiting for consolidation.',
  scope: 'bot',
  canApply: true,

  preview(ctx: HygieneContext): HygieneFinding[] {
    const findings: HygieneFinding[] = [];
    if (!ctx.soulDir || !ctx.botId || !existsSync(ctx.soulDir)) return findings;
    const botId = ctx.botId;
    const keywords = Array.isArray(ctx.options.piiKeywords)
      ? (ctx.options.piiKeywords as string[])
      : DEFAULT_CUSTODY_KEYWORDS;
    const redactKinds = new Set<string>(
      Array.isArray(ctx.options.redactKinds)
        ? (ctx.options.redactKinds as string[])
        : DEFAULT_REDACT_KINDS
    );
    const today = localDate(ctx.now);

    for (const file of listMemoryFiles(ctx.soulDir)) {
      let content: string;
      try {
        content = readFileSync(file.abs, 'utf-8');
      } catch {
        continue;
      }
      const lines = content.split('\n');

      detectPii(content, { keywords }).forEach((hit, i) => {
        const fixable = redactKinds.has(hit.kind);
        findings.push({
          id: `memory-hygiene:pii:${file.rel}:${hit.line}:${i}`,
          kind: 'pii',
          severity: hit.kind === 'money' ? 'info' : 'critical',
          file: file.rel,
          line: hit.line,
          message: `${hit.kind} in ${file.rel}:${hit.line} — "${hit.excerpt.slice(0, 80)}"`,
          fixable,
          fix: fixable
            ? { action: 'redact', details: `Replace with [redacted:${hit.kind}]` }
            : undefined,
          data: {
            piiKind: hit.kind,
            start: hit.start,
            end: hit.end,
            lineText: lines[hit.line - 1],
          },
        });
      });

      lines.forEach((line, i) => {
        if (!STALE_PHRASE_RE.test(line) || line.includes(STALE_MARK)) return;
        const tools = [...line.matchAll(TOOL_NAME_RE)].map((m) => m[0]);
        if (tools.length === 0) return;
        const working = tools.filter((t) => ctx.deps.toolSucceededRecently(botId, t));
        const fixable = working.length > 0;
        findings.push({
          id: `memory-hygiene:stale-constraint:${file.rel}:${i + 1}`,
          kind: 'stale-constraint',
          severity: fixable ? 'warn' : 'info',
          file: file.rel,
          line: i + 1,
          message: fixable
            ? `Line says ${working.join(', ')} is unavailable but it succeeded recently`
            : `Line says ${tools.join(', ')} is unavailable — verify it still is`,
          fixable,
          fix: fixable
            ? {
                action: 'mark-stale',
                details: `Append " [stale as of ${today}: tool succeeded recently — memory-hygiene]"`,
              }
            : undefined,
          data: { tools, lineText: line },
        });
      });
    }

    const memoryDir = join(ctx.soulDir, 'memory');
    if (existsSync(memoryDir)) {
      const pending = readdirSync(memoryDir)
        .filter((n) => n.endsWith('.md'))
        .filter((n) => logAge(join(memoryDir, n), n, ctx.now) > PENDING_LOG_DAYS)
        .sort();
      if (pending.length > 0) {
        findings.push({
          id: 'memory-hygiene:daily-logs-pending',
          kind: 'daily-logs-pending',
          severity: 'info',
          file: 'memory/',
          line: null,
          message: `${pending.length} daily log(s) older than ${PENDING_LOG_DAYS} days are waiting for consolidation`,
          fixable: false,
          data: { files: pending },
        });
      }
    }

    return findings;
  },

  apply(ctx: HygieneContext, findings: HygieneFinding[]): HygieneApplyResult {
    const result: HygieneApplyResult = { applied: [], skipped: [], backups: [] };
    if (!ctx.soulDir) return result;
    const today = localDate(ctx.now);

    const byFile = new Map<string, HygieneFinding[]>();
    for (const f of findings) {
      if (!f.fixable || !f.file || f.line === null) {
        result.skipped.push({ findingId: f.id, reason: 'report only' });
        continue;
      }
      const list = byFile.get(f.file) ?? [];
      list.push(f);
      byFile.set(f.file, list);
    }

    for (const [rel, list] of byFile) {
      const abs = join(ctx.soulDir, rel);
      assertWithinRoots(abs, ctx.allowedRoots);
      if (!existsSync(abs)) {
        for (const f of list) result.skipped.push({ findingId: f.id, reason: 'file missing' });
        continue;
      }
      const lines = readFileSync(abs, 'utf-8').split('\n');
      let dirty = false;

      // Right-to-left per line so earlier spans stay valid.
      const ordered = [...list].sort(
        (a, b) =>
          (b.line ?? 0) - (a.line ?? 0) || Number(b.data?.start ?? 0) - Number(a.data?.start ?? 0)
      );
      const touched = new Map<number, string>();
      for (const f of ordered) {
        const idx = (f.line as number) - 1;
        const original = touched.get(idx) ?? lines[idx];
        if (original === undefined || f.data?.lineText !== original) {
          result.skipped.push({ findingId: f.id, reason: 'line changed since preview' });
          continue;
        }
        if (f.kind === 'pii') {
          const start = Number(f.data?.start);
          const end = Number(f.data?.end);
          lines[idx] =
            `${lines[idx].slice(0, start)}[redacted:${f.data?.piiKind}]${lines[idx].slice(end)}`;
          touched.set(idx, original);
          dirty = true;
          result.applied.push({
            findingId: f.id,
            action: 'redact',
            result: `${rel}:${f.line} ${f.data?.piiKind} redacted`,
          });
        } else if (f.kind === 'stale-constraint') {
          lines[idx] =
            `${lines[idx]} ${STALE_MARK} ${today}: tool succeeded recently — memory-hygiene]`;
          touched.set(idx, original);
          dirty = true;
          result.applied.push({
            findingId: f.id,
            action: 'mark-stale',
            result: `${rel}:${f.line} marked stale`,
          });
        } else {
          result.skipped.push({ findingId: f.id, reason: `unknown fix for ${f.kind}` });
        }
      }

      if (dirty) {
        const backup = backupFile(abs, ctx.logger, ctx.now);
        if (backup) result.backups.push(backup);
        writeFileSync(abs, lines.join('\n'), 'utf-8');
      }
    }

    return result;
  },
};
