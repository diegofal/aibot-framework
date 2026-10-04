/**
 * Message boxes that grow with what you type. They start at about four lines,
 * follow the content up to 40% of the viewport, then scroll. Used by the shared
 * thread composer (Agent Home, Conversations, Inbox, Productions chat) and the
 * other places the operator writes free text (Needs You reply, feedback, notes).
 */

export const COMPOSER_MIN_PX = 88;
export const COMPOSER_MAX_VH = 40;
const FALLBACK_MAX_PX = 400;

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

/** Size `textarea` to its content now and on every input. A missing element is a no-op. */
export function attachAutoGrow(textarea, { minPx = COMPOSER_MIN_PX, maxPx } = {}) {
  if (!textarea) return;
  const resize = () => {
    const top = Number.isFinite(maxPx) ? maxPx : viewportMaxPx();
    textarea.style.height = 'auto';
    const h = composerHeight(textarea.scrollHeight, { minPx, maxPx: top });
    textarea.style.height = `${h}px`;
    textarea.style.overflowY = textarea.scrollHeight > top ? 'auto' : 'hidden';
  };
  textarea.addEventListener('input', resize);
  resize();
}
