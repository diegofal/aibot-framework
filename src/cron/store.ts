import fs from 'node:fs/promises';
import path from 'node:path';
import type { CronStoreFile } from './types';

export async function loadCronStore(storePath: string): Promise<CronStoreFile> {
  try {
    const raw = await fs.readFile(storePath, 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    const parsedRecord =
      parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
    const jobs = Array.isArray(parsedRecord.jobs) ? parsedRecord.jobs : [];
    return {
      version: 1,
      jobs: jobs.filter(Boolean) as CronStoreFile['jobs'],
    };
  } catch (err) {
    if ((err as { code?: unknown })?.code === 'ENOENT') {
      return { version: 1, jobs: [] };
    }
    throw err;
  }
}

export async function saveCronStore(storePath: string, store: CronStoreFile) {
  await fs.mkdir(path.dirname(storePath), { recursive: true });
  const tmp = `${storePath}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
  const json = JSON.stringify(store, null, 2);
  await fs.writeFile(tmp, json, 'utf-8');
  await fs.rename(tmp, storePath);
  try {
    await fs.copyFile(storePath, `${storePath}.bak`);
  } catch {
    // best-effort
  }
}
