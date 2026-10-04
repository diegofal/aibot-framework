import { afterEach, describe, expect, it } from 'bun:test';
import {
  checkNavGuards,
  clearNavGuards,
  navGuardCount,
  pendingNavGuard,
  registerNavGuard,
} from '../../web/nav-guard.js';

afterEach(() => clearNavGuards());

describe('nav guard registry', () => {
  it('register returns an unregister function', () => {
    const off = registerNavGuard(() => null);
    expect(navGuardCount()).toBe(1);
    off();
    expect(navGuardCount()).toBe(0);
  });

  it('pendingNavGuard returns the first dirty guard prompt, with the target hash', () => {
    const seen: string[] = [];
    registerNavGuard((to) => {
      seen.push(to);
      return null;
    });
    registerNavGuard(() => ({ title: 'Discard?', message: 'Unsaved' }));
    const hit = pendingNavGuard('#/agents');
    expect(seen).toEqual(['#/agents']);
    expect(hit?.prompt.title).toBe('Discard?');
  });

  it('a string from a guard becomes the message', () => {
    registerNavGuard(() => 'You have unsaved edits');
    expect(pendingNavGuard('#/')?.prompt).toEqual({
      title: 'Discard unsaved changes?',
      message: 'You have unsaved edits',
      confirmLabel: 'Discard',
      cancelLabel: 'Keep editing',
    });
  });

  it('a guard that throws counts as clean', () => {
    registerNavGuard(() => {
      throw new Error('gone');
    });
    expect(pendingNavGuard('#/')).toBeNull();
  });
});

describe('checkNavGuards', () => {
  it('proceeds without asking when no guard is dirty', async () => {
    let asked = 0;
    registerNavGuard(() => false);
    const ok = await checkNavGuards('#/', async () => {
      asked++;
      return false;
    });
    expect(ok).toBe(true);
    expect(asked).toBe(0);
  });

  it('asks, and blocks when the operator keeps editing', async () => {
    registerNavGuard(() => 'dirty');
    const ok = await checkNavGuards('#/', async () => false);
    expect(ok).toBe(false);
    expect(navGuardCount()).toBe(1);
  });

  it('on confirm: runs onDiscard and drops every guard', async () => {
    const calls: string[] = [];
    registerNavGuard(() => ({ message: 'dirty', onDiscard: () => calls.push('discard') }));
    registerNavGuard(() => null);
    const ok = await checkNavGuards('#/', async (prompt) => {
      calls.push(`ask:${prompt.message}`);
      return true;
    });
    expect(ok).toBe(true);
    expect(calls).toEqual(['ask:dirty', 'discard']);
    expect(navGuardCount()).toBe(0);
  });
});
