/**
 * The working buffer: what the fleet is attending to right now. Tier 0 pushes
 * scored events; later tiers drain what they consumed. Persisted on stop so a
 * restart keeps it. Never throws on disk errors.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { BufferItem } from './types';

export class WorkingBuffer {
  private buf: BufferItem[] = [];

  constructor(private readonly max = 200) {}

  push(item: BufferItem): void {
    this.buf.push(item);
    if (this.buf.length > this.max) this.buf.splice(0, this.buf.length - this.max);
  }

  items(): BufferItem[] {
    return [...this.buf];
  }

  size(): number {
    return this.buf.length;
  }

  salient(bar: number): BufferItem[] {
    return this.buf.filter((i) => i.salience >= bar);
  }

  total(): number {
    return this.buf.reduce((s, i) => s + i.salience, 0);
  }

  drain(ids: string[]): BufferItem[] {
    const wanted = new Set(ids);
    const out = this.buf.filter((i) => wanted.has(i.id));
    this.buf = this.buf.filter((i) => !wanted.has(i.id));
    return out;
  }

  persist(path: string): void {
    try {
      mkdirSync(dirname(path), { recursive: true });
      const tmp = `${path}.tmp-${process.pid}`;
      writeFileSync(tmp, JSON.stringify({ version: 1, items: this.buf }), 'utf-8');
      renameSync(tmp, path);
    } catch {
      // a lost buffer is a cold start, not a failure
    }
  }

  restore(path: string): void {
    try {
      if (!existsSync(path)) return;
      const parsed = JSON.parse(readFileSync(path, 'utf-8')) as { items?: BufferItem[] };
      const items = Array.isArray(parsed.items)
        ? parsed.items.filter((i) => i && typeof i.id === 'string')
        : [];
      this.buf = items.slice(-this.max);
    } catch {
      // corrupt file: start empty
    }
  }
}
