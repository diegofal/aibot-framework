import fs from 'node:fs/promises';
import path from 'node:path';

export type CronRunLogEntry = {
  ts: number;
  jobId: string;
  action: 'finished';
  status?: 'ok' | 'error' | 'skipped';
  error?: string;
  output?: string;
  runAtMs?: number;
  durationMs?: number;
  nextRunAtMs?: number;
};

export function resolveCronRunLogPath(params: { storePath: string; jobId: string }) {
  const dir = path.dirname(path.resolve(params.storePath));
  return path.join(dir, 'runs', `${params.jobId}.jsonl`);
}

const writesByPath = new Map<string, Promise<void>>();

async function pruneIfNeeded(filePath: string, opts: { maxBytes: number; keepLines: number }) {
  const stat = await fs.stat(filePath).catch(() => null);
  if (!stat || stat.size <= opts.maxBytes) {
    return;
  }

  const raw = await fs.readFile(filePath, 'utf-8').catch(() => '');
  const lines = raw
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const kept = lines.slice(Math.max(0, lines.length - opts.keepLines));
  const tmp = `${filePath}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
  await fs.writeFile(tmp, `${kept.join('\n')}\n`, 'utf-8');
  await fs.rename(tmp, filePath);
}

export async function appendCronRunLog(
  filePath: string,
  entry: CronRunLogEntry,
  opts?: { maxBytes?: number; keepLines?: number }
) {
  const resolved = path.resolve(filePath);
  const prev = writesByPath.get(resolved) ?? Promise.resolve();
  const next = prev
    .catch(() => undefined)
    .then(async () => {
      await fs.mkdir(path.dirname(resolved), { recursive: true });
      await fs.appendFile(resolved, `${JSON.stringify(entry)}\n`, 'utf-8');
      await pruneIfNeeded(resolved, {
        maxBytes: opts?.maxBytes ?? 2_000_000,
        keepLines: opts?.keepLines ?? 2_000,
      });
    });
  writesByPath.set(resolved, next);
  await next;
}

export async function clearCronRunLog(filePath: string): Promise<void> {
  const resolved = path.resolve(filePath);
  const prev = writesByPath.get(resolved) ?? Promise.resolve();
  const next = prev
    .catch(() => undefined)
    .then(async () => {
      await fs.writeFile(resolved, '', 'utf-8');
    });
  writesByPath.set(resolved, next);
  await next;
}

export async function deleteCronRunLogEntries(
  filePath: string,
  timestamps: number[]
): Promise<number> {
  const resolved = path.resolve(filePath);
  const toDelete = new Set(timestamps);
  const prev = writesByPath.get(resolved) ?? Promise.resolve();
  let deleted = 0;
  const next = prev
    .catch(() => undefined)
    .then(async () => {
      const raw = await fs.readFile(resolved, 'utf-8').catch(() => '');
      const lines = raw.split('\n');
      const kept: string[] = [];
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const obj = JSON.parse(trimmed);
          if (obj && typeof obj.ts === 'number' && toDelete.has(obj.ts)) {
            deleted++;
            continue;
          }
        } catch {
          // keep unparseable lines
        }
        kept.push(trimmed);
      }
      const tmp = `${resolved}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
      await fs.writeFile(tmp, kept.length > 0 ? `${kept.join('\n')}\n` : '', 'utf-8');
      await fs.rename(tmp, resolved);
    });
  writesByPath.set(resolved, next);
  await next;
  return deleted;
}

export async function readCronRunLogEntries(
  filePath: string,
  opts?: { limit?: number; jobId?: string }
): Promise<CronRunLogEntry[]> {
  const limit = Math.max(1, Math.min(5000, Math.floor(opts?.limit ?? 200)));
  const jobId = opts?.jobId?.trim() || undefined;
  const raw = await fs.readFile(path.resolve(filePath), 'utf-8').catch(() => '');
  if (!raw.trim()) {
    return [];
  }
  const parsed: CronRunLogEntry[] = [];
  const lines = raw.split('\n');
  for (let i = lines.length - 1; i >= 0 && parsed.length < limit; i--) {
    const line = lines[i]?.trim();
    if (!line) {
      continue;
    }
    try {
      const obj = JSON.parse(line) as Partial<CronRunLogEntry> | null;
      if (!obj || typeof obj !== 'object') {
        continue;
      }
      if (obj.action !== 'finished') {
        continue;
      }
      if (typeof obj.jobId !== 'string' || obj.jobId.trim().length === 0) {
        continue;
      }
      if (typeof obj.ts !== 'number' || !Number.isFinite(obj.ts)) {
        continue;
      }
      if (jobId && obj.jobId !== jobId) {
        continue;
      }
      parsed.push({
        ts: obj.ts,
        jobId: obj.jobId,
        action: 'finished',
        status: obj.status,
        error: obj.error,
        output: (obj as Record<string, unknown>).output as string | undefined,
        runAtMs: obj.runAtMs,
        durationMs: obj.durationMs,
        nextRunAtMs: obj.nextRunAtMs,
      });
    } catch {
      // ignore invalid lines
    }
  }
  return parsed.toReversed();
}
