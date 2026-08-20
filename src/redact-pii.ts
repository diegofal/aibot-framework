/**
 * PII redaction helpers for log messages.
 *
 * Pino's `redact` option masks object fields by path, but it cannot reach
 * into the free-form `msg` string or into nested string values. This module
 * provides regex-based scrubbers that are applied to the formatted message
 * before it reaches the log file or the dashboard stream.
 */

const EMAIL_RE = /\b[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}\b/g;

// International and AR/MX phone numbers: +CC followed by 8-15 digits, with
// optional spaces/dashes. The leading + is required to avoid mangling
// version numbers or IDs that happen to be long digit runs.
const PHONE_RE = /\+\d[\d\s-]{7,14}\d\b/g;

// Telegram bot tokens: <numeric>:<35-char alphanumeric-hyphen-underscore>
const TELEGRAM_TOKEN_RE = /\b\d{8,12}:[A-Za-z0-9_-]{30,40}\b/g;

// Long hex runs that look like API keys (64+ hex chars, no spaces).
const HEX_KEY_RE = /\b[a-fA-F0-9]{64,}\b/g;

// Bearer tokens in inline form.
const BEARER_RE = /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/gi;

const SCRUBBERS: Array<{ re: RegExp; label: string }> = [
  { re: TELEGRAM_TOKEN_RE, label: '[REDACTED:telegram_token]' },
  { re: BEARER_RE, label: '[REDACTED:bearer]' },
  { re: EMAIL_RE, label: '[REDACTED:email]' },
  { re: PHONE_RE, label: '[REDACTED:phone]' },
  { re: HEX_KEY_RE, label: '[REDACTED:hex_key]' },
];

/**
 * Mask PII patterns inside a string, returning the scrubbed value. The input
 * is returned as-is when it is not a string (numbers, booleans, null are all
 * common in log metadata).
 */
export function redactPii(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  let out = value;
  for (const { re, label } of SCRUBBERS) {
    out = out.replace(re, label);
  }
  return out;
}