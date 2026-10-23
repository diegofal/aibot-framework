import { describe, expect, test } from 'bun:test';
import {
  normaliseToBall,
  pca3,
  placeWithoutEmbedding,
  shellPosition,
} from '../../src/watcher/layout';
import type { Vec3 } from '../../src/watcher/types';

const norm = (p: number[]) => Math.sqrt(p.reduce((s, x) => s + x * x, 0));

describe('pca3', () => {
  test('points on a line project onto the first axis only', () => {
    const vectors = [
      [1, 1, 0, 0],
      [2, 2, 0, 0],
      [3, 3, 0, 0],
      [4, 4, 0, 0],
    ];
    const pos = pca3(vectors);
    expect(pos).toHaveLength(4);
    const firsts = pos.map((p) => p[0]);
    // equally spaced along the line, centred on zero
    expect(Math.abs(firsts[0] + firsts[3])).toBeLessThan(1e-6);
    expect(Math.abs(firsts[1] - firsts[0] - (firsts[2] - firsts[1]))).toBeLessThan(1e-6);
    expect(Math.abs(Math.abs(firsts[3] - firsts[0]) - 3 * Math.SQRT2)).toBeLessThan(1e-6);
    for (const p of pos) {
      expect(Math.abs(p[1])).toBeLessThan(1e-6);
      expect(Math.abs(p[2])).toBeLessThan(1e-6);
    }
  });

  test('keeps the separation of two clusters on the first axis', () => {
    const vectors = [
      [10, 0, 0.1],
      [10.1, 0, 0],
      [-10, 0, 0],
      [-10, 0.1, 0],
    ];
    const pos = pca3(vectors);
    expect(Math.sign(pos[0][0])).toBe(Math.sign(pos[1][0]));
    expect(Math.sign(pos[2][0])).toBe(Math.sign(pos[3][0]));
    expect(Math.sign(pos[0][0])).not.toBe(Math.sign(pos[2][0]));
  });

  test('fewer than two vectors sit at the origin', () => {
    expect(pca3([])).toEqual([]);
    expect(pca3([[1, 2, 3]])).toEqual([[0, 0, 0]]);
  });

  test('vectors shorter than three dimensions work', () => {
    const pos = pca3([
      [0, 1],
      [1, 0],
      [2, 2],
    ]);
    expect(pos.every((p) => p.length === 3 && p.every(Number.isFinite))).toBe(true);
  });
});

describe('normaliseToBall', () => {
  test('every position ends inside the unit ball, the farthest at the radius', () => {
    const out = normaliseToBall([
      [10, 0, 0],
      [0, -5, 0],
      [3, 4, 0],
    ]);
    for (const p of out) expect(norm(p)).toBeLessThanOrEqual(1);
    expect(Math.max(...out.map(norm))).toBeCloseTo(0.95);
  });

  test('all-zero positions stay at the origin', () => {
    expect(normaliseToBall([[0, 0, 0]])).toEqual([[0, 0, 0]]);
  });
});

describe('placement without an embedding', () => {
  test('at the centroid of its neighbours', () => {
    const neighbours: Vec3[] = [
      [0.2, 0, 0],
      [0, 0.4, 0],
    ];
    expect(placeWithoutEmbedding({ id: 'n-1', kind: 'fact' }, neighbours)).toEqual([0.1, 0.2, 0]);
  });

  test('on the shell by kind when it has no placed neighbour', () => {
    const p = placeWithoutEmbedding({ id: 'n-1', kind: 'fact' }, []);
    expect(p).toEqual(shellPosition('fact', 'n-1'));
    expect(norm(p)).toBeLessThanOrEqual(1);
    expect(norm(p)).toBeGreaterThan(0.5);
  });

  test('shellPosition is deterministic and separates kinds', () => {
    expect(shellPosition('goal', 'n-1')).toEqual(shellPosition('goal', 'n-1'));
    expect(shellPosition('goal', 'n-1')).not.toEqual(shellPosition('person', 'n-1'));
  });
});
