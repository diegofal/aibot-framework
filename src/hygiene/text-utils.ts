/**
 * Pure text helpers shared by the hygiene routines. No I/O.
 */

const STOPWORDS = new Set([
  // es
  'el',
  'la',
  'los',
  'las',
  'un',
  'una',
  'unos',
  'unas',
  'de',
  'del',
  'al',
  'a',
  'y',
  'o',
  'u',
  'en',
  'con',
  'por',
  'para',
  'que',
  'se',
  'su',
  'sus',
  'mi',
  'mis',
  'lo',
  'le',
  'les',
  'es',
  'ser',
  'este',
  'esta',
  'esto',
  'estos',
  'estas',
  'como',
  'mas',
  'pero',
  'sin',
  'sobre',
  // en
  'the',
  'a',
  'an',
  'and',
  'or',
  'of',
  'to',
  'in',
  'on',
  'for',
  'with',
  'by',
  'at',
  'from',
  'is',
  'are',
  'be',
  'this',
  'that',
  'these',
  'those',
  'it',
  'its',
  'as',
  'my',
  'our',
  'your',
]);

/** Lowercase, strip accents and punctuation, collapse whitespace. */
export function normalizeTitle(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Normalised tokens minus es/en stopwords. */
export function titleTokens(text: string): string[] {
  return normalizeTitle(text)
    .split(' ')
    .filter((t) => t.length > 0 && !STOPWORDS.has(t));
}

/** Jaccard similarity of two token lists (as sets). 0 when both are empty. */
export function jaccard(a: Iterable<string>, b: Iterable<string>): number {
  const setA = new Set(a);
  const setB = new Set(b);
  if (setA.size === 0 && setB.size === 0) return 0;
  let intersection = 0;
  for (const t of setA) if (setB.has(t)) intersection++;
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * Similarity of two documents after normalisation: 1 when the normalised
 * text is identical, otherwise Jaccard over the token sets.
 */
export function textSimilarity(a: string, b: string): number {
  const na = normalizeTitle(a);
  const nb = normalizeTitle(b);
  if (na === nb) return 1;
  return jaccard(na.split(' ').filter(Boolean), nb.split(' ').filter(Boolean));
}

const ISO_DATE_RE = /\b(\d{4})-(\d{2})-(\d{2})\b/g;
const DMY_DATE_RE = /\b(\d{1,2})\/(\d{1,2})(?:\/(\d{4}|\d{2}))?\b/g;

function validDate(y: number, m: number, d: number): Date | null {
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  const date = new Date(y, m - 1, d, 12, 0, 0);
  if (date.getFullYear() !== y || date.getMonth() !== m - 1 || date.getDate() !== d) return null;
  return date;
}

/**
 * Extract calendar dates written as YYYY-MM-DD or DD/MM[/YYYY]. A DD/MM date
 * without a year is assumed to belong to the reference year.
 */
export function extractDates(text: string, ref: Date): Date[] {
  const out: Array<{ index: number; date: Date }> = [];
  for (const m of text.matchAll(ISO_DATE_RE)) {
    const date = validDate(Number(m[1]), Number(m[2]), Number(m[3]));
    if (date) out.push({ index: m.index ?? 0, date });
  }
  for (const m of text.matchAll(DMY_DATE_RE)) {
    const yearRaw = m[3];
    const year = yearRaw
      ? yearRaw.length === 2
        ? 2000 + Number(yearRaw)
        : Number(yearRaw)
      : ref.getFullYear();
    const date = validDate(year, Number(m[2]), Number(m[1]));
    if (date) out.push({ index: m.index ?? 0, date });
  }
  return out.sort((a, b) => a.index - b.index).map((x) => x.date);
}

/** Whole days from `from` to `to` (floored). */
export function daysBetween(from: Date, to: Date): number {
  return Math.floor((to.getTime() - from.getTime()) / 86_400_000);
}

/** YYYY-MM-DD in local time (same format as src/date-utils localDateStr). */
export function localDate(date: Date): string {
  return date.toLocaleDateString('sv-SE');
}

/** HH:MM in local time. */
export function localTime(date: Date): string {
  return date.toLocaleTimeString('sv-SE', { hour: '2-digit', minute: '2-digit' });
}
