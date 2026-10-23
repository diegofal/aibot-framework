/**
 * Where each neuron sits in the ball, computed server-side so the live view
 * and a replay agree: PCA of the embeddings to three dimensions (power
 * iteration with deflation), normalised into the unit ball. A neuron without
 * an embedding sits at the centroid of its placed neighbours, else on a shell
 * by kind. Pure.
 */
import { NEURON_KINDS, type NeuronKind, type Vec3 } from './types';

const ITERATIONS = 100;
const EPS = 1e-12;

export function pca3(vectors: number[][]): Vec3[] {
  const n = vectors.length;
  if (n === 0) return [];
  if (n === 1) return [[0, 0, 0]];
  const d = Math.max(...vectors.map((v) => v.length));
  const mean = new Array<number>(d).fill(0);
  for (const v of vectors) for (let j = 0; j < d; j++) mean[j] += (v[j] ?? 0) / n;
  const x = vectors.map((v) => mean.map((m, j) => (v[j] ?? 0) - m));

  const components: number[][] = [];
  for (let k = 0; k < 3; k++) {
    let v = Array.from({ length: d }, (_, i) => 1 + ((i * 7919 + k * 104_729) % 97) / 97);
    v = orthonormalise(v, components);
    let ok = v.length > 0;
    for (let it = 0; it < ITERATIONS && ok; it++) {
      const xv = x.map((row) => dot(row, v));
      const next = new Array<number>(d).fill(0);
      for (let i = 0; i < n; i++) for (let j = 0; j < d; j++) next[j] += x[i][j] * xv[i];
      const o = orthonormalise(next, components);
      if (o.length === 0) ok = false;
      else v = o;
    }
    components.push(ok ? v : new Array<number>(d).fill(0));
  }
  return x.map(
    (row) => [dot(row, components[0]), dot(row, components[1]), dot(row, components[2])] as Vec3
  );
}

/** Centre the positions and scale them so the farthest one sits at `radius`. */
export function normaliseToBall(positions: Vec3[], radius = 0.95): Vec3[] {
  if (positions.length === 0) return [];
  const c = [0, 1, 2].map((j) => positions.reduce((s, p) => s + p[j], 0) / positions.length);
  const centred = positions.map((p) => [p[0] - c[0], p[1] - c[1], p[2] - c[2]] as Vec3);
  const max = Math.max(...centred.map(length));
  if (max < EPS) return centred.map(() => [0, 0, 0] as Vec3);
  return centred.map((p) => p.map((v) => (v / max) * radius) as Vec3);
}

export function placeWithoutEmbedding(
  neuron: { id: string; kind: NeuronKind },
  neighbourPositions: Vec3[]
): Vec3 {
  if (neighbourPositions.length === 0) return shellPosition(neuron.kind, neuron.id);
  const k = neighbourPositions.length;
  return [0, 1, 2].map(
    (j) => Math.round((neighbourPositions.reduce((s, p) => s + p[j], 0) / k) * 1e9) / 1e9
  ) as Vec3;
}

/** A deterministic point on a shell: the kind picks the longitude band, the id jitters it. */
export function shellPosition(kind: NeuronKind, id: string): Vec3 {
  const kindIndex = Math.max(0, NEURON_KINDS.indexOf(kind));
  const h = hash(id);
  const band = (2 * Math.PI) / NEURON_KINDS.length;
  const theta = kindIndex * band + ((h % 1000) / 1000) * band * 0.8;
  const z = (((h >>> 10) % 1000) / 1000) * 1.6 - 0.8;
  const r = 0.85;
  const ring = Math.sqrt(1 - z * z);
  return [r * ring * Math.cos(theta), r * ring * Math.sin(theta), r * z];
}

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function dot(a: number[], b: number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * (b[i] ?? 0);
  return s;
}

function length(p: number[]): number {
  return Math.sqrt(dot(p, p));
}

/** `v` minus its projection on each basis vector, normalised; `[]` when nothing is left. */
function orthonormalise(v: number[], basis: number[][]): number[] {
  const out = [...v];
  for (const b of basis) {
    const p = dot(out, b);
    for (let i = 0; i < out.length; i++) out[i] -= p * b[i];
  }
  const len = length(out);
  if (len < 1e-9) return [];
  return out.map((x) => x / len);
}
