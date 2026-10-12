/**
 * UserDirectory — the pieces the relay feature needs: operator seed and merge,
 * aliases, exact-match priority, channel lookup and throttled persistence.
 * Synthetic data only (Ana, Bruno, Op; fake ids).
 */
import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
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

const T0 = 1_760_000_000_000;
const HOUR = 3_600_000;

function inbound(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    messageId: 'm-1',
    channelKind: 'telegram',
    text: 'hola',
    chatId: '1001',
    chatType: 'private',
    sender: { id: '1001', firstName: 'Ana', username: 'ana_test' },
    timestamp: T0,
    ...overrides,
  };
}

let tmpDir: string;
const dirs: string[] = [];

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'ud-relay-'));
  dirs.push(tmpDir);
});

afterAll(() => {
  for (const d of dirs) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {}
  }
});

const lineCount = (botId = 'bot1') =>
  readFileSync(join(tmpDir, 'user-directory', `${botId}.jsonl`), 'utf-8')
    .split('\n')
    .filter(Boolean).length;

const OP = { name: 'Op', telegramChatId: 7007, email: 'op@example.test' };

describe('UserDirectory.track() persistence throttle', () => {
  test('repeated messages that only move lastSeen do not append a line each', () => {
    const ud = new UserDirectory(tmpDir, silentLogger);
    ud.track('bot1', inbound());
    ud.track('bot1', inbound({ timestamp: T0 + 60_000 }));
    ud.track('bot1', inbound({ timestamp: T0 + 120_000 }));
    expect(lineCount()).toBe(1);
    // In memory lastSeen still moves.
    expect(ud.list('bot1')[0].lastSeen).toBe(T0 + 120_000);
  });

  test('lastSeen moving more than an hour is persisted', () => {
    const ud = new UserDirectory(tmpDir, silentLogger);
    ud.track('bot1', inbound());
    ud.track('bot1', inbound({ timestamp: T0 + HOUR + 1 }));
    expect(lineCount()).toBe(2);
  });

  test('a name or username change is persisted immediately', () => {
    const ud = new UserDirectory(tmpDir, silentLogger);
    ud.track('bot1', inbound());
    ud.track(
      'bot1',
      inbound({ sender: { id: '1001', firstName: 'Ana María', username: 'ana_test' } })
    );
    ud.track('bot1', inbound({ sender: { id: '1001', firstName: 'Ana María', username: 'ana2' } }));
    expect(lineCount()).toBe(3);
  });
});

describe('UserDirectory.ensureOperator()', () => {
  test('creates the operator contact with telegram and web channels', () => {
    const ud = new UserDirectory(tmpDir, silentLogger);
    const op = ud.ensureOperator('bot1', OP);

    expect(op.displayName).toBe('Op');
    expect(op.metadata?.role).toBe('operator');
    expect(op.channels).toEqual([
      { kind: 'telegram', address: '7007', verified: false },
      { kind: 'web', address: 'op@example.test', verified: false },
    ]);
    expect(ud.getOperator('bot1')?.id).toBe(op.id);
  });

  test('without telegram or email only the given channels are added', () => {
    const ud = new UserDirectory(tmpDir, silentLogger);
    const op = ud.ensureOperator('bot1', { name: 'Op', email: 'op@example.test' });
    expect(op.channels.map((c) => c.kind)).toEqual(['web']);
  });

  test('getOperator() is undefined when no operator was seeded', () => {
    const ud = new UserDirectory(tmpDir, silentLogger);
    ud.track('bot1', inbound());
    expect(ud.getOperator('bot1')).toBeUndefined();
  });

  test('merges the entries that own the operator addresses into one contact', () => {
    const ud = new UserDirectory(tmpDir, silentLogger);
    // "Op" talked on Telegram, and a web entry was registered for the email.
    const tg = ud.track(
      'bot1',
      inbound({ sender: { id: '7007', firstName: 'Op', username: 'op_tg' }, timestamp: T0 + 5000 })
    );
    const web = ud.register('bot1', {
      displayName: 'Op (operator)',
      channel: { kind: 'web', address: 'op@example.test', verified: false },
    });
    const webEntry = ud.getById('bot1', web.id)!;
    webEntry.firstSeen = T0; // earliest
    ud.track('bot1', inbound()); // Ana, unrelated

    const op = ud.ensureOperator('bot1', OP);

    expect(ud.list('bot1')).toHaveLength(2); // operator + Ana
    expect(op.metadata?.role).toBe('operator');
    expect(op.displayName).toBe('Op');
    const tgCh = op.channels.find((c) => c.kind === 'telegram')!;
    expect(tgCh).toMatchObject({ address: '7007', verified: true, username: 'op_tg' });
    expect(op.channels.find((c) => c.kind === 'web')?.address).toBe('op@example.test');
    expect(op.firstSeen).toBe(T0);
    expect(op.lastSeen).toBeGreaterThanOrEqual(T0 + 5000);

    // The losing entry is marked, excluded from find/list, and resolves to the operator.
    const loserId = op.id === tg.id ? web.id : tg.id;
    expect(ud.find('bot1', 'Op (operator)').map((e) => e.id)).toEqual([op.id]);
    expect(ud.getById('bot1', loserId)?.id).toBe(op.id);
    expect(ud.findByChannel('bot1', 'web', 'op@example.test')?.id).toBe(op.id);
    expect(ud.findByChannel('bot1', 'telegram', '7007')?.id).toBe(op.id);
  });

  test('the merge survives a reload', () => {
    const ud1 = new UserDirectory(tmpDir, silentLogger);
    ud1.track('bot1', inbound({ sender: { id: '7007', firstName: 'Op' } }));
    ud1.register('bot1', {
      displayName: 'Op (operator)',
      channel: { kind: 'web', address: 'op@example.test', verified: false },
    });
    const op = ud1.ensureOperator('bot1', OP);

    const ud2 = new UserDirectory(tmpDir, silentLogger);
    expect(ud2.list('bot1')).toHaveLength(1);
    expect(ud2.getOperator('bot1')?.id).toBe(op.id);
    expect(ud2.findByChannel('bot1', 'web', 'op@example.test')?.id).toBe(op.id);
    expect(ud2.findByChannel('bot1', 'telegram', '7007')?.id).toBe(op.id);
  });

  test('is idempotent: a second call appends nothing', () => {
    const ud = new UserDirectory(tmpDir, silentLogger);
    ud.track('bot1', inbound({ sender: { id: '7007', firstName: 'Op' } }));
    const first = ud.ensureOperator('bot1', OP);
    const before = lineCount();
    const second = ud.ensureOperator('bot1', OP);
    expect(second.id).toBe(first.id);
    expect(lineCount()).toBe(before);

    // Also across a reload.
    const ud2 = new UserDirectory(tmpDir, silentLogger);
    ud2.ensureOperator('bot1', OP);
    expect(lineCount()).toBe(before);
  });

  test('tracking the operator on Telegram keeps the operator name and verifies the channel', () => {
    const ud = new UserDirectory(tmpDir, silentLogger);
    const op = ud.ensureOperator('bot1', OP);
    const tracked = ud.track('bot1', inbound({ sender: { id: '7007', firstName: 'Opie' } }));
    expect(tracked.id).toBe(op.id);
    expect(tracked.displayName).toBe('Op');
    expect(tracked.channels.find((c) => c.kind === 'telegram')?.verified).toBe(true);
  });
});

describe('UserDirectory aliases and find()', () => {
  test('addAlias() makes the contact findable by the alias, case-insensitively', () => {
    const ud = new UserDirectory(tmpDir, silentLogger);
    const ana = ud.track('bot1', inbound());
    ud.addAlias('bot1', ana.id, 'la jefa');
    expect(ud.find('bot1', 'La Jefa').map((e) => e.id)).toEqual([ana.id]);
    expect(ud.getById('bot1', ana.id)?.aliases).toEqual(['la jefa']);
  });

  test('addAlias() does not duplicate and returns null for unknown ids', () => {
    const ud = new UserDirectory(tmpDir, silentLogger);
    const ana = ud.track('bot1', inbound());
    ud.addAlias('bot1', ana.id, 'jefa');
    const before = lineCount();
    ud.addAlias('bot1', ana.id, 'JEFA');
    expect(ud.getById('bot1', ana.id)?.aliases).toEqual(['jefa']);
    expect(lineCount()).toBe(before);
    expect(ud.addAlias('bot1', 'nope', 'x')).toBeNull();
  });

  test('aliases persist across reloads', () => {
    const ud1 = new UserDirectory(tmpDir, silentLogger);
    const ana = ud1.track('bot1', inbound());
    ud1.addAlias('bot1', ana.id, 'jefa');
    const ud2 = new UserDirectory(tmpDir, silentLogger);
    expect(ud2.find('bot1', 'jefa').map((e) => e.id)).toEqual([ana.id]);
  });

  test('the operator answers to "operator", "operador" and its name', () => {
    const ud = new UserDirectory(tmpDir, silentLogger);
    const op = ud.ensureOperator('bot1', OP);
    ud.track('bot1', inbound());
    for (const q of ['operator', 'Operador', 'op']) {
      expect(ud.find('bot1', q).map((e) => e.id)).toEqual([op.id]);
    }
  });

  test('an exact name match wins over partial matches', () => {
    const ud = new UserDirectory(tmpDir, silentLogger);
    const ana = ud.track('bot1', inbound());
    ud.track('bot1', inbound({ sender: { id: '1002', firstName: 'Anabel' }, chatId: '1002' }));
    ud.track('bot1', inbound({ sender: { id: '1003', firstName: 'Mariana' }, chatId: '1003' }));
    expect(ud.find('bot1', 'ana').map((e) => e.id)).toEqual([ana.id]);
    // A partial query still returns every partial match.
    expect(ud.find('bot1', 'an')).toHaveLength(3);
  });

  test('the exact id of a merged entry finds the contact it was merged into', () => {
    const ud = new UserDirectory(tmpDir, silentLogger);
    // Telegram "Op" is the earliest owner, so the web entry is folded into it.
    ud.track('bot1', inbound({ sender: { id: '7007', firstName: 'Op' }, chatId: '7007' }));
    const web = ud.register('bot1', {
      displayName: 'Op (operator)',
      channel: { kind: 'web', address: 'op@example.test', verified: false },
    });
    const op = ud.ensureOperator('bot1', OP);
    expect(op.id).not.toBe(web.id);
    expect(ud.find('bot1', web.id).map((e) => e.id)).toEqual([op.id]);
  });

  test('two exact matches fall back to the partial result set', () => {
    const ud = new UserDirectory(tmpDir, silentLogger);
    ud.track('bot1', inbound());
    ud.track('bot1', inbound({ sender: { id: '1002', firstName: 'Ana' }, chatId: '1002' }));
    ud.track('bot1', inbound({ sender: { id: '1003', firstName: 'Anabel' }, chatId: '1003' }));
    expect(ud.find('bot1', 'ana')).toHaveLength(3);
  });
});

describe('UserDirectory.findByChannel()', () => {
  test('finds a contact by exact channel and address', () => {
    const ud = new UserDirectory(tmpDir, silentLogger);
    const ana = ud.track('bot1', inbound());
    expect(ud.findByChannel('bot1', 'telegram', '1001')?.id).toBe(ana.id);
    expect(ud.findByChannel('bot1', 'web', '1001')).toBeUndefined();
    expect(ud.findByChannel('bot1', 'telegram', '100')).toBeUndefined();
  });
});
