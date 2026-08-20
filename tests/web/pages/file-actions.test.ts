import { describe, expect, it } from 'bun:test';
import {
  downloadFilename,
  flashButtonLabel,
  getMimeType,
} from '../../../web/pages/file-actions.js';

describe('getMimeType', () => {
  it('returns text/markdown for .md', () => {
    expect(getMimeType('notes.md')).toBe('text/markdown');
    expect(getMimeType('foo/bar.MD')).toBe('text/markdown');
    expect(getMimeType('notes.markdown')).toBe('text/markdown');
  });

  it('returns text/html for .html', () => {
    expect(getMimeType('page.html')).toBe('text/html');
  });

  it('returns text/html for .htm', () => {
    expect(getMimeType('page.htm')).toBe('text/html');
  });

  it('returns application/json for .json', () => {
    expect(getMimeType('data.json')).toBe('application/json');
  });

  it('returns text/csv for .csv', () => {
    expect(getMimeType('data.csv')).toBe('text/csv');
  });

  it('returns text/plain;charset=utf-8 for unknown extensions', () => {
    expect(getMimeType('README')).toBe('text/plain;charset=utf-8');
    expect(getMimeType('foo.txt')).toBe('text/plain;charset=utf-8');
    expect(getMimeType('foo.py')).toBe('text/plain;charset=utf-8');
  });

  it('returns text/plain;charset=utf-8 for empty/undefined input', () => {
    expect(getMimeType('')).toBe('text/plain;charset=utf-8');
    expect(getMimeType(undefined)).toBe('text/plain;charset=utf-8');
  });
});

describe('downloadFilename', () => {
  it('returns the basename for a plain filename', () => {
    expect(downloadFilename('report.md')).toBe('report.md');
  });

  it('returns the basename for a nested forward-slash path', () => {
    expect(downloadFilename('reports/2026/a.md')).toBe('a.md');
    expect(downloadFilename('a/b/c/d.txt')).toBe('d.txt');
  });

  it('returns the basename for a backslash-separated path', () => {
    expect(downloadFilename('reports\\2026\\a.md')).toBe('a.md');
  });

  it('handles a trailing slash', () => {
    expect(downloadFilename('reports/2026/')).toBe('2026');
  });

  it('handles a trailing backslash', () => {
    expect(downloadFilename('reports\\')).toBe('reports');
  });

  it('returns empty string for empty input', () => {
    expect(downloadFilename('')).toBe('');
  });

  it('returns empty string for undefined/null', () => {
    expect(downloadFilename(undefined)).toBe('');
    expect(downloadFilename(null)).toBe('');
  });
});

describe('flashButtonLabel', () => {
  it('is a no-op when btn is null', () => {
    expect(() => flashButtonLabel(null, 'X')).not.toThrow();
  });

  it('is a no-op when btn is undefined', () => {
    expect(() => flashButtonLabel(undefined, 'X')).not.toThrow();
  });

  it('records the original label and swaps textContent', () => {
    const btn = { textContent: 'Original', dataset: {}, isConnected: true };
    let textDuringFlash = null;
    const origSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = (fn) => {
      textDuringFlash = btn.textContent;
      fn();
      return 0;
    };
    try {
      flashButtonLabel(btn, 'Copied', 1500);
    } finally {
      globalThis.setTimeout = origSetTimeout;
    }
    expect(btn.dataset.originalLabel).toBe('Original');
    expect(textDuringFlash).toBe('Copied');
    expect(btn.textContent).toBe('Original');
  });

  it('does not overwrite the stored originalLabel on repeated calls', () => {
    const btn = { textContent: 'Original', dataset: {}, isConnected: true };
    const origSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = (fn) => {
      fn();
      return 0;
    };
    try {
      flashButtonLabel(btn, 'First');
      flashButtonLabel(btn, 'Second');
    } finally {
      globalThis.setTimeout = origSetTimeout;
    }
    expect(btn.dataset.originalLabel).toBe('Original');
    expect(btn.textContent).toBe('Original');
  });
});
