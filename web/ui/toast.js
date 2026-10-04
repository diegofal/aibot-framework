import { cx, esc } from './escape.js';

const TONES = ['ok', 'warn', 'danger', 'info', 'muted', 'accent'];

/**
 * Pure markup for one toast. With `actionLabel` the toast carries a button
 * (`[data-toast-action]`) next to the text; without it the markup is the
 * original single-text form.
 */
export function toastMarkup(text, tone = 'muted', actionLabel = '') {
  const t = TONES.includes(tone) ? tone : 'muted';
  if (!actionLabel) {
    return `<div class="${cx('ui-toast', `ui-toast-${t}`)}" role="status">${esc(text)}</div>`;
  }
  return `<div class="${cx('ui-toast', `ui-toast-${t}`, 'ui-toast-has-action')}" role="status"><span class="ui-toast-text">${esc(
    text
  )}</span><button type="button" class="ui-toast-action" data-toast-action>${esc(actionLabel)}</button></div>`;
}

/**
 * Show a transient toast in the bottom-right corner. No-op outside a DOM.
 * `action = { label, onClick }` adds a button: clicking it calls `onClick`
 * and dismisses; clicking the body only dismisses.
 * Returns the element (with a `dismiss()` method) so callers can dismiss early.
 */
export function showToast(text, { tone = 'muted', duration = 3500, action = null } = {}) {
  if (typeof document === 'undefined') return null;
  let root = document.getElementById('ui-toasts');
  if (!root) {
    root = document.createElement('div');
    root.id = 'ui-toasts';
    root.className = 'ui-toasts';
    document.body.appendChild(root);
  }
  const wrap = document.createElement('div');
  wrap.innerHTML = toastMarkup(text, tone, action?.label || '');
  const el = wrap.firstElementChild;
  root.appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));
  let removed = false;
  const remove = () => {
    if (removed) return;
    removed = true;
    el.classList.remove('show');
    setTimeout(() => el.remove(), 200);
  };
  el.dismiss = remove;
  const btn = el.querySelector('[data-toast-action]');
  if (btn && action) {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      remove();
      try {
        action.onClick?.();
      } catch (err) {
        console.error('toast action failed', err);
      }
    });
  }
  el.addEventListener('click', remove);
  if (duration > 0) setTimeout(remove, duration);
  return el;
}

/** Pending undoables, committed early by `flushUndoables()`. */
const pending = new Set();
let unloadWired = false;

function wireUnload() {
  if (unloadWired || typeof window === 'undefined' || !window.addEventListener) return;
  unloadWired = true;
  window.addEventListener('beforeunload', flushUndoables);
  window.addEventListener('hashchange', flushUndoables);
}

/** Commit every pending undoable now. Wired to `beforeunload` / `hashchange`. */
export function flushUndoables() {
  for (const entry of [...pending]) entry.commitNow();
}

/**
 * Deferred-commit action with an "Undo" toast. `commit()` runs once after
 * `delayMs` unless Undo is clicked first (then `undo?.()` runs and commit
 * never does). Navigating away commits pending actions.
 *
 * Returns a Promise resolving to `{ undone, result }` (`result` = commit's
 * resolved value; rejects if commit throws). The promise also has `.undo()`
 * for programmatic undo (tests, keyboard shortcuts).
 */
export function undoable(text, { commit, undo, delayMs = 5000, tone = 'muted' } = {}) {
  wireUnload();
  let settled = false;
  let timer = null;
  let toastEl = null;
  let resolveFn;
  let rejectFn;
  const promise = new Promise((res, rej) => {
    resolveFn = res;
    rejectFn = rej;
  });

  const finish = () => {
    settled = true;
    pending.delete(entry);
    if (timer) clearTimeout(timer);
    toastEl?.dismiss?.();
  };

  const entry = {
    commitNow() {
      if (settled) return;
      finish();
      try {
        Promise.resolve(commit?.()).then(
          (result) => resolveFn({ undone: false, result }),
          rejectFn
        );
      } catch (err) {
        rejectFn(err);
      }
    },
    undoNow() {
      if (settled) return;
      finish();
      try {
        undo?.();
      } catch (err) {
        console.error('undo failed', err);
      }
      resolveFn({ undone: true, result: undefined });
    },
  };

  pending.add(entry);
  timer = setTimeout(() => entry.commitNow(), delayMs);
  toastEl = showToast(text, {
    tone,
    duration: 0,
    action: { label: 'Undo', onClick: () => entry.undoNow() },
  });
  // Clicking the toast body dismisses it but must not cancel the commit.
  promise.undo = () => entry.undoNow();
  return promise;
}
