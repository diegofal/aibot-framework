/**
 * Light / dark theme.
 *
 * Resolution order: explicit choice stored under THEME_KEY, then the OS
 * preference, then dark (the dashboard's native look). The choice is stamped
 * on `<html data-theme>`; `style.css` keys its tokens off that attribute.
 * `index.html` carries a tiny inline bootstrap that reads the same key before
 * CSS paints, so there is no flash on reload — keep the key in sync there.
 */
export const THEME_KEY = 'aibot.theme';
export const THEMES = ['dark', 'light'];

export function isTheme(value) {
  return THEMES.includes(value);
}

/** Pure: which theme applies given a stored value and the OS preference. */
export function resolveTheme(stored, systemPrefersLight = false) {
  if (isTheme(stored)) return stored;
  return systemPrefersLight ? 'light' : 'dark';
}

export function nextTheme(current) {
  return current === 'dark' ? 'light' : 'dark';
}

/** Label for the toggle button: shows what you will switch TO. */
export function themeToggleLabel(current) {
  return current === 'dark' ? '☼ Light' : '☾ Dark';
}

export function readStoredTheme(storage = safeStorage()) {
  try {
    const v = storage?.getItem(THEME_KEY);
    return isTheme(v) ? v : null;
  } catch {
    return null;
  }
}

export function storeTheme(theme, storage = safeStorage()) {
  try {
    if (isTheme(theme)) storage?.setItem(THEME_KEY, theme);
  } catch {
    /* private mode or blocked storage: the choice just does not persist */
  }
}

function safeStorage() {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

function systemPrefersLight() {
  try {
    return typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: light)').matches;
  } catch {
    return false;
  }
}

export function currentTheme(doc = globalThis.document) {
  const stamped = doc?.documentElement?.dataset?.theme;
  if (isTheme(stamped)) return stamped;
  return resolveTheme(readStoredTheme(), systemPrefersLight());
}

export function applyTheme(theme, doc = globalThis.document) {
  if (!doc?.documentElement || !isTheme(theme)) return;
  doc.documentElement.dataset.theme = theme;
}

/** Flip the theme, persist it, and refresh any toggle buttons. */
export function toggleTheme() {
  const next = nextTheme(currentTheme());
  applyTheme(next);
  storeTheme(next);
  refreshToggles(next);
  return next;
}

function refreshToggles(theme) {
  if (typeof document === 'undefined') return;
  document.querySelectorAll('[data-theme-toggle]').forEach((btn) => {
    btn.textContent = themeToggleLabel(theme);
    btn.setAttribute('aria-label', `Switch to ${nextTheme(theme)} theme`);
  });
}

/** Stamp the resolved theme and wire every `[data-theme-toggle]` button. */
export function initTheme() {
  if (typeof document === 'undefined') return;
  const theme = currentTheme();
  applyTheme(theme);
  refreshToggles(theme);
  document.querySelectorAll('[data-theme-toggle]').forEach((btn) => {
    if (btn.dataset.themeWired) return;
    btn.dataset.themeWired = '1';
    btn.addEventListener('click', toggleTheme);
  });
}
