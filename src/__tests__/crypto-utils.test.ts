import { describe, expect, it } from 'bun:test';
import { safeCompare } from '../crypto-utils';

describe('safeCompare', () => {
  // --- Happy path ---
  it('returns true for identical strings', () => {
    expect(safeCompare('my-secret-key', 'my-secret-key')).toBe(true);
  });

  it('returns true for single-character match', () => {
    expect(safeCompare('x', 'x')).toBe(true);
  });

  // --- Mismatch cases ---
  it('returns false for different strings of same length', () => {
    expect(safeCompare('abc123', 'abc456')).toBe(false);
  });

  it('returns false for strings differing only in last character', () => {
    expect(safeCompare('secret-key-a', 'secret-key-b')).toBe(false);
  });

  // --- Length mismatch ---
  it('returns false when strings have different lengths', () => {
    expect(safeCompare('short', 'much-longer-string')).toBe(false);
  });

  it('returns false when one string is a prefix of the other', () => {
    expect(safeCompare('api-key', 'api-key-extended')).toBe(false);
  });

  // --- Empty / undefined / falsy ---
  it('returns false for empty string vs empty string', () => {
    expect(safeCompare('', '')).toBe(false);
  });

  it('returns false for empty string vs valid string', () => {
    expect(safeCompare('', 'something')).toBe(false);
  });

  it('returns false for valid string vs empty string', () => {
    expect(safeCompare('something', '')).toBe(false);
  });

  it('returns false when first argument is undefined', () => {
    expect(safeCompare(undefined, 'secret')).toBe(false);
  });

  it('returns false when second argument is undefined', () => {
    expect(safeCompare('secret', undefined)).toBe(false);
  });

  it('returns false when both arguments are undefined', () => {
    expect(safeCompare(undefined, undefined)).toBe(false);
  });

  // --- Unicode ---
  it('returns true for identical unicode strings', () => {
    expect(safeCompare('café-résumé', 'café-résumé')).toBe(true);
  });

  it('returns false for visually similar but different unicode', () => {
    // Latin 'a' (U+0061) vs Cyrillic 'а' (U+0430)
    expect(safeCompare('admin', '\u0430dmin')).toBe(false);
  });

  it('handles emoji strings correctly', () => {
    expect(safeCompare('🔑key', '🔑key')).toBe(true);
    expect(safeCompare('🔑key', '🔒key')).toBe(false);
  });

  // --- Case sensitivity ---
  it('is case-sensitive', () => {
    expect(safeCompare('Secret', 'secret')).toBe(false);
  });

  // --- Whitespace sensitivity ---
  it('distinguishes strings with trailing whitespace', () => {
    expect(safeCompare('key', 'key ')).toBe(false);
  });

  it('distinguishes strings with leading whitespace', () => {
    expect(safeCompare(' key', 'key')).toBe(false);
  });
});
