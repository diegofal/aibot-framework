import { cx } from './escape.js';

const WIDTHS = [92, 68, 84, 55, 76, 40];

/**
 * Loading placeholder: `lines` grey bars with deterministic widths so a
 * re-render never jitters. `block` renders one tall box instead.
 */
export function skeleton({ lines = 3, block = false, height, class: cls } = {}) {
  if (block) {
    const h = height ? ` style="height:${Number(height) || 0}px"` : '';
    return `<div class="${cx('ui-skeleton', 'ui-skeleton-block', cls)}" aria-hidden="true"${h}></div>`;
  }
  const n = Math.max(0, Math.floor(lines));
  const rows = Array.from(
    { length: n },
    (_, i) => `<div class="ui-skeleton-line" style="width:${WIDTHS[i % WIDTHS.length]}%"></div>`
  ).join('');
  return `<div class="${cx('ui-skeleton', cls)}" aria-hidden="true">${rows}</div>`;
}
