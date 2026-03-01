import { afterEach, describe, expect, test } from 'bun:test';
import {
  closeAllBrowsers,
  closeBrowser,
  getActivePage,
  getBrowserStatus,
  isRunning,
  resolveRef,
  storeRefs,
} from '../../src/tools/browser-session';
import type { ElementRef } from '../../src/tools/browser-snapshot';

/**
 * Tests for per-bot browser session isolation.
 * These tests exercise the session Map logic without launching real browsers.
 * Real browser launch is covered by integration/e2e tests.
 */

afterEach(async () => {
  await closeAllBrowsers();
});

describe('browser-session per-bot isolation', () => {
  test('different botIds get independent sessions', () => {
    // Both should start as not running
    expect(isRunning('botA')).toBe(false);
    expect(isRunning('botB')).toBe(false);
    expect(getBrowserStatus('botA').running).toBe(false);
    expect(getBrowserStatus('botB').running).toBe(false);
  });

  test('storeRefs for botA does not affect botB', () => {
    const refsA = new Map<string, ElementRef>([
      ['e1', { role: 'button', name: 'Submit' }],
      ['e2', { role: 'link', name: 'Home' }],
    ]);
    const refsB = new Map<string, ElementRef>([['e1', { role: 'textbox', name: 'Search' }]]);

    storeRefs('botA', refsA);
    storeRefs('botB', refsB);

    // botA refs
    expect(resolveRef('botA', 'e1')).toEqual({ role: 'button', name: 'Submit' });
    expect(resolveRef('botA', 'e2')).toEqual({ role: 'link', name: 'Home' });

    // botB refs — same key 'e1' but different value
    expect(resolveRef('botB', 'e1')).toEqual({ role: 'textbox', name: 'Search' });
    expect(resolveRef('botB', 'e2')).toBeUndefined();
  });

  test('closeBrowser for botA does not affect botB refs', async () => {
    storeRefs('botA', new Map([['e1', { role: 'button', name: 'OK' }]]));
    storeRefs('botB', new Map([['e1', { role: 'link', name: 'Cancel' }]]));

    await closeBrowser('botA');

    // botA refs should be gone (session deleted)
    expect(resolveRef('botA', 'e1')).toBeUndefined();

    // botB refs should still be intact
    expect(resolveRef('botB', 'e1')).toEqual({ role: 'link', name: 'Cancel' });
  });

  test('closeBrowser is idempotent', async () => {
    // Should not throw even for unknown botId
    await closeBrowser('nonexistent');
    await closeBrowser('nonexistent');
  });

  test('closeAllBrowsers clears all sessions', async () => {
    storeRefs('botA', new Map([['e1', { role: 'button', name: 'A' }]]));
    storeRefs('botB', new Map([['e1', { role: 'button', name: 'B' }]]));
    storeRefs('botC', new Map([['e1', { role: 'button', name: 'C' }]]));

    await closeAllBrowsers();

    expect(resolveRef('botA', 'e1')).toBeUndefined();
    expect(resolveRef('botB', 'e1')).toBeUndefined();
    expect(resolveRef('botC', 'e1')).toBeUndefined();
  });

  test('getActivePage returns null when no browser launched', () => {
    expect(getActivePage('botA')).toBeNull();
    expect(getActivePage('botB')).toBeNull();
  });

  test('isRunning returns false when session has no browser', () => {
    // Storing refs creates a session but without a browser
    storeRefs('botA', new Map());
    expect(isRunning('botA')).toBe(false);
  });
});
