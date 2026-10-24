import { describe, expect, test } from 'bun:test';
import {
  daysBetween,
  escapeRegExp,
  extractDates,
  jaccard,
  mentionsWord,
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

describe('escapeRegExp', () => {
  test('escapes every regex metacharacter', () => {
    const raw = 'a.b*c+d?e^f$g{h}i(j)k|l[m]n\\o';
    expect(new RegExp(`^${escapeRegExp(raw)}$`).test(raw)).toBe(true);
    expect(new RegExp(escapeRegExp('a.c')).test('abc')).toBe(false);
  });
});

describe('mentionsWord', () => {
  test('a whole word, case-insensitive', () => {
    expect(mentionsWord('Ask max about it', 'Max')).toBe(true);
    expect(mentionsWord('Max.', 'max')).toBe(true);
    expect(mentionsWord('the maximum is 3', 'Max')).toBe(false);
    expect(mentionsWord('Maxwell said so', 'Max')).toBe(false);
  });

  test('letters with accents and digits count as word characters', () => {
    expect(mentionsWord('Hablé con Ána hoy', 'Ána')).toBe(true);
    expect(mentionsWord('Anaí vino', 'Ana')).toBe(false);
    expect(mentionsWord('bot2 is up', 'bot')).toBe(false);
  });

  test('names with regex characters and an empty word', () => {
    expect(mentionsWord('ping C++ now', 'C++')).toBe(true);
    expect(mentionsWord('anything', '')).toBe(false);
    expect(mentionsWord('anything', '   ')).toBe(false);
  });
});
