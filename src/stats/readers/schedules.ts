import { join } from 'node:path';
import type { BotSchedule } from '../../bot/agent-scheduler';
import { readJsonSafe } from '../util';

/** What `agent-scheduler/schedules.json` holds per bot (lastResult is not persisted). */
export type PersistedSchedule = Partial<Omit<BotSchedule, 'lastResult'>>;

export function readSchedules(schedulerDir: string): Record<string, PersistedSchedule> {
  const raw = readJsonSafe<unknown>(join(schedulerDir, 'schedules.json'));
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, PersistedSchedule> = {};
  for (const [botId, value] of Object.entries(raw as Record<string, unknown>)) {
    if (value && typeof value === 'object') out[botId] = value as PersistedSchedule;
  }
  return out;
}
