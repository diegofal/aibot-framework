import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RelayStore } from '../../src/relay/store';
import type { RelayParty, RelayRecord } from '../../src/relay/types';

const silentLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  child: () => silentLogger,
} as any;

const ana: RelayParty = {
  contactId: 'c-ana',
  displayName: 'Ana',
  channelKind: 'telegram',
  address: '1001',
};
const op: RelayParty = {
  contactId: 'c-op',
  displayName: 'Op',
  channelKind: 'telegram',
  address: '7007',
  isOperator: true,
};

type NewRecord = Omit<RelayRecord, 'id' | 'createdAt' | 'updatedAt'>;
const draft = (overrides: Partial<NewRecord> = {}): NewRecord => ({
  botId: 'bot1',
  from: ana,
  to: op,
  text: '¿Quién soy?',
  expectsReply: true,
  status: 'delivered',
  delivery: {
    status: 'delivered',
    channel: 'telegram',
    viaBotId: 'bot1',
    telegramMessageId: 55,
    attempts: [{ channel: 'telegram', viaBotId: 'bot1', status: 'delivered' }],
  },
  dedupeKey: 'k1',
  ...overrides,
});

let dir: string;
const dirs: string[] = [];
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'relay-store-'));
  dirs.push(dir);
});
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe('RelayStore', () => {
  test('create() assigns an r- id and timestamps, and persists to <data>/relays/<bot>.jsonl', () => {
    const store = new RelayStore(dir, silentLogger);
    const r = store.create(draft());
    expect(r.id).toMatch(/^r-[0-9a-f]{8}$/);
    expect(r.createdAt).toBe(r.updatedAt);
    expect(store.get('bot1', r.id)).toEqual(r);
    const lines = readFileSync(join(dir, 'relays', 'bot1.jsonl'), 'utf-8')
      .trim()
      .split('\n');
    expect(lines).toHaveLength(1);
  });

  test('update() patches, bumps updatedAt and wins on reload (last line per id)', async () => {
    const store = new RelayStore(dir, silentLogger);
    const r = store.create(draft());
    await Bun.sleep(2);
    const u = store.update('bot1', r.id, { status: 'answered', answeredAt: 123 });
    expect(u?.status).toBe('answered');
    expect(u!.updatedAt).toBeGreaterThan(r.updatedAt);

    const reloaded = new RelayStore(dir, silentLogger);
    expect(reloaded.get('bot1', r.id)?.status).toBe('answered');
    expect(reloaded.get('bot1', r.id)?.answeredAt).toBe(123);
  });

  test('update() returns null for unknown ids and never changes id/botId', () => {
    const store = new RelayStore(dir, silentLogger);
    expect(store.update('bot1', 'r-nope', { status: 'failed' })).toBeNull();
    const r = store.create(draft());
    const u = store.update('bot1', r.id, { id: 'r-other', botId: 'bot2' } as any);
    expect(u?.id).toBe(r.id);
    expect(u?.botId).toBe('bot1');
  });

  test('malformed lines are skipped, not thrown', () => {
    const store = new RelayStore(dir, silentLogger);
    const r = store.create(draft());
    appendFileSync(join(dir, 'relays', 'bot1.jsonl'), '{not json\n\n42\n');
    const reloaded = new RelayStore(dir, silentLogger);
    expect(reloaded.get('bot1', r.id)?.id).toBe(r.id);
    expect(reloaded.get('bot2', 'x')).toBeUndefined();
  });

  test('findByTelegramMessage() matches the delivered message in that chat', () => {
    const store = new RelayStore(dir, silentLogger);
    const r = store.create(draft());
    expect(store.findByTelegramMessage('bot1', '7007', 55)?.id).toBe(r.id);
    expect(store.findByTelegramMessage('bot1', '7007', 56)).toBeUndefined();
    expect(store.findByTelegramMessage('bot1', '1001', 55)).toBeUndefined();
  });

  test('openFor() lists relays waiting on that party (expectsReply, not answered)', () => {
    const store = new RelayStore(dir, silentLogger);
    const open = store.create(draft());
    const queued = store.create(draft({ status: 'queued', dedupeKey: 'k2' }));
    store.create(draft({ expectsReply: false, dedupeKey: 'k3' }));
    store.create(draft({ status: 'failed', dedupeKey: 'k4' }));
    const answered = store.create(draft({ dedupeKey: 'k5' }));
    store.update('bot1', answered.id, { status: 'answered' });
    store.create(draft({ from: op, to: ana, dedupeKey: 'k6' })); // addressed to Ana

    const ids = store.openFor('bot1', 'telegram', '7007').map((r) => r.id);
    expect(ids.sort()).toEqual([open.id, queued.id].sort());
  });

  test('sentBy() lists relays from that party, newest first, optionally since', async () => {
    const store = new RelayStore(dir, silentLogger);
    const first = store.create(draft());
    await Bun.sleep(2);
    const second = store.create(draft({ dedupeKey: 'k2' }));
    store.create(draft({ from: null, to: ana, dedupeKey: 'k3' }));

    expect(store.sentBy('bot1', 'telegram', '1001').map((r) => r.id)).toEqual([
      second.id,
      first.id,
    ]);
    expect(store.sentBy('bot1', 'telegram', '1001', second.createdAt).map((r) => r.id)).toEqual([
      second.id,
    ]);
  });

  test('findDuplicate() finds a recent relay with the same key, within the window', () => {
    const store = new RelayStore(dir, silentLogger);
    const r = store.create(draft());
    expect(store.findDuplicate('bot1', 'k1', 10 * 60_000)?.id).toBe(r.id);
    expect(store.findDuplicate('bot1', 'other', 10 * 60_000)).toBeUndefined();
    expect(store.findDuplicate('bot1', 'k1', -1)).toBeUndefined();
  });

  test('a failed relay is not a duplicate (it can be retried)', () => {
    const store = new RelayStore(dir, silentLogger);
    store.create(draft({ status: 'failed' }));
    expect(store.findDuplicate('bot1', 'k1', 10 * 60_000)).toBeUndefined();
  });

  test('bots are isolated', () => {
    const store = new RelayStore(dir, silentLogger);
    const r = store.create(draft());
    expect(store.get('bot2', r.id)).toBeUndefined();
    expect(store.openFor('bot2', 'telegram', '7007')).toEqual([]);
  });
});

describe('RelayStore telegram lookups across instances', () => {
  test('findByTelegramMessage() filters by the carrying instance when given', () => {
    const store = new RelayStore(dir, silentLogger);
    const r = store.create(draft());
    expect(store.findByTelegramMessage('bot1', '7007', 55, 'bot1')?.id).toBe(r.id);
    expect(store.findByTelegramMessage('bot1', '7007', 55, 'bot2')).toBeUndefined();
  });

  test('findByTelegramDelivery() finds a relay of another bot carried by this instance', () => {
    const writer = new RelayStore(dir, silentLogger);
    const r = writer.create(
      draft({
        botId: 'headless',
        delivery: {
          status: 'delivered',
          channel: 'telegram',
          viaBotId: 'bot1',
          telegramMessageId: 77,
          attempts: [],
        },
      })
    );
    const fresh = new RelayStore(dir, silentLogger); // nothing loaded yet
    expect(fresh.findByTelegramDelivery('bot1', '7007', 77)?.id).toBe(r.id);
    expect(fresh.findByTelegramDelivery('bot2', '7007', 77)).toBeUndefined();
  });
});
