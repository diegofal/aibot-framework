import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { relaySessionKey, telegramInstancesFor } from '../../src/relay/wiring';
import { SessionManager } from '../../src/session';
import { silentLogger } from './fixture';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('telegramInstancesFor', () => {
  const api = () => ({ sendMessage: async () => ({ message_id: 1 }) });
  const bots = new Map<string, { api: ReturnType<typeof api> }>([
    ['a', { api: api() }],
    ['b', { api: api() }],
    ['c', { api: api() }],
  ]);

  test('own instance first, then the rest of the fleet', () => {
    expect(telegramInstancesFor(bots, 'b').map((i) => i.botId)).toEqual(['b', 'a', 'c']);
  });

  test('a headless bot gets the fleet', () => {
    expect(telegramInstancesFor(bots, 'zzz').map((i) => i.botId)).toEqual(['a', 'b', 'c']);
  });
});

describe('relaySessionKey', () => {
  test('a numeric address is the private session the conversation pipeline uses', () => {
    const dir = mkdtempSync(join(tmpdir(), 'relay-wiring-'));
    dirs.push(dir);
    const sm = new SessionManager({ dataDir: dir } as never, silentLogger);
    expect(relaySessionKey(sm, 'bot1', '1001')).toBe(
      sm.serializeKey({ botId: 'bot1', chatType: 'private', chatId: 1001, userId: 1001 })
    );
    expect(relaySessionKey(sm, 'bot1', '1001')).toBe('bot:bot1:private:1001');
  });

  test('a non-numeric address has no private session (never the shared bucket)', () => {
    const sm = { serializeKey: () => 'bot:bot1:private:0' } as never;
    expect(relaySessionKey(sm, 'bot1', 'op@example.test')).toBeUndefined();
  });
});
