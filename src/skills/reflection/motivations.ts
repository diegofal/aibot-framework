/**
 * Guards for the reflection skill.
 *
 * Purpose is the operator's: the `## Core Drives` section of MOTIVATIONS.md is
 * kept verbatim whatever reflection proposes (unless it is still a placeholder
 * on a new bot). Reflection evolves the methods around it, and it learns from
 * what the operator actually said about the bot's output.
 */
import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';

const CORE_DRIVES = /^## Core Drives[^\n]*\n[\s\S]*?(?=^## |(?![\s\S]))/m;
const PLACEHOLDER = /\(pending|\(will be generated/i;

/** `proposed` with the current Core Drives section restored verbatim. */
export function protectCoreDrives(current: string, proposed: string): string {
  const drives = current.replace(/\r\n/g, '\n').match(CORE_DRIVES)?.[0];
  if (!drives || PLACEHOLDER.test(drives)) return proposed;
  const section = drives.endsWith('\n\n') ? drives : `${drives.replace(/\n*$/, '')}\n\n`;
  if (CORE_DRIVES.test(proposed)) {
    return proposed.replace(CORE_DRIVES, (m) =>
      m.endsWith('\n\n') ? section : section.replace(/\n$/, '')
    );
  }
  return `${section}${proposed}`;
}

interface FeedbackLine {
  at: number;
  order: number;
  text: string;
}

function readJsonl(path: string): Record<string, unknown>[] {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch {
    return [];
  }
  const out: Record<string, unknown>[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const v = JSON.parse(line);
      if (v && typeof v === 'object') out.push(v as Record<string, unknown>);
    } catch {
      // malformed line: skip
    }
  }
  return out;
}

const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const SIGNAL_LABEL: Record<string, string> = { up: '👍', down: '👎', more: 'asked for more' };

/**
 * The operator's verdicts on recent output: production evaluations (status,
 * rating, feedback) and dispatch signals, newest first, within `windowDays`.
 */
export function readOperatorFeedback(opts: {
  workDir?: string;
  soulDir?: string;
  nowMs?: number;
  windowDays?: number;
  maxChars?: number;
}): string {
  const now = opts.nowMs ?? Date.now();
  const windowDays = opts.windowDays ?? 14;
  const since = now - windowDays * 86_400_000;
  const maxChars = opts.maxChars ?? 1500;
  const lines: FeedbackLine[] = [];
  let order = 0;

  if (opts.workDir) {
    for (const e of readJsonl(join(opts.workDir, 'changelog.jsonl'))) {
      const ev = e.evaluation as
        | { status?: string; rating?: number; feedback?: string; evaluatedAt?: string }
        | undefined;
      const at = Date.parse(ev?.evaluatedAt ?? '');
      if (!ev?.status || !Number.isFinite(at) || at < since) continue;
      const rating = typeof ev.rating === 'number' ? `, rated ${ev.rating}/5` : '';
      const feedback = ev.feedback ? ` — "${String(ev.feedback).slice(0, 200)}"` : '';
      lines.push({
        at,
        order: order++,
        text: `- [${day(at)}] output ${basename(String(e.path ?? '?'))}: ${ev.status}${rating}${feedback}`,
      });
    }
  }

  if (opts.soulDir) {
    for (const d of readJsonl(join(opts.soulDir, 'DISPATCHES.jsonl'))) {
      const at = Date.parse(String(d.signalAt ?? ''));
      const signal = SIGNAL_LABEL[String(d.signal ?? '')];
      if (!signal || !Number.isFinite(at) || at < since) continue;
      lines.push({
        at,
        order: order++,
        text: `- [${day(at)}] dispatch "${String(d.hook ?? '').slice(0, 100)}": ${signal}`,
      });
    }
  }

  if (lines.length === 0) return `No operator feedback in the last ${windowDays} days.`;
  lines.sort((a, b) => b.at - a.at || b.order - a.order);
  const kept: string[] = [];
  let used = 0;
  for (const l of lines) {
    const cost = l.text.length + (kept.length ? 1 : 0);
    if (used + cost > maxChars) break;
    kept.push(l.text);
    used += cost;
  }
  return kept.join('\n');
}
