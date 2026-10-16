/**
 * Microsoft: Graph (`/me/calendarView`, `/me/events`, `/me/messages`) with
 * Entra ID OAuth v2 on the `common` tenant (personal and work accounts) and
 * `offline_access` for a refresh token. Graph rotates refresh tokens; the
 * service persists the new one on every refresh.
 */
import type { NewEventInput } from '../types';
import { type AccountApi, type ProviderClient, type RawEvent, toIso } from './types';

const GRAPH = 'https://graph.microsoft.com/v1.0/me';
const UTC = { Prefer: 'outlook.timezone="UTC"' };

interface MsTime {
  dateTime?: string;
  timeZone?: string;
}

interface MsEvent {
  id: string;
  subject?: string;
  start?: MsTime;
  end?: MsTime;
  isAllDay?: boolean;
  isCancelled?: boolean;
  location?: { displayName?: string };
  attendees?: Array<{ emailAddress?: { address?: string } }>;
  webLink?: string;
}

interface MsAddress {
  emailAddress?: { name?: string; address?: string };
}

interface MsMessage {
  id: string;
  subject?: string;
  from?: MsAddress;
  toRecipients?: MsAddress[];
  receivedDateTime?: string;
  bodyPreview?: string;
  body?: { contentType?: string; content?: string };
}

function toEvent(e: MsEvent): RawEvent {
  const attendees = (e.attendees ?? [])
    .map((a) => a.emailAddress?.address)
    .filter((x): x is string => !!x);
  return {
    id: e.id,
    title: e.subject || '(no title)',
    start: toIso(e.start?.dateTime, true),
    end: toIso(e.end?.dateTime, true),
    allDay: e.isAllDay === true,
    ...(e.location?.displayName ? { location: e.location.displayName } : {}),
    ...(attendees.length ? { attendees } : {}),
    ...(e.webLink ? { url: e.webLink } : {}),
  };
}

function address(a: MsAddress | undefined): string {
  const name = a?.emailAddress?.name;
  const addr = a?.emailAddress?.address ?? '';
  return name && name !== addr ? `${name} <${addr}>` : addr;
}

/** Graph wants a zone-less local time plus a zone: send UTC. */
const graphTime = (d: Date) => ({ dateTime: d.toISOString().replace(/Z$/, ''), timeZone: 'UTC' });

export const microsoftProvider: ProviderClient = {
  id: 'microsoft',
  authorizeUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
  tokenUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
  scopes: [
    'openid',
    'email',
    'profile',
    'offline_access',
    'User.Read',
    'Calendars.ReadWrite',
    'Mail.Read',
  ],
  authParams: { response_mode: 'query', prompt: 'select_account' },
  clientIdEnv: 'MICROSOFT_OAUTH_CLIENT_ID',
  clientSecretEnv: 'MICROSOFT_OAUTH_CLIENT_SECRET',

  async fetchEmail(api) {
    const me = await api<{ mail?: string; userPrincipalName?: string }>(
      `${GRAPH}?$select=mail,userPrincipalName`
    );
    return me.mail || me.userPrincipalName || '';
  },

  async listEvents(api, from, to) {
    const q = new URLSearchParams({
      startDateTime: from.toISOString(),
      endDateTime: to.toISOString(),
      $top: '250',
      $orderby: 'start/dateTime',
      $select: 'id,subject,start,end,isAllDay,isCancelled,location,attendees,webLink',
    });
    const res = await api<{ value?: MsEvent[] }>(`${GRAPH}/calendarView?${q}`, { headers: UTC });
    return (res.value ?? []).filter((e) => !e.isCancelled).map(toEvent);
  },

  async createEvent(api: AccountApi, input: NewEventInput) {
    const e = await api<MsEvent>(`${GRAPH}/events`, {
      method: 'POST',
      headers: UTC,
      json: {
        subject: input.title,
        start: graphTime(input.start),
        end: graphTime(input.end),
        ...(input.attendees?.length
          ? {
              attendees: input.attendees.map((addr) => ({
                emailAddress: { address: addr },
                type: 'required',
              })),
            }
          : {}),
      },
    });
    return toEvent(e);
  },

  async searchMail(api, query, limit) {
    const q = new URLSearchParams({
      $search: `"${query.replace(/"/g, '')}"`,
      $top: String(limit),
      $select: 'id,subject,from,receivedDateTime,bodyPreview',
    });
    const res = await api<{ value?: MsMessage[] }>(`${GRAPH}/messages?${q}`);
    return (res.value ?? []).map((m) => ({
      id: m.id,
      from: address(m.from),
      subject: m.subject ?? '',
      date: toIso(m.receivedDateTime),
      snippet: m.bodyPreview ?? '',
    }));
  },

  async readMail(api, id) {
    const q = new URLSearchParams({
      $select: 'id,subject,from,toRecipients,receivedDateTime,bodyPreview,body',
    });
    const m = await api<MsMessage>(`${GRAPH}/messages/${encodeURIComponent(id)}?${q}`, {
      headers: { Prefer: 'outlook.body-content-type="text"' },
    });
    return {
      id: m.id,
      from: address(m.from),
      to: (m.toRecipients ?? []).map(address).join(', '),
      subject: m.subject ?? '',
      date: toIso(m.receivedDateTime),
      snippet: m.bodyPreview ?? '',
      body: m.body?.content ?? '',
    };
  },
};
