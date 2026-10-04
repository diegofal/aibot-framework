import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  COMPOSER_MAX_VH,
  COMPOSER_MIN_PX,
  attachAutoGrow,
  composerHeight,
  fitComposer,
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

  it('caps at the maximum and never hides overflow', () => {
    // Prepass round 1: overflow 'hidden' clipped text set from code (Feedback
    // "Generate", a restored Inbox draft) until the next keystroke. A stale
    // size must scroll, never clip.
    const ta = fakeTextarea(1000);
    attachAutoGrow(ta as never, { maxPx: 400 });
    expect(ta.style.height).toBe('400px');
    expect(ta.style.overflowY).toBe('auto');
    ta.scrollHeight = 60;
    ta.fire('input');
    expect(ta.style.height).toBe(`${COMPOSER_MIN_PX}px`);
    expect(ta.style.overflowY).not.toBe('hidden');
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

describe('fitComposer', () => {
  it('resizes after a value set from code, with the options given at attach', () => {
    const ta = fakeTextarea(60);
    attachAutoGrow(ta as never, { minPx: 64, maxPx: 300 });
    expect(ta.style.height).toBe('64px');
    ta.scrollHeight = 500; // e.g. a generated feedback text assigned to .value
    fitComposer(ta as never);
    expect(ta.style.height).toBe('300px');
  });

  it('works on a textarea that was never attached (defaults)', () => {
    const ta = fakeTextarea(150);
    fitComposer(ta as never);
    expect(ta.style.height).toBe('150px');
  });

  it('a missing element is a no-op', () => {
    expect(() => fitComposer(null)).not.toThrow();
  });
});

describe('fitComposer — border-box', () => {
  // Prepass round 2: scrollHeight excludes the border, so a border-box textarea
  // sized to scrollHeight came out 2px short and scrolled before the cap.
  it('adds the border (offsetHeight − clientHeight) to the content height', () => {
    const ta = { ...fakeTextarea(150), offsetHeight: 102, clientHeight: 100 };
    fitComposer(ta as never);
    expect(ta.style.height).toBe('152px');
  });

  it('the cap still applies to the bordered height', () => {
    const ta = { ...fakeTextarea(1000), offsetHeight: 102, clientHeight: 100 };
    attachAutoGrow(ta as never, { maxPx: 400 });
    expect(ta.style.height).toBe('400px');
  });
});
