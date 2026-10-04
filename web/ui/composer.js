/**
 * Message boxes that grow with what you type. They start at about four lines,
 * follow the content up to 40% of the viewport, then scroll. Used by the shared
 * thread composer (Agent Home, Conversations, Inbox, Productions chat) and the
 * other places the operator writes free text (Needs You reply, feedback, notes).
 *
 * Text set from code (`.value = …`) fires no `input` event: call
 * `fitComposer(textarea)` after it. Overflow is never hidden, so a box whose
 * size went stale scrolls instead of clipping.
 */

export const COMPOSER_MIN_PX = 88;
export const COMPOSER_MAX_VH = 40;
const FALLBACK_MAX_PX = 400;

/** Options given at attach, per textarea (WeakMap: nothing to clean up). */
const optionsOf = new WeakMap();

/** Clamp a textarea's content height to [minPx, maxPx] (min wins if they cross). */
export function composerHeight(scrollHeight, { minPx = COMPOSER_MIN_PX, maxPx } = {}) {
  const top = Number.isFinite(maxPx) ? maxPx : FALLBACK_MAX_PX;
  if (!Number.isFinite(scrollHeight)) return minPx;
  return Math.max(minPx, Math.min(top, scrollHeight));
}

function viewportMaxPx() {
  const h = typeof window !== 'undefined' ? window.innerHeight : Number.NaN;
  return Number.isFinite(h) && h > 0 ? Math.round((h * COMPOSER_MAX_VH) / 100) : FALLBACK_MAX_PX;
}

/** Size `textarea` to its current content. A missing element is a no-op. */
export function fitComposer(textarea) {
  if (!textarea) return;
  const { minPx = COMPOSER_MIN_PX, maxPx } = optionsOf.get(textarea) ?? {};
  const top = Number.isFinite(maxPx) ? maxPx : viewportMaxPx();
  textarea.style.height = 'auto';
  textarea.style.height = `${composerHeight(textarea.scrollHeight, { minPx, maxPx: top })}px`;
  textarea.style.overflowY = 'auto';
}

/** Size `textarea` to its content now and on every input. A missing element is a no-op. */
export function attachAutoGrow(textarea, options = {}) {
  if (!textarea) return;
  optionsOf.set(textarea, options);
  textarea.addEventListener('input', () => fitComposer(textarea));
  fitComposer(textarea);
}
