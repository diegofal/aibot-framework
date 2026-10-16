/**
 * Google: Calendar API v3 (primary calendar) + Gmail API, OAuth with
 * `access_type=offline` and `prompt=consent` so every login returns a
 * refresh token.
 */
import type { NewEventInput } from '../types';
import { type AccountApi, type ProviderClient, type RawEvent, toIso } from './types';

const CAL = 'https://www.googleapis.com/calendar/v3/calendars/primary/events';
const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me/messages';

interface GEventTime {
  dateTime?: string;
  date?: string;
}

interface GEvent {
  id: string;
  status?: string;
  summary?: string;
  start?: GEventTime;
  end?: GEventTime;
  location?: string;
  attendees?: Array<{ email?: string }>;
  htmlLink?: string;
}

interface GHeader {
  name: string;
  value: string;
}

interface GPart {
  mimeType?: string;
  headers?: GHeader[];
  body?: { data?: string };
  parts?: GPart[];
}

interface GMessage {
  id: string;
  snippet?: string;
  internalDate?: string;
  payload?: GPart;
}

function eventTime(t: GEventTime | undefined): { iso: string; allDay: boolean } {
  if (t?.dateTime) return { iso: toIso(t.dateTime), allDay: false };
  if (t?.date) return { iso: toIso(`${t.date}T00:00:00Z`), allDay: true };
  return { iso: toIso(undefined), allDay: false };
}

function toEvent(e: GEvent): RawEvent {
  const start = eventTime(e.start);
  const attendees = (e.attendees ?? []).map((a) => a.email).filter((x): x is string => !!x);
  return {
    id: e.id,
    title: e.summary ?? '(no title)',
    start: start.iso,
    end: eventTime(e.end).iso,
    allDay: start.allDay,
    ...(e.location ? { location: e.location } : {}),
    ...(attendees.length ? { attendees } : {}),
    ...(e.htmlLink ? { url: e.htmlLink } : {}),
  };
}

const header = (m: GMessage, name: string) =>
  m.payload?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? '';

const messageDate = (m: GMessage) =>
  m.internalDate ? new Date(Number(m.internalDate)).toISOString() : toIso(header(m, 'Date'));

const decode = (data: string) => Buffer.from(data, 'base64url').toString('utf8');

function findPart(part: GPart | undefined, mime: string): GPart | undefined {
  if (!part) return undefined;
  if (part.mimeType === mime && part.body?.data) return part;
  for (const p of part.parts ?? []) {
    const hit = findPart(p, mime);
    if (hit) return hit;
  }
  return undefined;
}

/** text/plain when there is one; otherwise the HTML with tags dropped. */
export function gmailBody(payload: GPart | undefined): string {
  const plain = findPart(payload, 'text/plain');
  if (plain?.body?.data) return decode(plain.body.data);
  const html = findPart(payload, 'text/html');
  if (html?.body?.data)
    return decode(html.body.data)
      .replace(/<(style|script)[\s\S]*?<\/\1>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+\n/g, '\n')
      .trim();
  return payload?.body?.data ? decode(payload.body.data) : '';
}

export const googleProvider: ProviderClient = {
  id: 'google',
  authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
  tokenUrl: 'https://oauth2.googleapis.com/token',
  scopes: [
    'openid',
    'email',
    'https://www.googleapis.com/auth/calendar.readonly',
    'https://www.googleapis.com/auth/calendar.events',
    'https://www.googleapis.com/auth/gmail.readonly',
  ],
  authParams: { access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true' },
  clientIdEnv: 'GOOGLE_OAUTH_CLIENT_ID',
  clientSecretEnv: 'GOOGLE_OAUTH_CLIENT_SECRET',

  async fetchEmail(api) {
    const me = await api<{ email?: string }>('https://openidconnect.googleapis.com/v1/userinfo');
    return me.email ?? '';
  },

  async listEvents(api, from, to) {
    const q = new URLSearchParams({
      timeMin: from.toISOString(),
      timeMax: to.toISOString(),
      singleEvents: 'true',
      orderBy: 'startTime',
      maxResults: '250',
    });
    const res = await api<{ items?: GEvent[] }>(`${CAL}?${q}`);
    return (res.items ?? []).filter((e) => e.status !== 'cancelled').map(toEvent);
  },

  async createEvent(api: AccountApi, input: NewEventInput) {
    const e = await api<GEvent>(CAL, {
      method: 'POST',
      json: {
        summary: input.title,
        start: { dateTime: input.start.toISOString() },
        end: { dateTime: input.end.toISOString() },
        ...(input.attendees?.length
          ? { attendees: input.attendees.map((email) => ({ email })) }
          : {}),
      },
    });
    return toEvent(e);
  },

  async searchMail(api, query, limit) {
    const q = new URLSearchParams({ q: query, maxResults: String(limit) });
    const list = await api<{ messages?: Array<{ id: string }> }>(`${GMAIL}?${q}`);
    const meta = new URLSearchParams([
      ['format', 'metadata'],
      ['metadataHeaders', 'From'],
      ['metadataHeaders', 'Subject'],
      ['metadataHeaders', 'Date'],
    ]);
    const messages = await Promise.all(
      (list.messages ?? [])
        .slice(0, limit)
        .map((m) => api<GMessage>(`${GMAIL}/${encodeURIComponent(m.id)}?${meta}`))
    );
    return messages.map((m) => ({
      id: m.id,
      from: header(m, 'From'),
      subject: header(m, 'Subject'),
      date: messageDate(m),
      snippet: m.snippet ?? '',
    }));
  },

  async readMail(api, id) {
    const m = await api<GMessage>(`${GMAIL}/${encodeURIComponent(id)}?format=full`);
    return {
      id: m.id,
      from: header(m, 'From'),
      to: header(m, 'To'),
      subject: header(m, 'Subject'),
      date: messageDate(m),
      snippet: m.snippet ?? '',
      body: gmailBody(m.payload),
    };
  },
};
