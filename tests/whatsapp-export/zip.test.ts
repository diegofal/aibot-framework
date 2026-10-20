import { describe, expect, test } from 'bun:test';
import { ZipError, extractChatText } from '../../src/whatsapp-export/zip';
import { makeZip } from './zip-fixture';

const CHAT = '[16/10/26, 08:22:05] Laura: Mañana traer disfraz\n';

describe('extractChatText', () => {
  test('reads _chat.txt from a deflated iOS export, ignoring media entries', () => {
    const zip = makeZip([
      { name: '00000012-PHOTO-2026-10-16.jpg', data: Buffer.from([1, 2, 3]) },
      { name: '_chat.txt', data: CHAT },
    ]);
    expect(extractChatText(zip)).toBe(CHAT);
  });

  test('reads a stored (uncompressed) entry', () => {
    expect(extractChatText(makeZip([{ name: '_chat.txt', data: CHAT }], 0))).toBe(CHAT);
  });

  test('falls back to the only .txt when there is no _chat.txt (Android zip)', () => {
    const zip = makeZip([{ name: 'WhatsApp Chat with 3B Padres.txt', data: CHAT }]);
    expect(extractChatText(zip)).toBe(CHAT);
  });

  test('a zip with no text file is a ZipError', () => {
    const zip = makeZip([{ name: 'photo.jpg', data: Buffer.from([1]) }]);
    expect(() => extractChatText(zip)).toThrow(ZipError);
  });

  test('not a zip is a ZipError', () => {
    expect(() => extractChatText(Buffer.from('hello, not a zip'))).toThrow(ZipError);
  });

  test('an entry inflating past the limit is refused', () => {
    const zip = makeZip([{ name: '_chat.txt', data: 'a'.repeat(200_000) }]);
    expect(() => extractChatText(zip, { maxBytes: 1000 })).toThrow(ZipError);
  });
});
