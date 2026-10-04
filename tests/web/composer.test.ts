import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  COMPOSER_MAX_VH,
  COMPOSER_MIN_PX,
  attachAutoGrow,
  composerHeight,
} from '../../web/ui/composer.js';

// 2026-10-04: the Agent Home chat box rendered ~300px wide and two lines tall.
// `.thread-input-area` was a flex row, so the row holding the textarea shrank
// to its content; every message box was also fixed at 2–3 rows.

describe('composerHeight', () => {
  it('never goes below the minimum', () => {
    expect(composerHeight(20, { minPx: 88, maxPx: 400 })).toBe(88);
  });
  it('follows the content between the bounds', () => {
    expect(composerHeight(150, { minPx: 88, maxPx: 400 })).toBe(150);
  });
  it('stops at the maximum (the box scrolls from there)', () => {
    expect(composerHeight(900, { minPx: 88, maxPx: 400 })).toBe(400);
  });
  it('a maximum below the minimum yields the minimum', () => {
    expect(composerHeight(500, { minPx: 88, maxPx: 50 })).toBe(88);
  });
  it('a non-numeric scrollHeight yields the minimum', () => {
    expect(composerHeight(Number.NaN, { minPx: 88, maxPx: 400 })).toBe(88);
  });
});

function fakeTextarea(scrollHeight: number) {
  const listeners: Record<string, () => void> = {};
  return {
    style: {} as Record<string, string>,
    scrollHeight,
    addEventListener: (ev: string, fn: () => void) => {
      listeners[ev] = fn;
    },
    fire: (ev: string) => listeners[ev]?.(),
  };
}

describe('attachAutoGrow', () => {
  it('sizes on attach and again on every input event', () => {
    const ta = fakeTextarea(120);
    attachAutoGrow(ta as never, { maxPx: 400 });
    expect(ta.style.height).toBe('120px');
    ta.scrollHeight = 260;
    ta.fire('input');
    expect(ta.style.height).toBe('260px');
  });

  it('scrolls only once the maximum is reached', () => {
    const ta = fakeTextarea(1000);
    attachAutoGrow(ta as never, { maxPx: 400 });
    expect(ta.style.height).toBe('400px');
    expect(ta.style.overflowY).toBe('auto');
    ta.scrollHeight = 60;
    ta.fire('input');
    expect(ta.style.height).toBe(`${COMPOSER_MIN_PX}px`);
    expect(ta.style.overflowY).toBe('hidden');
  });

  it('a missing element is a no-op', () => {
    expect(() => attachAutoGrow(null)).not.toThrow();
  });

  it('defaults: minimum about four lines, maximum 40% of the viewport', () => {
    expect(COMPOSER_MIN_PX).toBeGreaterThanOrEqual(80);
    expect(COMPOSER_MAX_VH).toBe(40);
  });
});

describe('thread composer layout (style.css)', () => {
  const css = readFileSync(join(import.meta.dir, '../../web/style.css'), 'utf-8');
  const rule = (selector: string) => {
    const re = new RegExp(`(^|\\n)${selector.replace(/[.#-]/g, '\\$&')}\\s*\\{([^}]*)\\}`);
    return css.match(re)?.[2] ?? '';
  };

  it('stacks previews above a full-width input row', () => {
    expect(rule('.thread-input-area')).toMatch(/flex-direction:\s*column/);
    expect(rule('.thread-input-row')).toMatch(/width:\s*100%/);
  });

  it('the textarea fills the row and starts at the composer minimum', () => {
    const r = rule('.thread-input');
    expect(r).toMatch(/flex:\s*1/);
    expect(r).toMatch(new RegExp(`min-height:\\s*${COMPOSER_MIN_PX}px`));
  });
});
