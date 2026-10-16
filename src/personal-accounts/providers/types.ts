import type {
  CalendarEvent,
  MailMessage,
  MailSummary,
  NewEventInput,
  PersonalProvider,
} from '../types';

/** An authorized JSON call for one account (the service adds the token and retries a 401 once). */
export type AccountApi = <T>(
  url: string,
  init?: { method?: string; json?: unknown; headers?: Record<string, string> }
) => Promise<T>;

type Unlabeled<T> = Omit<T, 'account' | 'accountLabel' | 'provider'>;
export type RawEvent = Unlabeled<CalendarEvent>;
export type RawMail = Unlabeled<MailSummary>;
export type RawMailMessage = Unlabeled<MailMessage>;

/** What a provider plugs into the service: OAuth endpoints + calendar and mail calls. */
export interface ProviderClient {
  id: PersonalProvider;
  authorizeUrl: string;
  tokenUrl: string;
  scopes: string[];
  /** Extra query parameters for the consent URL. */
  authParams: Record<string, string>;
  clientIdEnv: string;
  clientSecretEnv: string;
  /** The mailbox address of the signed-in user. */
  fetchEmail(api: AccountApi): Promise<string>;
  listEvents(api: AccountApi, from: Date, to: Date): Promise<RawEvent[]>;
  createEvent(api: AccountApi, input: NewEventInput): Promise<RawEvent>;
  searchMail(api: AccountApi, query: string, limit: number): Promise<RawMail[]>;
  readMail(api: AccountApi, id: string): Promise<RawMailMessage>;
}

/** Normalize a provider timestamp to an ISO instant; `assumeUtc` for zone-less strings. */
export function toIso(value: string | undefined, assumeUtc = false): string {
  if (!value) return new Date(0).toISOString();
  let v = value.replace(/(\.\d{3})\d+/, '$1');
  if (assumeUtc && !/(Z|[+-]\d{2}:?\d{2})$/.test(v)) v = `${v}Z`;
  const t = Date.parse(v);
  return Number.isFinite(t) ? new Date(t).toISOString() : new Date(0).toISOString();
}
