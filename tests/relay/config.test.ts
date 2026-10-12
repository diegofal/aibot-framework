import { describe, expect, it } from 'bun:test';
import { BotConfigSchema } from '../../src/config';
import { resolveRelayConfig } from '../../src/relay';

const base = { id: 'b1', name: 'Bot', skills: [] };

describe('bots[].relay', () => {
  it('is optional', () => {
    expect(BotConfigSchema.parse(base).relay).toBeUndefined();
  });

  it('fills defaults for a partial block', () => {
    expect(BotConfigSchema.parse({ ...base, relay: {} }).relay).toEqual({
      enabled: true,
      peerToPeer: false,
      locale: 'es',
    });
  });

  it('rejects an unknown locale', () => {
    expect(() => BotConfigSchema.parse({ ...base, relay: { locale: 'fr' } })).toThrow();
  });
});

describe('resolveRelayConfig', () => {
  it('returns the defaults when the bot has no relay block', () => {
    expect(resolveRelayConfig(undefined)).toEqual({
      enabled: true,
      peerToPeer: false,
      locale: 'es',
    });
    expect(resolveRelayConfig({})).toEqual({ enabled: true, peerToPeer: false, locale: 'es' });
  });

  it('keeps what the bot sets', () => {
    expect(
      resolveRelayConfig({ relay: { enabled: false, peerToPeer: true, locale: 'en' } })
    ).toEqual({ enabled: false, peerToPeer: true, locale: 'en' });
  });
});
