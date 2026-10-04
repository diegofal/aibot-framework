import { esc } from './escape.js';

/**
 * Pure markup for a centered modal dialog. All strings are escaped.
 * `input = { placeholder, value }` adds a text field (`[data-dialog-input]`).
 * `tone: 'danger'` styles the confirm button as destructive; any other tone
 * uses the primary style.
 */
export function dialogMarkup({
  title = '',
  message = '',
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  tone = 'danger',
  input = null,
} = {}) {
  const btnTone = tone === 'danger' ? 'btn-danger' : 'btn-primary';
  const msg = message ? `<p class="ui-dialog-message">${esc(message)}</p>` : '';
  const field = input
    ? `<input type="text" class="ui-dialog-input" data-dialog-input placeholder="${esc(
        input.placeholder ?? ''
      )}" value="${esc(input.value ?? '')}" />`
    : '';
  return `<div class="ui-dialog-backdrop" data-dialog-cancel-backdrop></div><div class="ui-dialog" role="dialog" aria-modal="true" aria-label="${esc(
    title
  )}"><div class="ui-dialog-title">${esc(title)}</div>${msg}${field}<div class="ui-dialog-actions"><button type="button" class="btn btn-sm" data-dialog-cancel>${esc(
    cancelLabel
  )}</button><button type="button" class="btn btn-sm ${btnTone}" data-dialog-confirm>${esc(
    confirmLabel
  )}</button></div></div>`;
}

/**
 * Mount a dialog and resolve with `onConfirm(root)` / `onCancel()`.
 * `onConfirm` may return `undefined` to keep the dialog open (validation).
 */
function openDialog(opts, { onConfirm, onCancel, focusInput }) {
  return new Promise((resolve) => {
    document.getElementById('ui-dialog-root')?.remove();
    const root = document.createElement('div');
    root.id = 'ui-dialog-root';
    root.innerHTML = dialogMarkup(opts);
    document.body.appendChild(root);
    const previous = document.activeElement;
    const input = root.querySelector('[data-dialog-input]');
    const confirmBtn = root.querySelector('[data-dialog-confirm]');

    const close = (value) => {
      document.removeEventListener('keydown', onKey, true);
      root.remove();
      try {
        previous?.focus?.();
      } catch {
        /* element gone */
      }
      resolve(value);
    };
    const confirm = () => {
      const v = onConfirm(root);
      if (v !== undefined) close(v);
    };
    const cancel = () => close(onCancel());
    // Capture phase + stopPropagation so an open sheet doesn't also close on Escape.
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        cancel();
      } else if (e.key === 'Enter' && !e.isComposing) {
        if (e.target?.matches?.('[data-dialog-cancel]')) return;
        e.preventDefault();
        e.stopPropagation();
        confirm();
      }
    };
    document.addEventListener('keydown', onKey, true);
    confirmBtn.addEventListener('click', confirm);
    root.querySelector('[data-dialog-cancel]').addEventListener('click', cancel);
    root.querySelector('[data-dialog-cancel-backdrop]').addEventListener('click', cancel);
    requestAnimationFrame(() => root.classList.add('show'));
    if (focusInput && input) {
      input.focus();
      input.select();
    } else {
      confirmBtn.focus();
    }
  });
}

/**
 * Async replacement for `window.confirm`. Resolves `true` on confirm, `false`
 * on cancel / Escape / backdrop. Resolves `false` outside a DOM.
 */
export function confirmDialog({
  title = 'Are you sure?',
  message = '',
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  tone = 'danger',
} = {}) {
  if (typeof document === 'undefined') return Promise.resolve(false);
  return openDialog(
    { title, message, confirmLabel, cancelLabel, tone },
    { onConfirm: () => true, onCancel: () => false, focusInput: false }
  );
}

/**
 * Async replacement for `window.prompt`. Resolves the entered string, or
 * `null` on cancel — callers MUST treat `null` as abort. With `required`,
 * an empty (whitespace-only) value keeps the dialog open. Resolves `null`
 * outside a DOM.
 */
export function promptDialog({
  title = '',
  message = '',
  placeholder = '',
  defaultValue = '',
  confirmLabel = 'OK',
  cancelLabel = 'Cancel',
  required = false,
} = {}) {
  if (typeof document === 'undefined') return Promise.resolve(null);
  return openDialog(
    {
      title,
      message,
      confirmLabel,
      cancelLabel,
      tone: 'accent',
      input: { placeholder, value: defaultValue },
    },
    {
      onConfirm: (root) => {
        const input = root.querySelector('[data-dialog-input]');
        const value = input.value;
        if (required && !value.trim()) {
          input.classList.add('ui-dialog-invalid');
          input.focus();
          return undefined;
        }
        return value;
      },
      onCancel: () => null,
      focusInput: true,
    }
  );
}

const armed = new WeakMap();

/**
 * Two-step inline confirm for a button's click handler:
 *   btn.addEventListener('click', () => { if (confirmInline(btn)) doIt(); });
 * First call arms the button (swaps its text to `label`, adds `.ui-armed`)
 * and returns false; a second call within `timeoutMs` restores the button
 * and returns true. After the timeout the button disarms itself.
 */
export function confirmInline(button, { label = 'Click again to confirm', timeoutMs = 3000 } = {}) {
  if (!button) return false;
  const state = armed.get(button);
  if (state) {
    clearTimeout(state.timer);
    armed.delete(button);
    button.textContent = state.text;
    button.classList.remove('ui-armed');
    return true;
  }
  const text = button.textContent;
  const timer = setTimeout(() => {
    armed.delete(button);
    button.textContent = text;
    button.classList.remove('ui-armed');
  }, timeoutMs);
  armed.set(button, { text, timer });
  button.textContent = label;
  button.classList.add('ui-armed');
  return false;
}
