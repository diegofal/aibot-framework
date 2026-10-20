/**
 * Personal accounts (docs/plans/personal-organizer-plan.md, P1a): the
 * operator's Google and Microsoft accounts, for calendar and mail.
 */

export type PersonalProvider = 'google' | 'microsoft';

export const PERSONAL_PROVIDERS: readonly PersonalProvider[] = ['google', 'microsoft'];

export type AccountStatus = 'ok' | 'reauth-needed';

/** What `accounts.json` keeps per account. The refresh token never leaves the service. */
export interface StoredAccount {
  slug: string;
  provider: PersonalProvider;
  email: string;
  label: string;
  refreshToken: string;
  scopes: string[];
  addedAt: string;
  status: AccountStatus;
  /** Why the account needs reconnecting (the provider's error), when it does. */
  lastError?: string;
}

/** An account as the dashboard and the tools see it. */
export type PersonalAccountView = Omit<StoredAccount, 'refreshToken'>;

export interface CalendarEvent {
  id: string;
  /** Account slug. */
  account: string;
  accountLabel: string;
  provider: PersonalProvider;
  title: string;
  /** ISO instant (UTC). All-day events start at the UTC midnight of their date. */
  start: string;
  end: string;
  allDay: boolean;
  location?: string;
  attendees?: string[];
  url?: string;
}

export interface NewEventInput {
  title: string;
  start: Date;
  end: Date;
  attendees?: string[];
}

export interface MailSummary {
  id: string;
  account: string;
  accountLabel: string;
  provider: PersonalProvider;
  from: string;
  subject: string;
  /** ISO instant. */
  date: string;
  snippet: string;
}

export interface MailMessage extends MailSummary {
  to: string;
  body: string;
}

/** One account that could not answer; the others still did. */
export interface AccountProblem {
  account: string;
  accountLabel: string;
  error: string;
  /** The account must be connected again from the dashboard. */
  reauth: boolean;
}
