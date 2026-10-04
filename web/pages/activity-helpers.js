/**
 * Activity page helpers. Pure; covered by `tests/web/activity-helpers.test.ts`.
 */
export const ACTIVITY_BASE = '#/insights/activity';

/**
 * Canonical activity hash with `tab` set (omitted for the default `events`
 * tab). Other query params survive.
 */
export function activityTabHash(currentHash, tab) {
  const h = String(currentHash ?? '');
  const q = h.includes('?') ? h.slice(h.indexOf('?') + 1) : '';
  const params = new URLSearchParams(q);
  if (!tab || tab === 'events') params.delete('tab');
  else params.set('tab', tab);
  const qs = params.toString();
  return qs ? `${ACTIVITY_BASE}?${qs}` : ACTIVITY_BASE;
}
