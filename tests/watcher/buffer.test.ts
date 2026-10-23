import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkingBuffer } from '../../src/watcher/buffer';
import type { BufferItem } from '../../src/watcher/types';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'watcher-buf-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const item = (id: string, salience: number): BufferItem => ({
  id,
  event: { type: 'tool:error', botId: 'b1', timestamp: 0 },
  salience,
  reasons: ['error'],
  noticedAt: '2026-10-23T10:00:00.000Z',
  touched: [],
});

describe('WorkingBuffer', () => {
  test('push keeps items in arrival order', () => {
    const b = new WorkingBuffer();
    b.push(item('a', 0.1));
    b.push(item('b', 0.5));
    expect(b.items().map((i) => i.id)).toEqual(['a', 'b']);
    expect(b.size()).toBe(2);
  });

  test('the cap drops the oldest item', () => {
    const b = new WorkingBuffer(2);
    b.push(item('a', 0.9));
    b.push(item('b', 0.1));
    b.push(item('c', 0.1));
    expect(b.items().map((i) => i.id)).toEqual(['b', 'c']);
  });

  test('salient returns items at or above the bar', () => {
    const b = new WorkingBuffer();
    b.push(item('a', 0.1));
    b.push(item('b', 0.4));
    b.push(item('c', 0.7));
    expect(b.salient(0.4).map((i) => i.id)).toEqual(['b', 'c']);
  });

  test('total sums salience', () => {
    const b = new WorkingBuffer();
    b.push(item('a', 0.25));
    b.push(item('b', 0.5));
    expect(b.total()).toBeCloseTo(0.75);
  });

  test('drain removes and returns the named items', () => {
    const b = new WorkingBuffer();
    b.push(item('a', 0.1));
    b.push(item('b', 0.2));
    b.push(item('c', 0.3));
    expect(b.drain(['a', 'c', 'zz']).map((i) => i.id)).toEqual(['a', 'c']);
    expect(b.items().map((i) => i.id)).toEqual(['b']);
  });

  test('persist then restore keeps the items', () => {
    const path = join(dir, 'sub', 'buffer.json');
    const b = new WorkingBuffer();
    b.push(item('a', 0.1));
    b.persist(path);
    const restored = new WorkingBuffer();
    restored.restore(path);
    expect(restored.items()).toEqual(b.items());
  });

  test('restore of a missing or corrupt file leaves the buffer empty', () => {
    const b = new WorkingBuffer();
    b.restore(join(dir, 'missing.json'));
    expect(b.size()).toBe(0);
    writeFileSync(join(dir, 'bad.json'), '{nope');
    b.restore(join(dir, 'bad.json'));
    expect(b.size()).toBe(0);
  });

  test('restore honours the cap', () => {
    const path = join(dir, 'buffer.json');
    const big = new WorkingBuffer(10);
    for (let i = 0; i < 5; i++) big.push(item(`i${i}`, 0.1));
    big.persist(path);
    const small = new WorkingBuffer(2);
    small.restore(path);
    expect(small.items().map((i) => i.id)).toEqual(['i3', 'i4']);
  });

  test('persist to an unwritable path never throws', () => {
    writeFileSync(join(dir, 'file'), 'x');
    expect(() => new WorkingBuffer().persist(join(dir, 'file', 'buffer.json'))).not.toThrow();
  });
});
