import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MediaError } from '../../src/media';
import { intakeWhatsAppExport } from '../../src/whatsapp-export/intake';
import { WhatsAppExportStore, localTsToMs } from '../../src/whatsapp-export/store';
import { makeZip } from './zip-fixture';

const BOT = 'finny-test';
const NOW = localTsToMs('2026-10-16T12:00:00');
const CHAT = [
  '15/10/26, 18:02 - Laura: El viernes no hay clases',
  '16/10/26, 08:22 - Pablo: Hay que llevar $500 para la excursión',
].join('\n');

describe('intakeWhatsAppExport', () => {
  let dir: string;
  let store: WhatsAppExportStore;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'wa-intake-'));
    store = new WhatsAppExportStore(dir);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test('a .txt export: stored, and the turn tells the model to call the tool — no raw messages', async () => {
    const r = await intakeWhatsAppExport({
      botId: BOT,
      fileName: 'WhatsApp Chat with 3B Padres.txt',
      caption: 'resumime',
      buffer: Buffer.from(CHAT),
      store,
      nowMs: NOW,
    });
    expect(r.text).toContain('resumime');
    expect(r.text).toContain('3B Padres');
    expect(r.text).toContain('2 new messages');
    expect(r.text).toContain('whatsapp_export_summary');
    expect(r.text).toContain('money'); // the summary guide rides along
    expect(r.text).not.toContain('$500');
    expect(r.sessionText).toBe('[WhatsApp export: 3B Padres — 2 new messages] resumime');
    expect(store.newMessages(BOT, '3b-padres', NOW)).toHaveLength(2);
  });

  test('an iOS .zip export with _chat.txt', async () => {
    const zip = makeZip([
      {
        name: '_chat.txt',
        data: '[16/10/26, 08:22:05] Laura: Mañana traer disfraz\n',
      },
    ]);
    const r = await intakeWhatsAppExport({
      botId: BOT,
      fileName: 'WhatsApp Chat - 3B Padres.zip',
      buffer: zip,
      store,
      nowMs: NOW,
    });
    expect(r.text).toContain('1 new message');
    expect(store.newMessages(BOT, '3b-padres', NOW)[0].text).toBe('Mañana traer disfraz');
  });

  test('nothing new since the previous export says so', async () => {
    const input = {
      botId: BOT,
      fileName: 'WhatsApp Chat with 3B Padres.txt',
      buffer: Buffer.from(CHAT),
      store,
      nowMs: NOW,
    };
    await intakeWhatsAppExport(input);
    const r = await intakeWhatsAppExport({ ...input, nowMs: NOW + 1000 });
    expect(r.text).toContain('No new messages since the previous export');
  });

  test('a file without a group name uses the caption, else a generic name', async () => {
    const r = await intakeWhatsAppExport({
      botId: BOT,
      fileName: '_chat.txt',
      buffer: Buffer.from(CHAT),
      store,
      nowMs: NOW,
    });
    expect(r.text).toContain('"WhatsApp group"');
  });

  test('text that is not an export is a MediaError the operator can read', async () => {
    await expect(
      intakeWhatsAppExport({
        botId: BOT,
        fileName: 'WhatsApp notes.txt',
        buffer: Buffer.from('just some notes\nnothing else'),
        store,
        nowMs: NOW,
      })
    ).rejects.toBeInstanceOf(MediaError);
  });

  test('a broken zip is a MediaError', async () => {
    await expect(
      intakeWhatsAppExport({
        botId: BOT,
        fileName: 'WhatsApp Chat - X.zip',
        buffer: Buffer.from('not a zip'),
        store,
        nowMs: NOW,
      })
    ).rejects.toBeInstanceOf(MediaError);
  });
});
