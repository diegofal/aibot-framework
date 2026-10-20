/**
 * Parser for WhatsApp's "Export chat" text (Android and iOS, 12h and 24h,
 * Spanish and English). Pure: no I/O.
 *
 *   Android  `16/10/26, 08:22 - Name: text`
 *   iOS      `[16/10/26, 08:22:05] Name: text`
 *
 * Timestamps carry no time zone: they are the phone's local time, kept as a
 * naive `YYYY-MM-DDTHH:MM:SS` string (sortable as text).
 */

export interface WaMessage {
  /** Local, zone-less timestamp `YYYY-MM-DDTHH:MM:SS`. */
  ts: string;
  author: string;
  text: string;
}

export interface WaParseResult {
  messages: WaMessage[];
  /** Lines dropped as non-content. */
  skipped: { system: number; media: number; deleted: number };
  dateOrder: 'dmy' | 'mdy';
}

const DATE = String.raw`(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{2,4}),?\s(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\s*([aApP])\.?\s?[mM]\.?)?`;
const ANDROID_RE = new RegExp(`^${DATE}\\s[-–]\\s(.*)$`);
const IOS_RE = new RegExp(`^\\[${DATE}\\]\\s(.*)$`);

const INVISIBLE_RE = /[‎‏‪-‮⁦-⁩]/g;

const MEDIA_RE =
  /^(<?(media omitted|multimedia omitido|archivo omitido|medios omitidos)>?|(image|video|audio|sticker|gif|document|contact card) omitted|(imagen|video|audio|sticker|gif|documento|tarjeta de contacto) omitid[oa]|<(attached|adjunto):[^>]*>.*)$/i;
const DELETED_RE =
  /^(this message was deleted\.?|you deleted this message\.?|se eliminó este mensaje\.?|eliminaste este mensaje\.?)$/i;
const EDITED_RE = /\s*<(this message was edited|se editó este mensaje\.?)>\s*$/i;

interface RawHeader {
  a: number;
  b: number;
  year: number;
  hour: number;
  minute: number;
  second: number;
  ampm?: 'a' | 'p';
  ios: boolean;
  rest: string;
}

function matchHeader(line: string): RawHeader | undefined {
  const clean = line.replace(/^[‎‏]+/, '');
  const ios = IOS_RE.exec(clean);
  const m = ios ?? ANDROID_RE.exec(clean);
  if (!m) return undefined;
  const year = Number(m[3]);
  return {
    a: Number(m[1]),
    b: Number(m[2]),
    year: year < 100 ? 2000 + year : year,
    hour: Number(m[4]),
    minute: Number(m[5]),
    second: m[6] ? Number(m[6]) : 0,
    ampm: m[7] ? (m[7].toLowerCase() as 'a' | 'p') : undefined,
    ios: !!ios,
    rest: m[8],
  };
}

const pad = (n: number) => String(n).padStart(2, '0');

function toTs(h: RawHeader, order: 'dmy' | 'mdy'): string | undefined {
  const day = order === 'dmy' ? h.a : h.b;
  const month = order === 'dmy' ? h.b : h.a;
  if (month < 1 || month > 12 || day < 1 || day > 31) return undefined;
  let hour = h.hour;
  if (h.ampm) hour = (hour % 12) + (h.ampm === 'p' ? 12 : 0);
  if (hour > 23 || h.minute > 59 || h.second > 59) return undefined;
  return `${h.year}-${pad(month)}-${pad(day)}T${pad(hour)}:${pad(h.minute)}:${pad(h.second)}`;
}

function decideOrder(headers: RawHeader[]): 'dmy' | 'mdy' {
  if (headers.some((h) => h.a > 12)) return 'dmy';
  if (headers.some((h) => h.b > 12)) return 'mdy';
  const inversions = (order: 'dmy' | 'mdy') => {
    let prev = '';
    let count = 0;
    for (const h of headers) {
      const day = toTs(h, order)?.slice(0, 10) ?? '';
      if (day < prev) count++;
      prev = day;
    }
    return count;
  };
  return inversions('mdy') < inversions('dmy') ? 'mdy' : 'dmy';
}

function splitLines(text: string): string[] {
  return text.replace(/^﻿/, '').split(/\r?\n/);
}

/** Parse an export. Lines before the first header are ignored. */
export function parseWhatsAppExport(text: string): WaParseResult {
  const lines = splitLines(text);
  const headers = lines.map(matchHeader);
  const dateOrder = decideOrder(headers.filter((h): h is RawHeader => !!h));
  const skipped = { system: 0, media: 0, deleted: 0 };
  const messages: WaMessage[] = [];
  // The message the following continuation lines belong to; null after a dropped line.
  let current: WaMessage | null = null;

  for (let i = 0; i < lines.length; i++) {
    const h = headers[i];
    const ts = h ? toTs(h, dateOrder) : undefined;
    if (!h || !ts) {
      if (current) current.text += `\n${lines[i]}`;
      continue;
    }
    current = null;
    const sep = h.rest.indexOf(': ');
    if (sep <= 0) {
      skipped.system++;
      continue;
    }
    const author = h.rest.slice(0, sep).replace(INVISIBLE_RE, '').trim();
    const rawBody = h.rest.slice(sep + 2);
    const body = rawBody.replace(EDITED_RE, '').replace(INVISIBLE_RE, '').trim();
    if (MEDIA_RE.test(body)) {
      skipped.media++;
      continue;
    }
    if (DELETED_RE.test(body)) {
      skipped.deleted++;
      continue;
    }
    // iOS marks system notices (encryption, joins, subject changes) with a
    // leading LRM after the group name.
    if (h.ios && /^[‎‏]/.test(rawBody)) {
      skipped.system++;
      continue;
    }
    current = { ts, author, text: body };
    messages.push(current);
  }
  for (const m of messages) m.text = m.text.replace(INVISIBLE_RE, '').replace(/\s+$/, '');
  return { messages, skipped, dateOrder };
}

/**
 * True when the text reads like an export: a message header within its first
 * 30 non-empty lines and a second one anywhere after it (a one-line file needs
 * only the one). The second may come late: a long first message used to push
 * it out of a fixed 30-line window.
 */
export function looksLikeWhatsAppExport(text: string): boolean {
  const lines = splitLines(text).filter((l) => l.trim());
  const first = lines.slice(0, 30).findIndex((l) => matchHeader(l));
  if (first < 0) return false;
  return lines.length === 1 || lines.slice(first + 1).some((l) => matchHeader(l));
}

const EXPORT_NAME_RE = /whatsapp|^_chat\.txt$/i;

/** A file the operator would send from WhatsApp's "Export chat": a named .txt or any .zip. */
export function isWhatsAppExportFileName(fileName: string | undefined): boolean {
  if (!fileName) return false;
  const lower = fileName.toLowerCase();
  if (lower.endsWith('.zip')) return true;
  return lower.endsWith('.txt') && EXPORT_NAME_RE.test(fileName);
}

const NAME_PREFIX_RE =
  /^(whatsapp chat with|whatsapp chat -|chat de whatsapp con|conversa do whatsapp com|whatsapp-chat mit)\s*/i;

/** "WhatsApp Chat with 3B Padres.txt" → "3B Padres"; undefined when the name says nothing. */
export function groupNameFromFileName(fileName: string | undefined): string | undefined {
  if (!fileName) return undefined;
  const name = fileName
    .replace(/\.(txt|zip)$/i, '')
    .replace(NAME_PREFIX_RE, '')
    .replace(/\s*\(\d+\)$/, '')
    .trim();
  if (!name || /^_?chat$/i.test(name)) return undefined;
  return name;
}

/** Filesystem-safe slug for a group name. */
export function groupSlug(group: string): string {
  const slug = group
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/, '');
  return slug || 'group';
}
