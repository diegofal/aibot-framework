/**
 * UI component layer for the dashboard.
 *
 * Every export here that returns a string is a pure function of its
 * arguments and can be imported from Bun tests (`tests/web/ui-components.test.ts`).
 * The DOM-touching helpers (`showToast`, `undoable`, `openSheet`,
 * `confirmDialog`, `promptDialog`, `initTheme`) guard on
 * `document` and are no-ops elsewhere.
 */
export { avatar, avatarHue, hashSeed, initials } from './avatar.js';
export { BADGE_TONES, badge, toneFor } from './badge.js';
export { card } from './card.js';
export { dataTable } from './data-table.js';
export { emptyState } from './empty-state.js';
export { cx, esc } from './escape.js';
export { deltaLabel, kpi } from './kpi.js';
export { initMenus, rowMenu } from './menu.js';
export { radar, radarPoints } from './radar.js';
export { closeSheet, openSheet, sheetMarkup } from './sheet.js';
export { skeleton } from './skeleton.js';
export { sparkline, sparklinePath } from './sparkline.js';
export { tabs } from './tabs.js';
export {
  THEME_KEY,
  THEMES,
  applyTheme,
  currentTheme,
  initTheme,
  nextTheme,
  readStoredTheme,
  resolveTheme,
  storeTheme,
  themeToggleLabel,
  toggleTheme,
} from './theme.js';
export { confirmDialog, confirmInline, dialogMarkup, promptDialog } from './dialog.js';
export { flushUndoables, showToast, toastMarkup, undoable } from './toast.js';
