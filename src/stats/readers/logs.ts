/**
 * Tail-scan of the pino JSON log (`logs/aibot.log`) for operational signals
 * that are not persisted anywhere else: agent-loop cycle completions,
 * alignment warnings, tool-loop breaks, Telegram start failures, security
 * audit summaries, boots, collaboration send failures, backend 429/401s and
 * the noisiest message templates.
 *
 * Only the last `maxBytes` of the file are read (the file is 10+ MB in
 * production) and only records newer than `sinceMs` are counted.
 */
import { readdirSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { parseJsonlText, statSizeSafe, tailText, toIso } from '../util';

/**
 * The configured log path plus its rotated siblings (`aibot.log.1`, `.2`, …),
 * newest first by mtime. pino-roll writes to the numbered files, so the bare
 * `aibot.log` may be a stale pre-rotation file — mtime, not the name, decides
 * which file is current.
 */
export function selectLogFiles(logPath: string): string[] {
  const dir = dirname(logPath);
  const base = basename(logPath);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter((n) => n === base || n.startsWith(`${base}.`))
    .map((n) => {
      const p = join(dir, n);
      let mtime = 0;
      try {
        mtime = statSync(p).mtimeMs;
      } catch {
        /* vanished between readdir and stat */
      }
      return { p, mtime };
    })
    .sort((a, b) => b.mtime - a.mtime)
    .map((x) => x.p);
}

/**
 * Last `maxBytes` of log text across the rotated set: newest file first, then
 * older files with whatever budget remains, stitched oldest→newest so the
 * records come out in chronological order.
 */
export function readLogTail(logPath: string, maxBytes: number): string {
  let budget = maxBytes;
  const chunks: string[] = [];
  for (const file of selectLogFiles(logPath)) {
    if (budget <= 0) break;
    const text = tailText(file, budget);
    if (!text) continue;
    chunks.unshift(text);
    budget -= Buffer.byteLength(text, 'utf-8');
  }
  return chunks.join('\n');
}

export interface CycleSignals {
  total: number;
  idle: number;
  durationSumMs: number;
  alignmentWarnings: number;
  loopBreaks: number;
  /** Epoch ms of the most recent completed cycle seen in the log window. */
  lastAt: number | null;
}

export interface BackendSignals {
  last429At: string | null;
  last401At: string | null;
  lastErrorMessage: string | null;
  failedCalls: number;
}

export interface LogSignals {
  scannedLines: number;
  cyclesByBot: Record<string, CycleSignals>;
  telegramByBot: Record<string, { lastError: string; at: string; revoked: boolean }>;
  securityAudit: Array<{ botId: string; critical: number; warn: number; info: number; at: string }>;
  boots: string[];
  fallbacks: number;
  collaborateFailed: Array<{ from: string; to: string }>;
  backends: Record<string, BackendSignals>;
  logNoise: Array<{ msg: string; level: number; count: number }>;
}

export interface ScanLogOptions {
  maxBytes: number;
  sinceMs: number;
  nowMs: number;
  topTemplates?: number;
  maxBoots?: number;
}

interface LogRecord {
  level?: number;
  time?: number;
  msg?: string;
  botId?: string;
  [key: string]: unknown;
}

export const DEFAULT_LOG_TAIL_BYTES = 8 * 1024 * 1024;

export function emptyLogSignals(): LogSignals {
  return {
    scannedLines: 0,
    cyclesByBot: {},
    telegramByBot: {},
    securityAudit: [],
    boots: [],
    fallbacks: 0,
    collaborateFailed: [],
    backends: {},
    logNoise: [],
  };
}

const UUID_OR_HEX = /\b[0-9a-f]{8}(?:-?[0-9a-f]{4}){0,3}-?[0-9a-f]{8,}\b/gi;

/** Collapse numbers (N) and ids/hashes (H) so repeated messages group together. */
export function normaliseLogTemplate(msg: string): string {
  return msg.replace(UUID_OR_HEX, 'H').replace(/\d+/g, 'N').trim().slice(0, 160);
}

function cycles(sig: LogSignals, botId: string): CycleSignals {
  const existing = sig.cyclesByBot[botId];
  if (existing) return existing;
  const fresh: CycleSignals = {
    total: 0,
    idle: 0,
    durationSumMs: 0,
    alignmentWarnings: 0,
    loopBreaks: 0,
    lastAt: null,
  };
  sig.cyclesByBot[botId] = fresh;
  return fresh;
}

function errorText(rec: LogRecord): string {
  const parts: string[] = [];
  if (typeof rec.msg === 'string') parts.push(rec.msg);
  const err = rec.err ?? rec.error;
  if (typeof err === 'string') parts.push(err);
  else if (err && typeof err === 'object') {
    const e = err as Record<string, unknown>;
    if (typeof e.message === 'string') parts.push(e.message);
    if (typeof e.code === 'string' || typeof e.code === 'number') parts.push(String(e.code));
  }
  return parts.join(' | ');
}

function backendOf(rec: LogRecord, text: string): string | null {
  if (typeof rec.backend === 'string') return rec.backend;
  if (/claude/i.test(text) || (typeof rec.model === 'string' && /claude/i.test(rec.model))) {
    return 'claude-cli';
  }
  if (/ollama|primary model failed|model/i.test(text) || typeof rec.model === 'string') {
    return 'ollama';
  }
  return null;
}

function backend(sig: LogSignals, name: string): BackendSignals {
  const existing = sig.backends[name];
  if (existing) return existing;
  const fresh: BackendSignals = {
    last429At: null,
    last401At: null,
    lastErrorMessage: null,
    failedCalls: 0,
  };
  sig.backends[name] = fresh;
  return fresh;
}

export function scanLogs(logPath: string, opts: ScanLogOptions): LogSignals {
  const sig = emptyLogSignals();
  const text = readLogTail(logPath, opts.maxBytes);
  if (!text) return sig;

  const templates = new Map<string, { msg: string; level: number; count: number }>();
  const latestAudit = new Map<string, LogSignals['securityAudit'][number]>();
  const boots: string[] = [];
  const maxBoots = opts.maxBoots ?? 20;

  for (const rec of parseJsonlText<LogRecord>(text)) {
    sig.scannedLines++;
    const time = typeof rec.time === 'number' ? rec.time : Number(rec.time);
    if (!Number.isFinite(time) || time < opts.sinceMs) continue;
    const msg = typeof rec.msg === 'string' ? rec.msg : '';
    const level = Number(rec.level) || 30;
    const at = toIso(time) ?? new Date(time).toISOString();
    const botId = typeof rec.botId === 'string' ? rec.botId : null;

    // Noise templates (everything, including info)
    const key = `${level}:${normaliseLogTemplate(msg)}`;
    const t = templates.get(key);
    if (t) t.count++;
    else templates.set(key, { msg: normaliseLogTemplate(msg), level, count: 1 });

    if (msg.startsWith('Starting AIBot Framework')) {
      boots.push(at);
      continue;
    }

    if (msg === 'Agent loop completed for bot' && botId) {
      const c = cycles(sig, botId);
      c.total++;
      if (rec.isIdle === true) c.idle++;
      c.durationSumMs += Number(rec.durationMs) || 0;
      const at = Number(rec.time) || 0;
      if (at && (c.lastAt === null || at > c.lastAt)) c.lastAt = at;
      continue;
    }
    if (msg.startsWith('Agent loop: post-execution alignment check found issues') && botId) {
      const warnings = Array.isArray(rec.warnings) ? rec.warnings.length : 1;
      cycles(sig, botId).alignmentWarnings += warnings;
      continue;
    }
    if (msg.startsWith('Tool loop detector: breaking')) {
      const id = botId ?? (typeof rec.sourceBotId === 'string' ? rec.sourceBotId : null);
      if (id) cycles(sig, id).loopBreaks++;
      continue;
    }
    if (msg.startsWith('Telegram start failed') && botId) {
      const detail = errorText(rec);
      sig.telegramByBot[botId] = {
        lastError: detail,
        at,
        revoked: /\b401\b|unauthorized|revoked/i.test(detail),
      };
      continue;
    }
    if (msg.startsWith('Security audit:') && botId) {
      const summary = (rec.summary ?? {}) as Record<string, unknown>;
      latestAudit.set(botId, {
        botId,
        critical: Number(summary.critical) || 0,
        warn: Number(summary.warn) || 0,
        info: Number(summary.info) || 0,
        at,
      });
      continue;
    }
    if (msg.endsWith('collaborate send failed')) {
      const from = typeof rec.sourceBotId === 'string' ? rec.sourceBotId : botId;
      const to = typeof rec.targetBotId === 'string' ? rec.targetBotId : null;
      if (from && to) sig.collaborateFailed.push({ from, to });
      continue;
    }
    if (msg.startsWith('Primary model failed')) sig.fallbacks++;

    if (level >= 40) {
      const detail = errorText(rec);
      const name = backendOf(rec, detail);
      if (
        name &&
        /\b(429|401)\b|too many requests|unauthorized|rate limit|invalid api key/i.test(detail)
      ) {
        const b = backend(sig, name);
        if (/\b429\b|too many requests|rate limit/i.test(detail)) b.last429At = at;
        if (/\b401\b|unauthorized|invalid api key/i.test(detail)) b.last401At = at;
        b.lastErrorMessage = detail.slice(0, 300);
        b.failedCalls++;
      } else if (name && msg.startsWith('Primary model failed')) {
        const b = backend(sig, name);
        b.lastErrorMessage = detail.slice(0, 300);
        b.failedCalls++;
      }
    }
  }

  sig.boots = boots.slice(-maxBoots);
  sig.securityAudit = [...latestAudit.values()].sort((a, b) => a.botId.localeCompare(b.botId));
  sig.logNoise = [...templates.values()]
    .sort((a, b) => b.count - a.count || a.msg.localeCompare(b.msg))
    .slice(0, opts.topTemplates ?? 15);
  return sig;
}

/** Total bytes across the active log file and its rotated siblings (`aibot.log.1`, …). */
export function totalLogBytes(logPath: string, siblings: string[]): number {
  let total = statSizeSafe(logPath);
  for (const s of siblings) total += statSizeSafe(s);
  return total;
}
