/**
 * WhatsApp "Export chat" parser. Synthetic chats only — never real exports.
 */
import { describe, expect, test } from 'bun:test';
import {
  groupNameFromFileName,
  groupSlug,
  isWhatsAppExportFileName,
  looksLikeWhatsAppExport,
  parseWhatsAppExport,
} from '../../src/whatsapp-export/parser';

const LRM = '‎';
const NNBSP = ' ';

describe('parseWhatsAppExport — Android', () => {
  test('24h Spanish export: messages, multi-line, system and media lines', () => {
    const text = [
      '10/10/26, 08:00 - Los mensajes y las llamadas están cifrados de extremo a extremo. Nadie fuera de este chat, ni siquiera WhatsApp, puede leerlos ni escucharlos. Toca para obtener más información.',
      '10/10/26, 08:01 - Laura creó el grupo "3B Padres"',
      '16/10/26, 08:22 - Laura: Hola! El viernes no hay clases',
      'Por jornada docente.',
      '16/10/26, 08:23 - +54 9 11 5555-0000: <Multimedia omitido>',
      '16/10/26, 08:24 - Pablo: Hay que llevar $500 para la excursión <Se editó este mensaje.>',
      '16/10/26, 08:25 - Pablo: Se eliminó este mensaje.',
      '16/10/26, 08:26 - Marta se unió usando el enlace de invitación de este grupo',
    ].join('\n');
    const r = parseWhatsAppExport(text);
    expect(r.dateOrder).toBe('dmy');
    expect(r.messages).toEqual([
      {
        ts: '2026-10-16T08:22:00',
        author: 'Laura',
        text: 'Hola! El viernes no hay clases\nPor jornada docente.',
      },
      { ts: '2026-10-16T08:24:00', author: 'Pablo', text: 'Hay que llevar $500 para la excursión' },
    ]);
    expect(r.skipped).toEqual({ system: 3, media: 1, deleted: 1 });
  });

  test('12h English export (M/D/YY), AM/PM with narrow no-break space', () => {
    const text = [
      '10/16/26, 8:22 AM - Messages and calls are end-to-end encrypted. No one outside of this chat, not even WhatsApp, can read or listen to them. Tap to learn more.',
      `10/16/26, 8:22${NNBSP}PM - Kate: Bake sale tomorrow, bring cookies`,
      '10/16/26, 12:05 AM - Tom: <Media omitted>',
      '10/16/26, 12:30 PM - Tom: Noon works',
      '10/17/26, 9:00 AM - Tom: This message was deleted',
      '10/17/26, 9:01 AM - Tom left',
    ].join('\n');
    const r = parseWhatsAppExport(text);
    expect(r.dateOrder).toBe('mdy');
    expect(r.messages.map((m) => [m.ts, m.author, m.text])).toEqual([
      ['2026-10-16T20:22:00', 'Kate', 'Bake sale tomorrow, bring cookies'],
      ['2026-10-16T12:30:00', 'Tom', 'Noon works'],
    ]);
    expect(r.skipped).toEqual({ system: 2, media: 1, deleted: 1 });
  });

  test('Spanish 12h "p. m." and four-digit year', () => {
    const text = '16/10/2026, 8:05 p. m. - Ana: Reunión el lunes 19 a las 18';
    expect(parseWhatsAppExport(text).messages).toEqual([
      { ts: '2026-10-16T20:05:00', author: 'Ana', text: 'Reunión el lunes 19 a las 18' },
    ]);
  });

  test('ambiguous day/month: picks the order that keeps the chat in sequence', () => {
    // 01/02 → 02/03 → 03/04: as DMY that is Feb 1, Mar 2, Apr 3 (ordered);
    // as MDY Jan 2, Feb 3, Mar 4 is also ordered — then DMY wins (default).
    const dmyText = [
      '01/02/26, 10:00 - A: uno',
      '02/03/26, 10:00 - A: dos',
      '03/04/26, 10:00 - A: tres',
    ].join('\n');
    expect(parseWhatsAppExport(dmyText).dateOrder).toBe('dmy');
    // 05/01, 05/02, 06/01: as MDY May 1, May 2, Jun 1 (ordered); as DMY Jan 5, Feb 5, Jan 6 (not).
    const mdyText = [
      '05/01/26, 10:00 - A: uno',
      '05/02/26, 10:00 - A: dos',
      '06/01/26, 10:00 - A: tres',
    ].join('\n');
    const r = parseWhatsAppExport(mdyText);
    expect(r.dateOrder).toBe('mdy');
    expect(r.messages[2].ts).toBe('2026-06-01T10:00:00');
  });

  test('text before the first header is ignored; BOM stripped; CRLF handled', () => {
    const text = '﻿garbage line\r\n16/10/26, 08:22 - Laura: hola\r\nsegunda línea\r\n';
    expect(parseWhatsAppExport(text).messages).toEqual([
      { ts: '2026-10-16T08:22:00', author: 'Laura', text: 'hola\nsegunda línea' },
    ]);
  });
});

describe('parseWhatsAppExport — iOS', () => {
  test('bracketed 24h with seconds; LRM-prefixed system and media lines', () => {
    const text = [
      `[16/10/26, 08:00:00] 3B Padres: ${LRM}Los mensajes y las llamadas están cifrados de extremo a extremo.`,
      '[16/10/26, 08:22:05] Laura: Mañana traer disfraz',
      'para el acto',
      `[16/10/26, 08:23:10] Pablo: ${LRM}imagen omitida`,
      `[16/10/26, 08:24:00] Pablo: ${LRM}<adjunto: 00000012-PHOTO-2026-10-16.jpg>`,
      `${LRM}[16/10/26, 08:25:00] Pablo: Confirmo ${LRM}<Se editó este mensaje.>`,
      `[16/10/26, 08:26:00] Marta: ${LRM}Se eliminó este mensaje.`,
    ].join('\n');
    const r = parseWhatsAppExport(text);
    expect(r.messages).toEqual([
      { ts: '2026-10-16T08:22:05', author: 'Laura', text: 'Mañana traer disfraz\npara el acto' },
      { ts: '2026-10-16T08:25:00', author: 'Pablo', text: 'Confirmo' },
    ]);
    expect(r.skipped).toEqual({ system: 1, media: 2, deleted: 1 });
  });

  test('bracketed 12h English', () => {
    const text = `[10/16/26, 8:22:05${NNBSP}PM] Kate: Field trip form due Friday`;
    expect(parseWhatsAppExport(text).messages).toEqual([
      { ts: '2026-10-16T20:22:05', author: 'Kate', text: 'Field trip form due Friday' },
    ]);
  });
});

describe('looksLikeWhatsAppExport', () => {
  test('true for an export, false for prose', () => {
    expect(looksLikeWhatsAppExport('16/10/26, 08:22 - Laura: hola\n16/10/26, 08:23 - P: x')).toBe(
      true
    );
    expect(looksLikeWhatsAppExport('Dear diary,\ntoday was fine.\nThe end.')).toBe(false);
    expect(looksLikeWhatsAppExport('')).toBe(false);
  });
});

describe('file names', () => {
  test('recognises export file names in English, Spanish and iOS zip form', () => {
    expect(isWhatsAppExportFileName('WhatsApp Chat with 3B Padres.txt')).toBe(true);
    expect(isWhatsAppExportFileName('Chat de WhatsApp con 3B Padres.txt')).toBe(true);
    expect(isWhatsAppExportFileName('WhatsApp Chat - 3B Padres.zip')).toBe(true);
    expect(isWhatsAppExportFileName('_chat.txt')).toBe(true);
    expect(isWhatsAppExportFileName('anything.zip')).toBe(true);
    expect(isWhatsAppExportFileName('notes.txt')).toBe(false);
    expect(isWhatsAppExportFileName('report.pdf')).toBe(false);
    expect(isWhatsAppExportFileName(undefined)).toBe(false);
  });

  test('group name from the file name', () => {
    expect(groupNameFromFileName('WhatsApp Chat with 3B Padres.txt')).toBe('3B Padres');
    expect(groupNameFromFileName('Chat de WhatsApp con Fútbol Sábados.txt')).toBe('Fútbol Sábados');
    expect(groupNameFromFileName('WhatsApp Chat - 3B Padres.zip')).toBe('3B Padres');
    expect(groupNameFromFileName('WhatsApp Chat with 3B Padres (1).txt')).toBe('3B Padres');
    expect(groupNameFromFileName('_chat.txt')).toBeUndefined();
    expect(groupNameFromFileName(undefined)).toBeUndefined();
  });

  test('group slug is filesystem-safe and accent-free', () => {
    expect(groupSlug('Fútbol Sábados / 3°B')).toBe('futbol-sabados-3-b');
    expect(groupSlug('***')).toBe('group');
    expect(groupSlug('../../etc')).toBe('etc');
  });
});
