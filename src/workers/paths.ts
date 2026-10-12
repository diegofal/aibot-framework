import { join } from 'node:path';

/** `<dataDir>/workers/<botId>` — runs.json, one journal per run, daily ended logs. */
export function workersDir(dataDir: string, botId: string): string {
  return join(dataDir, 'workers', botId);
}

export function runJournalPath(dataDir: string, botId: string, runId: string): string {
  return join(workersDir(dataDir, botId), `${runId}.jsonl`);
}

/** A task's own working directory inside the bot's productions dir (C11): parallel runs never share one. */
export function taskWorkDir(botProductionsDir: string, taskId: string): string {
  return join(botProductionsDir, 'tasks', taskId);
}
