import { describe, expect, it } from 'bun:test';
import { redactPii } from '../src/redact-pii';

describe('redactPii', () => {
  it('should redact email addresses', () => {
    expect(redactPii('contact me at diego@example.com please')).toBe(
      'contact me at [REDACTED:email] please'
    );
  });

  it('should redact phone numbers with country code', () => {
    expect(redactPii('call +54 11 1234-5678 now')).toBe('call [REDACTED:phone] now');
  });

  it('should redact Telegram bot tokens', () => {
    expect(
      redactPii('token=8440919102:AAF-l6DIR-SZAvE1sroyvAlNRSRXDJ0g76M')
    ).toBe('token=[REDACTED:telegram_token]');
  });

  it('should redact Bearer tokens', () => {
    expect(
      redactPii('Authorization: Bearer abcdefghijklmnopqrstuvwxyz1234567890')
    ).toBe('Authorization: [REDACTED:bearer]');
  });

  it('should redact long hex keys', () => {
    const key = 'a'.repeat(64);
    expect(redactPii(`key=${key}`)).toBe('key=[REDACTED:hex_key]');
  });

  it('should leave short hex strings untouched (likely a git SHA)', () => {
    expect(redactPii('commit abc1234')).toBe('commit abc1234');
  });

  it('should leave non-string values untouched', () => {
    expect(redactPii(42)).toBe(42);
    expect(redactPii(true)).toBe(true);
    expect(redactPii(null)).toBe(null);
    expect(redactPii(undefined)).toBe(undefined);
  });

  it('should handle multiple PII patterns in one string', () => {
    const out = redactPii('from diego@example.com token 8440919102:AAF-l6DIR-SZAvE1sroyvAlNRSRXDJ0g76M');
    expect(out).toContain('[REDACTED:email]');
    expect(out).toContain('[REDACTED:telegram_token]');
    expect(out).not.toContain('diego@example.com');
    expect(out).not.toContain('8440919102:AAF');
  });

  it('should not touch plain text without PII', () => {
    expect(redactPii('Agent loop completed for bot default')).toBe(
      'Agent loop completed for bot default'
    );
  });
});