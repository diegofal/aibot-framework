/**
 * Navigation guards (UX overhaul wave 2).
 *
 * A page with unsaved edits registers a guard: `registerNavGuard((to) => …)`
 * returns falsy while clean, or the prompt to show (a string message, or
 * `{ title?, message, confirmLabel?, cancelLabel?, onDiscard? }`) while dirty.
 * app.js asks the guards on every hashchange — link clicks, the back button
 * and typed hashes alike — before the router renders; it puts the old hash
 * back while the confirm dialog is open and follows the new one only after
 * the operator agrees. Confirming drops every guard (the page is going away).
 * No DOM here; the confirm function is injected. Tests: tests/web/nav-guard.test.ts.
 */
const guards = new Set();

const DEFAULT_PROMPT = {
  title: 'Discard unsaved changes?',
  message: 'This page has edits that were not saved.',
  confirmLabel: 'Discard',
  cancelLabel: 'Keep editing',
};

/** Add a guard; returns the function that removes it. */
export function registerNavGuard(fn) {
  if (typeof fn !== 'function') return () => {};
  guards.add(fn);
  return () => {
    guards.delete(fn);
  };
}

export function clearNavGuards() {
  guards.clear();
}

export function navGuardCount() {
  return guards.size;
}

/** `{ prompt, onDiscard }` of the first dirty guard for a navigation to `to`, or null. */
export function pendingNavGuard(to) {
  for (const fn of guards) {
    let res;
    try {
      res = fn(to);
    } catch {
      res = null;
    }
    if (!res) continue;
    if (typeof res === 'string')
      return { prompt: { ...DEFAULT_PROMPT, message: res }, onDiscard: null };
    const { onDiscard, ...rest } = res;
    return {
      prompt: { ...DEFAULT_PROMPT, ...rest },
      onDiscard: typeof onDiscard === 'function' ? onDiscard : null,
    };
  }
  return null;
}

/**
 * true when navigation to `to` may proceed: nothing dirty, or the operator
 * confirmed (`confirm(prompt)` resolves true), in which case `onDiscard`
 * runs and every guard is dropped.
 */
export async function checkNavGuards(to, confirm) {
  const hit = pendingNavGuard(to);
  if (!hit) return true;
  const ok = await confirm(hit.prompt);
  if (!ok) return false;
  try {
    hit.onDiscard?.();
  } catch {
    /* discarding is best effort */
  }
  clearNavGuards();
  return true;
}
