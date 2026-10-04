/**
 * Curiosity state in a bot's soul dir: KNOWLEDGE.json, NAVIGATOR.json,
 * TASTE.json and DISPATCHES.jsonl. Read-only (unlike `CuriosityStore`, never
 * creates the dir); a missing or unparseable file reads as null / empty.
 */
import { join } from 'node:path';
import type {
  Dispatch,
  KnowledgeMap,
  NavigatorState,
  TasteProfile,
} from '../../bot/curiosity/types';
import { readJsonSafe, readJsonlSafe } from '../util';

export interface CuriosityState {
  knowledge: KnowledgeMap | null;
  navigator: NavigatorState | null;
  taste: TasteProfile | null;
  dispatches: Dispatch[];
}

export function readCuriosityState(soulDir: string): CuriosityState {
  return {
    knowledge: readJsonSafe<KnowledgeMap>(join(soulDir, 'KNOWLEDGE.json')),
    navigator: readJsonSafe<NavigatorState>(join(soulDir, 'NAVIGATOR.json')),
    taste: readJsonSafe<TasteProfile>(join(soulDir, 'TASTE.json')),
    dispatches: readJsonlSafe<Dispatch>(join(soulDir, 'DISPATCHES.jsonl')).filter(
      (d) => d && typeof d === 'object' && typeof d.id === 'string'
    ),
  };
}
