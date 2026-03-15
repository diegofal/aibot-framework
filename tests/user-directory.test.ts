import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UserDirectory } from '../src/bot/user-directory';
import type { InboundMessage } from '../src/channel/types';

const silentLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  child: () => silentLogger,
} as any;

function makeInbound(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    messageId: 'msg-1',
    channelKind: 'telegram',
    text: 'hello',
    chatId: '12345',
    chatType: 'private',
    sender: { id: '12345', firstName: 'Diego', username: 'diego_user' },
    timestamp: Date.now(),
    ...overrides,
  };
}

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'ud-test-'));
});

afterAll(() => {
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {}
});

describe('UserDirectory', () => {
  test('track() creates a new contact from telegram inbound', () => {
    const ud = new UserDirectory(tmpDir, silentLogger);
    const entry = ud.track('bot1', makeInbound());

    expect(entry.displayName).toBe('Diego');
    expect(entry.channels).toHaveLength(1);
    expect(entry.channels[0].kind).toBe('telegram');
    expect(entry.channels[0].address).toBe('12345');
    expect(entry.channels[0].username).toBe('diego_user');
    expect(entry.channels[0].verified).toBe(true);
  });

  test('track() upserts on repeated messages (same sender)', () => {
    const ud = new UserDirectory(tmpDir, silentLogger);
    ud.track('bot1', makeInbound());
    const updated = ud.track('bot1', makeInbound({ timestamp: Date.now() + 1000 }));

    // Should still be one contact
    const all = ud.list('bot1');
    expect(all).toHaveLength(1);
    expect(updated.lastSeen).toBeGreaterThan(updated.firstSeen);
  });

  test('track() updates displayName if changed', () => {
    const ud = new UserDirectory(tmpDir, silentLogger);
    ud.track('bot1', makeInbound());
    const updated = ud.track(
      'bot1',
      makeInbound({ sender: { id: '12345', firstName: 'Diego R' } })
    );

    expect(updated.displayName).toBe('Diego R');
  });

  test('track() from whatsapp creates separate contact', () => {
    const ud = new UserDirectory(tmpDir, silentLogger);
    ud.track('bot1', makeInbound()); // telegram
    ud.track(
      'bot1',
      makeInbound({
        channelKind: 'whatsapp',
        sender: { id: '+5491155551234', firstName: 'Diego WA' },
      })
    );

    const all = ud.list('bot1');
    expect(all).toHaveLength(2);
  });

  test('find() by displayName (partial, case-insensitive)', () => {
    const ud = new UserDirectory(tmpDir, silentLogger);
    ud.track('bot1', makeInbound());
    ud.track(
      'bot1',
      makeInbound({
        sender: { id: '99999', firstName: 'María' },
      })
    );

    expect(ud.find('bot1', 'die')).toHaveLength(1);
    expect(ud.find('bot1', 'DIE')).toHaveLength(1);
    expect(ud.find('bot1', 'mar')).toHaveLength(1);
    expect(ud.find('bot1', 'unknown')).toHaveLength(0);
  });

  test('find() by @username', () => {
    const ud = new UserDirectory(tmpDir, silentLogger);
    ud.track('bot1', makeInbound());

    expect(ud.find('bot1', '@diego_user')).toHaveLength(1);
    expect(ud.find('bot1', 'diego_user')).toHaveLength(1);
  });

  test('find() by address', () => {
    const ud = new UserDirectory(tmpDir, silentLogger);
    ud.track('bot1', makeInbound());

    expect(ud.find('bot1', '12345')).toHaveLength(1);
  });

  test('find() by contact ID', () => {
    const ud = new UserDirectory(tmpDir, silentLogger);
    const entry = ud.track('bot1', makeInbound());

    expect(ud.find('bot1', entry.id)).toHaveLength(1);
  });

  test('register() creates a manual contact', () => {
    const ud = new UserDirectory(tmpDir, silentLogger);
    const entry = ud.register('bot1', {
      displayName: 'John',
      channel: { kind: 'telegram', address: '55555', verified: false },
    });

    expect(entry.displayName).toBe('John');
    expect(entry.channels[0].verified).toBe(false);
    expect(ud.list('bot1')).toHaveLength(1);
  });

  test('register() updates existing if same channel address', () => {
    const ud = new UserDirectory(tmpDir, silentLogger);
    ud.register('bot1', {
      displayName: 'John',
      channel: { kind: 'telegram', address: '55555', verified: false },
    });
    ud.register('bot1', {
      displayName: 'John Doe',
      channel: { kind: 'telegram', address: '55555', verified: false },
    });

    const all = ud.list('bot1');
    expect(all).toHaveLength(1);
    expect(all[0].displayName).toBe('John Doe');
  });

  test('addChannel() adds a channel to existing contact', () => {
    const ud = new UserDirectory(tmpDir, silentLogger);
    const entry = ud.track('bot1', makeInbound());
    ud.addChannel('bot1', entry.id, {
      kind: 'whatsapp',
      address: '+5491155551234',
      verified: false,
    });

    const updated = ud.getById('bot1', entry.id)!;
    expect(updated.channels).toHaveLength(2);
    expect(updated.channels[1].kind).toBe('whatsapp');
  });

  test('addChannel() does not duplicate existing channel', () => {
    const ud = new UserDirectory(tmpDir, silentLogger);
    const entry = ud.track('bot1', makeInbound());
    ud.addChannel('bot1', entry.id, {
      kind: 'telegram',
      address: '12345',
      verified: true,
    });

    expect(ud.getById('bot1', entry.id)?.channels).toHaveLength(1);
  });

  test('bot isolation — contacts from bot1 not visible in bot2', () => {
    const ud = new UserDirectory(tmpDir, silentLogger);
    ud.track('bot1', makeInbound());

    expect(ud.list('bot1')).toHaveLength(1);
    expect(ud.list('bot2')).toHaveLength(0);
    expect(ud.find('bot2', 'Diego')).toHaveLength(0);
  });

  test('persistence — reloads from JSONL on new instance', () => {
    const ud1 = new UserDirectory(tmpDir, silentLogger);
    ud1.track('bot1', makeInbound());
    ud1.track('bot1', makeInbound({ sender: { id: '99999', firstName: 'María' } }));

    // New instance reads from disk
    const ud2 = new UserDirectory(tmpDir, silentLogger);
    expect(ud2.list('bot1')).toHaveLength(2);
    expect(ud2.find('bot1', 'Diego')).toHaveLength(1);
  });

  test('getById() returns undefined for unknown ID', () => {
    const ud = new UserDirectory(tmpDir, silentLogger);
    expect(ud.getById('bot1', 'nonexistent')).toBeUndefined();
  });
});
