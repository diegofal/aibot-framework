/**
 * On-disk persistence for the curiosity DNA, inside the bot's soul dir so it
 * travels with the bot export. JSON files are written atomically (tmp +
 * rename); dispatches are JSONL. Reads never throw: a missing or corrupt
 * file yields defaults.
 */
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { emptyKnowledgeMap } from './knowledge-map';
import type {
  DirectionRecord,
  Dispatch,
  KnowledgeMap,
  NavigatorState,
  TasteProfile,
} from './types';

/** DISPATCHES.jsonl keeps the newest this many entries (trimmed once it is 100 over). */
export const DISPATCH_KEEP = 500;

/** DIRECTIONS.jsonl keeps the newest this many navigator runs. */
export const DIRECTION_KEEP = 100;

export const CURIOSITY_FILES = {
  knowledge: 'KNOWLEDGE.json',
  navigator: 'NAVIGATOR.json',
  taste: 'TASTE.json',
  dispatches: 'DISPATCHES.jsonl',
  directions: 'DIRECTIONS.jsonl',
} as const;

export function emptyNavigatorState(): NavigatorState {
  return {
    version: 1,
    lastNavigatorAt: null,
    direction: null,
    directives: [],
    cycleLog: [],
    cyclesSinceExplore: 0,
    noSurpriseStreak: 0,
  };
}

export function emptyTasteProfile(baseIntervalHours = 12): TasteProfile {
  return {
    version: 1,
    topics: {},
    kinds: {},
    likedHooks: [],
    dislikedHooks: [],
    cadence: { intervalHours: baseIntervalHours, lastSentAt: null },
    updatedAt: null,
  };
}

export class CuriosityStore {
  constructor(readonly soulDir: string) {}

  private path(name: string): string {
    return join(this.soulDir, name);
  }

  private readJson<T extends object>(name: string, fallback: () => T): T {
    const p = this.path(name);
    if (!existsSync(p)) return fallback();
    try {
      const parsed = JSON.parse(readFileSync(p, 'utf-8'));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return fallback();
      return { ...fallback(), ...parsed } as T;
    } catch {
      return fallback();
    }
  }

  private writeJson(name: string, value: unknown): void {
    mkdirSync(this.soulDir, { recursive: true });
    const p = this.path(name);
    const tmp = `${p}.tmp-${process.pid}`;
    writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
    renameSync(tmp, p);
  }

  loadMap(): KnowledgeMap {
    return this.readJson(CURIOSITY_FILES.knowledge, emptyKnowledgeMap);
  }

  saveMap(map: KnowledgeMap): void {
    this.writeJson(CURIOSITY_FILES.knowledge, map);
  }

  loadNavigator(): NavigatorState {
    const nav = this.readJson(CURIOSITY_FILES.navigator, emptyNavigatorState);
    // Before 2026-10-16 operator chat lines were saved as instructions; read
    // them as what they are, context the conversation already answered.
    if (!nav.directives.some((d) => d.source === 'message' && d.status !== 'context')) return nav;
    return {
      ...nav,
      directives: nav.directives.map((d) =>
        d.source === 'message' && d.status !== 'context'
          ? { ...d, status: 'context' as const, servedAt: undefined }
          : d
      ),
    };
  }

  saveNavigator(state: NavigatorState): void {
    this.writeJson(CURIOSITY_FILES.navigator, state);
  }

  loadTaste(baseIntervalHours?: number): TasteProfile {
    return this.readJson(CURIOSITY_FILES.taste, () => emptyTasteProfile(baseIntervalHours));
  }

  saveTaste(taste: TasteProfile): void {
    this.writeJson(CURIOSITY_FILES.taste, taste);
  }

  private readDispatches(): Dispatch[] {
    const p = this.path(CURIOSITY_FILES.dispatches);
    if (!existsSync(p)) return [];
    const out: Dispatch[] = [];
    for (const line of readFileSync(p, 'utf-8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const d = JSON.parse(line);
        if (d && typeof d.id === 'string') out.push(d as Dispatch);
      } catch {
        // skip malformed line
      }
    }
    return out;
  }

  appendDispatch(d: Dispatch): void {
    mkdirSync(this.soulDir, { recursive: true });
    appendFileSync(this.path(CURIOSITY_FILES.dispatches), `${JSON.stringify(d)}\n`, 'utf-8');
    const all = this.readDispatches();
    if (all.length > DISPATCH_KEEP + 100) this.writeDispatches(all.slice(-DISPATCH_KEEP));
  }

  private writeDispatches(all: Dispatch[]): void {
    mkdirSync(this.soulDir, { recursive: true });
    const p = this.path(CURIOSITY_FILES.dispatches);
    const tmp = `${p}.tmp-${process.pid}`;
    writeFileSync(tmp, `${all.map((x) => JSON.stringify(x)).join('\n')}\n`, 'utf-8');
    renameSync(tmp, p);
  }

  /** Newest first. */
  listDispatches(limit?: number): Dispatch[] {
    const all = this.readDispatches().reverse();
    return limit === undefined ? all : all.slice(0, limit);
  }

  getDispatch(id: string): Dispatch | null {
    return this.readDispatches().find((d) => d.id === id) ?? null;
  }

  updateDispatch(id: string, patch: Partial<Dispatch>): Dispatch | null {
    const all = this.readDispatches();
    const idx = all.findIndex((d) => d.id === id);
    if (idx === -1) return null;
    all[idx] = { ...all[idx], ...patch, id };
    this.writeDispatches(all);
    return all[idx];
  }

  private readDirections(): DirectionRecord[] {
    const p = this.path(CURIOSITY_FILES.directions);
    if (!existsSync(p)) return [];
    const out: DirectionRecord[] = [];
    for (const line of readFileSync(p, 'utf-8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const d = JSON.parse(line);
        if (d && typeof d.runId === 'string' && typeof d.at === 'string') {
          out.push(d as DirectionRecord);
        }
      } catch {
        // skip malformed line
      }
    }
    return out;
  }

  /** One row per navigator run that landed; trimmed to the newest DIRECTION_KEEP. */
  appendDirection(record: DirectionRecord): void {
    mkdirSync(this.soulDir, { recursive: true });
    const p = this.path(CURIOSITY_FILES.directions);
    appendFileSync(p, `${JSON.stringify(record)}\n`, 'utf-8');
    const all = this.readDirections();
    if (all.length > DIRECTION_KEEP) {
      const tmp = `${p}.tmp-${process.pid}`;
      const keep = all.slice(-DIRECTION_KEEP);
      writeFileSync(tmp, `${keep.map((x) => JSON.stringify(x)).join('\n')}\n`, 'utf-8');
      renameSync(tmp, p);
    }
  }

  /** Newest first. */
  listDirections(limit?: number): DirectionRecord[] {
    const all = this.readDirections().reverse();
    return limit === undefined ? all : all.slice(0, limit);
  }
}
