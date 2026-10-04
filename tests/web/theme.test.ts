import { describe, expect, it } from 'bun:test';
import {
  THEMES,
  THEME_KEY,
  applyTheme,
  currentTheme,
  nextTheme,
  readStoredTheme,
  resolveTheme,
  storeTheme,
  themeToggleLabel,
} from '../../web/ui/theme.js';

function fakeStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => {
      map.set(k, v);
    },
    map,
  };
}

function fakeDoc(theme?: string) {
  const dataset: Record<string, string> = {};
  if (theme) dataset.theme = theme;
  return { documentElement: { dataset } };
}

describe('resolveTheme', () => {
  it('honours a stored choice over the OS preference', () => {
    expect(resolveTheme('light', false)).toBe('light');
    expect(resolveTheme('dark', true)).toBe('dark');
  });
  it('falls back to the OS preference, then dark', () => {
    expect(resolveTheme(null, true)).toBe('light');
    expect(resolveTheme(null, false)).toBe('dark');
    expect(resolveTheme('sepia', false)).toBe('dark');
    expect(resolveTheme(undefined)).toBe('dark');
  });
});

describe('nextTheme / label', () => {
  it('flips between the two themes', () => {
    expect(nextTheme('dark')).toBe('light');
    expect(nextTheme('light')).toBe('dark');
    expect(THEMES).toEqual(['dark', 'light']);
  });
  it('labels the toggle with the theme you will switch to', () => {
    expect(themeToggleLabel('dark')).toBe('☼ Light');
    expect(themeToggleLabel('light')).toBe('☾ Dark');
  });
});

describe('storage', () => {
  it('reads only valid values', () => {
    expect(readStoredTheme(fakeStorage({ [THEME_KEY]: 'light' }))).toBe('light');
    expect(readStoredTheme(fakeStorage({ [THEME_KEY]: 'neon' }))).toBeNull();
    expect(readStoredTheme(fakeStorage())).toBeNull();
    expect(readStoredTheme(null)).toBeNull();
  });
  it('survives a storage that throws', () => {
    const throwing = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    };
    expect(readStoredTheme(throwing)).toBeNull();
    expect(() => storeTheme('light', throwing)).not.toThrow();
  });
  it('stores only valid themes', () => {
    const s = fakeStorage();
    storeTheme('light', s);
    expect(s.map.get(THEME_KEY)).toBe('light');
    storeTheme('neon', s);
    expect(s.map.get(THEME_KEY)).toBe('light');
  });
});

describe('document stamping', () => {
  it('applies a valid theme to the root element and ignores invalid ones', () => {
    const doc = fakeDoc();
    applyTheme('light', doc);
    expect(doc.documentElement.dataset.theme).toBe('light');
    applyTheme('neon', doc);
    expect(doc.documentElement.dataset.theme).toBe('light');
    expect(() => applyTheme('dark', undefined)).not.toThrow();
  });
  it('reads the stamped theme first', () => {
    expect(currentTheme(fakeDoc('light'))).toBe('light');
    expect(currentTheme(fakeDoc())).toBe('dark');
  });
});
