/**
 * Centralized date helpers that respect process.env.TZ.
 *
 * `sv-SE` locale produces ISO-like formats (YYYY-MM-DD, HH:MM) using the
 * system timezone — unlike `toISOString()` which always returns UTC.
 */

/** Returns local date as YYYY-MM-DD */
export function localDateStr(date: Date = new Date()): string {
  return date.toLocaleDateString('sv-SE'); // YYYY-MM-DD
}

/** Returns local time as HH:MM */
export function localTimeStr(date: Date = new Date()): string {
  return date.toLocaleTimeString('sv-SE', { hour: '2-digit', minute: '2-digit' }); // HH:MM
}
