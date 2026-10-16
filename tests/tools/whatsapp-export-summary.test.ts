import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_PERMISSIONS } from '../../src/bot/tool-permissions';
import { createWhatsAppExportSummaryTool } from '../../src/tools/whatsapp-export-summary';
import { WhatsAppExportStore, localTsToMs } from '../../src/whatsapp-export/store';

const BOT = 'finny-test';
const NOW = localTsToMs('2026-10-16T12:00:00');
const logger = { info() {}, warn() {}, error() {}, debug() {} } as any;
const OP = { displayName: 'Op', channelKind: 'telegram', address: '9001', isOperator: true };
const ANA = { displayName: 'Ana', channelKind: 'telegram', address: '1001', isOperator: false };

describe('whatsapp_export_summary', () => {
  let dir: string;
  let store: WhatsAppExportStore;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'wa-tool-'));
    store = new WhatsAppExportStore(dir);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const tool = () => createWhatsAppExportSummaryTool({ store, now: () => NOW });
  const run = (args: Record<string, unknown>) =>
    tool().execute({ _botId: BOT, _requester: OP, ...args }, logger);

  test('definition is named and documents what a summary should contain', () => {
    const def = tool().definition.function;
    expect(def.name).toBe('whatsapp_export_summary');
    expect(def.description).toContain('money');
  });

  test('a non-operator is refused before anything is read', async () => {
    store.ingest(BOT, 'G', [{ ts: '2026-10-16T08:00:00', author: 'A', text: 'secret' }], {
      nowMs: NOW,
      fileName: 'a',
    });
    const r = await tool().execute({ _botId: BOT, _requester: ANA }, logger);
    expect(r.success).toBe(false);
    expect(r.failureKind).toBe('policy');
    expect(r.content).not.toContain('secret');
  });

  test('outside a conversation (no requester: agent loop, cron) it is refused too', async () => {
    const r = await tool().execute({ _botId: BOT }, logger);
    expect(r.success).toBe(false);
    expect(r.failureKind).toBe('policy');
  });

  test("the bot's own run (_actor: 'self') is refused too: it reads only in a conversation", async () => {
    const r = await tool().execute({ _botId: BOT, _actor: 'self' }, logger);
    expect(r.success).toBe(false);
  });

  test('the operator in a group chat is refused', async () => {
    const r = await tool().execute({ _botId: BOT, _requester: OP, _isGroup: true }, logger);
    expect(r.success).toBe(false);
    expect(r.failureKind).toBe('policy');
  });

  test('the operator on web (address match, spoofable) is refused', async () => {
    const r = await tool().execute(
      { _botId: BOT, _requester: { ...OP, channelKind: 'web', address: 'op@example.com' } },
      logger
    );
    expect(r.success).toBe(false);
  });

  test('flagged sensitive; free in the permission matrix (the gate does the rest)', () => {
    expect(tool().definition.sensitive).toBe(true);
    expect(DEFAULT_PERMISSIONS.whatsapp_export_summary).toEqual({
      agentLoop: 'free',
      conversation: 'free',
    });
  });

  test('no exports yet', async () => {
    const r = await run({});
    expect(r.success).toBe(true);
    expect(r.content).toContain('No WhatsApp exports');
  });

  test('returns the new messages of the latest export, wrapped as untrusted content', async () => {
    store.ingest(
      BOT,
      '3B Padres',
      [
        { ts: '2026-10-15T18:02:00', author: 'Laura', text: 'El viernes no hay clases' },
        { ts: '2026-10-16T08:22:00', author: 'Pablo', text: 'Llevar $500\npara la excursión' },
      ],
      { nowMs: NOW, fileName: 'WhatsApp Chat with 3B Padres.txt' }
    );
    const r = await run({});
    expect(r.success).toBe(true);
    expect(r.content).toContain('3B Padres');
    expect(r.content).toContain('2 new messages');
    expect(r.content).toContain('[2026-10-15 18:02] Laura: El viernes no hay clases');
    expect(r.content).toContain('[2026-10-16 08:22] Pablo: Llevar $500\n  para la excursión');
    expect(r.content).toContain('<<<EXTERNAL_UNTRUSTED_CONTENT>>>');
    expect(r.content).toContain('Part 1 of 1');
  });

  test('large exports come in parts', async () => {
    const msgs = Array.from({ length: 400 }, (_, i) => ({
      ts: `2026-10-16T${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}:00`,
      author: 'Laura',
      text: `mensaje número ${i} ${'x'.repeat(60)}`,
    }));
    store.ingest(BOT, 'G', msgs, { nowMs: NOW, fileName: 'a' });
    const p1 = await run({ group: 'G' });
    const total = Number(/Part 1 of (\d+)/.exec(p1.content)?.[1]);
    expect(total).toBeGreaterThan(1);
    expect(p1.content).toContain('part: 2');
    const p2 = await run({ group: 'G', part: 2 });
    expect(p2.content).toContain(`Part 2 of ${total}`);
    expect(p2.content).not.toContain('mensaje número 0 ');
    const last = await run({ group: 'G', part: total });
    expect(last.content).toContain('mensaje número 399');
    expect(last.content).not.toContain('part: ');
    const beyond = await run({ group: 'G', part: total + 1 });
    expect(beyond.success).toBe(false);
  });

  test('unknown group lists the known ones', async () => {
    store.ingest(BOT, '3B Padres', [{ ts: '2026-10-16T08:00:00', author: 'A', text: 'x' }], {
      nowMs: NOW,
      fileName: 'a',
    });
    const r = await run({ group: 'fútbol' });
    expect(r.success).toBe(false);
    expect(r.content).toContain('3B Padres');
  });

  test('nothing new in the latest export', async () => {
    const m = [{ ts: '2026-10-16T08:00:00', author: 'A', text: 'x' }];
    store.ingest(BOT, 'G', m, { nowMs: NOW - 10, fileName: 'a' });
    store.ingest(BOT, 'G', m, { nowMs: NOW, fileName: 'a' });
    const r = await run({});
    expect(r.success).toBe(true);
    expect(r.content).toContain('no new messages');
  });
});
