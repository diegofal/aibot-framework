import { describe, expect, test } from 'bun:test';
import {
  formatAnswerAck,
  formatAnswerForRequester,
  formatAnswerNotDelivered,
  formatRelayForRecipient,
  relayDedupeKey,
} from '../../src/relay/format';
import type { RelayRecord } from '../../src/relay/types';

const record = (overrides: Partial<RelayRecord> = {}): RelayRecord => ({
  id: 'r-0000abcd',
  botId: 'bot1',
  createdAt: 1,
  updatedAt: 1,
  from: { contactId: 'c-ana', displayName: 'Ana', channelKind: 'telegram', address: '1001' },
  to: {
    contactId: 'c-op',
    displayName: 'Op',
    channelKind: 'telegram',
    address: '7007',
    isOperator: true,
  },
  text: '¿Quién soy?',
  expectsReply: true,
  status: 'delivered',
  delivery: { status: 'delivered', attempts: [] },
  dedupeKey: 'k',
  ...overrides,
});

describe('formatRelayForRecipient', () => {
  test('es (default): header, text and reply footer', () => {
    expect(formatRelayForRecipient(record(), 'Botty')).toBe(
      '📨 De Ana (vía Botty):\n\n¿Quién soy?\n\n↩️ Respondé a este mensaje y se lo paso a Ana.'
    );
  });

  test('en: header, text and reply footer', () => {
    expect(formatRelayForRecipient(record(), 'Botty', 'en')).toBe(
      "📨 From Ana (via Botty):\n\n¿Quién soy?\n\n↩️ Reply to this message and I'll pass it to Ana."
    );
  });

  test('no footer when no reply is expected', () => {
    expect(formatRelayForRecipient(record({ expectsReply: false }), 'Botty')).toBe(
      '📨 De Ana (vía Botty):\n\n¿Quién soy?'
    );
  });

  test('from the bot itself: just the text, no header nor return path', () => {
    expect(formatRelayForRecipient(record({ from: null }), 'Botty')).toBe('¿Quién soy?');
  });
});

describe('formatAnswerForRequester', () => {
  test('quotes the original (first 80 chars) and adds the answer', () => {
    const long = 'x'.repeat(100);
    const out = formatAnswerForRequester('Sos Ana.', 'Op', record({ text: long }), 'Botty');
    expect(out).toBe(`↩️ Respuesta de Op (vía Botty) a: «${'x'.repeat(80)}…»\n\nSos Ana.`);
  });

  test('short originals are not ellipsized; en locale', () => {
    expect(formatAnswerForRequester('You are Ana.', 'Op', record(), 'Botty', 'en')).toBe(
      '↩️ Answer from Op (via Botty) to: «¿Quién soy?»\n\nYou are Ana.'
    );
  });
});

describe('formatAnswerAck', () => {
  test('es and en', () => {
    expect(formatAnswerAck('Ana')).toBe('✅ Se lo pasé a Ana.');
    expect(formatAnswerAck('Ana', 'en')).toBe('✅ Passed to Ana.');
  });
});

describe('relayDedupeKey', () => {
  test('stable under whitespace and case differences', () => {
    const a = relayDedupeKey('bot1', '1001', 'c-op', 'Hola  Op\n');
    const b = relayDedupeKey('bot1', '1001', 'c-op', '  hola op');
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{16}$/);
  });

  test('differs by bot, sender, recipient and text', () => {
    const base = relayDedupeKey('bot1', 'bot', 'c-op', 'hola');
    expect(relayDedupeKey('bot2', 'bot', 'c-op', 'hola')).not.toBe(base);
    expect(relayDedupeKey('bot1', '1001', 'c-op', 'hola')).not.toBe(base);
    expect(relayDedupeKey('bot1', 'bot', 'c-ana', 'hola')).not.toBe(base);
    expect(relayDedupeKey('bot1', 'bot', 'c-op', 'chau')).not.toBe(base);
  });
});

describe('formatAnswerNotDelivered', () => {
  test('queued: stored, not notified', () => {
    expect(formatAnswerNotDelivered('Ana', 'queued')).toBe(
      '⚠️ No pude avisarle a Ana: tu respuesta quedó guardada y la verá cuando vuelva a escribir.'
    );
    expect(formatAnswerNotDelivered('Ana', 'queued', 'en')).toBe(
      "⚠️ I couldn't notify Ana: your answer is stored and they will see it when they write again."
    );
  });

  test('failed: nothing reached them', () => {
    expect(formatAnswerNotDelivered('Ana', 'failed')).toBe(
      '⚠️ No pude pasarle tu respuesta a Ana. No le llegó nada.'
    );
    expect(formatAnswerNotDelivered('Ana', 'failed', 'en')).toBe(
      "⚠️ I couldn't pass your answer to Ana. Nothing reached them."
    );
  });
});
