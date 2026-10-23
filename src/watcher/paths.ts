/** Where the watcher keeps its state: `<paths.data>/watcher/`. */
import { join } from 'node:path';
import type { Config } from '../config';

export function watcherDir(config: Pick<Config, 'paths'>): string {
  const data = (config.paths as { data?: string } | undefined)?.data ?? './data';
  return join(data, 'watcher');
}

export function watcherLogDir(dir: string): string {
  return join(dir, 'log');
}

export interface GraphFiles {
  neurons: string;
  edges: string;
  embeddings: string;
  graph: string;
}

export function graphFiles(dir: string): GraphFiles {
  return {
    neurons: join(dir, 'neurons.jsonl'),
    edges: join(dir, 'edges.jsonl'),
    embeddings: join(dir, 'embeddings.jsonl'),
    graph: join(dir, 'graph.json'),
  };
}

export function birthFile(dir: string): string {
  return join(dir, 'birth.json');
}

export function bufferFile(dir: string): string {
  return join(dir, 'buffer.json');
}
