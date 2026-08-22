import { describe, expect, test } from 'bun:test';
import {
  daysBetween,
  extractDates,
  jaccard,
  normalizeTitle,
  textSimilarity,
  titleTokens,
} from '../../src/hygiene/text-utils';

describe('normalizeTitle', () => {
  test('lowercases, strips accents and punctuation', () => {
    expect(normalizeTitle('  Publicar Artículo: ¡Hoy!  ')).toBe('publicar articulo hoy');
  });
});

describe('titleTokens', () => {
  test('drops spanish and english stopwords', () => {
    expect(titleTokens('Escribir el resumen de la semana for the team')).toEqual([
      'escribir',
      'resumen',
      'semana',
      'team',
    ]);
  });
});

describe('jaccard', () => {
  test('is 1 for identical sets and 0 for disjoint', () => {
    expect(jaccard(['a', 'b'], ['b', 'a'])).toBe(1);
    expect(jaccard(['a'], ['b'])).toBe(0);
  });

  test('returns 0 for two empty sets', () => {
    expect(jaccard([], [])).toBe(0);
  });

  test('computes intersection over union', () => {
    expect(jaccard(['a', 'b', 'c'], ['b', 'c', 'd'])).toBeCloseTo(0.5);
  });
});

describe('textSimilarity', () => {
  test('identical normalised content scores 1', () => {
    expect(textSimilarity('# Hello\n\nWorld!', 'hello world')).toBe(1);
  });

  test('unrelated content scores near 0', () => {
    expect(textSimilarity('alpha beta gamma', 'delta epsilon zeta')).toBe(0);
  });
});

describe('extractDates', () => {
  test('parses ISO and DD/MM[/YYYY] dates', () => {
    const ref = new Date('2026-08-21T12:00:00');
    const dates = extractDates('esperar hasta 2026-07-01, y luego 05/08 o 15/08/2026', ref);
    expect(dates.map((d) => d.toISOString().slice(0, 10))).toEqual([
      '2026-07-01',
      '2026-08-05',
      '2026-08-15',
    ]);
  });

  test('ignores invalid day/month combos', () => {
    expect(extractDates('31/02 and 2026-13-40', new Date())).toEqual([]);
  });
});

describe('daysBetween', () => {
  test('counts whole days', () => {
    expect(daysBetween(new Date('2026-08-01T00:00:00Z'), new Date('2026-08-21T12:00:00Z'))).toBe(
      20
    );
  });
});
