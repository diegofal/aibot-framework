import { afterEach, describe, expect, test } from 'bun:test';
import {
  ANA_CHAT,
  BRUNO_CHAT,
  OP_CHAT,
  type World,
  makeWorld,
  seedPeople,
  tgError,
} from './fixture';

let w: World;
afterEach(() => w?.cleanup());

const ana = (w: World) => w.directory.findByChannel('bot1', 'telegram', String(ANA_CHAT))!;

describe('RelayService.ensureOperator', () => {
  test('seeds the operator from config', () => {
    w = makeWorld();
    const op = w.service.ensureOperator('bot1');
    expect(op?.displayName).toBe('Op');
    expect(w.directory.getOperator('bot1')?.id).toBe(op!.id);
  });

  test('does nothing without an operator address, and never throws', () => {
    w = makeWorld({ operator: { name: 'Op' } });
    expect(w.service.ensureOperator('bot1')).toBeUndefined();
    expect(w.directory.getOperator('bot1')).toBeUndefined();
    (w.directory as any).ensureOperator = () => {
      throw new Error('disk full');
    };
    w.config.operator = { name: 'Op', telegramChatId: OP_CHAT };
    expect(w.service.ensureOperator('bot1')).toBeUndefined();
  });
});

describe('RelayService.speaker', () => {
  test('a known contact keeps its directory id and name', () => {
    w = makeWorld();
    seedPeople(w);
    const p = w.service.speaker('bot1', {
      channelKind: 'telegram',
      address: String(ANA_CHAT),
      displayName: 'ana tg',
    });
    expect(p).toEqual({
      contactId: ana(w).id,
      displayName: 'Ana',
      channelKind: 'telegram',
      address: String(ANA_CHAT),
      isOperator: false,
    });
  });

  test('the operator chat is the operator even before the directory knows it', () => {
    w = makeWorld();
    const p = w.service.speaker('bot1', {
      channelKind: 'telegram',
      address: String(OP_CHAT),
      displayName: 'Op',
    });
    expect(p.isOperator).toBe(true);
    expect(p.contactId).toBeUndefined();
  });

  test('a contact with role operator is the operator', () => {
    w = makeWorld({ operator: { name: 'Op' } });
    seedPeople(w);
    w.directory.register('bot1', {
      displayName: 'Op',
      channel: { kind: 'web', address: '77', verified: true },
      metadata: { role: 'operator' },
    });
    expect(
      w.service.speaker('bot1', { channelKind: 'web', address: '77', displayName: 'x' }).isOperator
    ).toBe(true);
  });
});

describe('RelayService.send', () => {
  test('delivers, records the chat it reached and appends to the recipient session', async () => {
    w = makeWorld();
    seedPeople(w);
    const op = w.service.ensureOperator('bot1')!;
    const from = w.service.speaker('bot1', {
      channelKind: 'telegram',
      address: String(ANA_CHAT),
      displayName: 'Ana',
    });
    const res = await w.service.send({
      botId: 'bot1',
      from,
      to: op,
      text: '¿Quién soy?',
      expectsReply: true,
    });
    if (res.duplicate) throw new Error('unexpected duplicate');
    expect(res.record.status).toBe('delivered');
    expect(res.record.to).toMatchObject({ address: String(OP_CHAT), isOperator: true });
    expect(res.record.delivery.viaBotId).toBe('bot1');
    expect(w.sent).toHaveLength(1);
    expect(w.sent[0].text).toContain('📨 De Ana (vía Bot):');
    expect(w.sent[0].text).toContain('Respondé a este mensaje');
    expect(res.record.delivery.telegramMessageId).toBe(w.sent[0].messageId);
    expect(w.store.get('bot1', res.record.id)?.status).toBe('delivered');
    expect(w.sessions).toEqual([{ botId: 'bot1', party: res.record.to, text: w.sent[0].text }]);
  });

  test('the same text to the same person within 10 minutes is a duplicate', async () => {
    w = makeWorld();
    seedPeople(w);
    const op = w.service.ensureOperator('bot1')!;
    const input = { botId: 'bot1', from: null, to: op, text: 'Hola', expectsReply: false };
    const first = await w.service.send(input);
    const second = await w.service.send({ ...input, text: '  hola ' });
    expect(second.duplicate).toBe(true);
    expect(second.record.id).toBe(first.record.id);
    expect(w.sent).toHaveLength(1);
  });

  test('a failed delivery is recorded failed and nothing goes to the session', async () => {
    w = makeWorld();
    seedPeople(w);
    w.instances.clear();
    const res = await w.service.send({
      botId: 'bot1',
      from: null,
      to: ana(w),
      text: 'Hola',
      expectsReply: false,
    });
    expect(res.record.status).toBe('failed');
    expect(w.sessions).toEqual([]);
  });

  test('an answer is formatted for the requester and marks the original answered', async () => {
    w = makeWorld();
    seedPeople(w);
    const op = w.service.ensureOperator('bot1')!;
    const anaParty = w.service.speaker('bot1', {
      channelKind: 'telegram',
      address: String(ANA_CHAT),
      displayName: 'Ana',
    });
    const q = await w.service.send({
      botId: 'bot1',
      from: anaParty,
      to: op,
      text: '¿Quién soy?',
      expectsReply: true,
    });
    const opParty = w.service.speaker('bot1', {
      channelKind: 'telegram',
      address: String(OP_CHAT),
      displayName: 'Op',
    });
    const a = await w.service.send({
      botId: 'bot1',
      from: opParty,
      to: ana(w),
      text: 'Sos Ana',
      expectsReply: false,
      answering: q.record,
    });
    expect(a.record.replyToRelayId).toBe(q.record.id);
    expect(w.sent[1]).toMatchObject({ chatId: ANA_CHAT });
    expect(w.sent[1].text).toContain('↩️ Respuesta de Op (vía Bot) a: «¿Quién soy?»');
    expect(w.sent[1].text).toEndWith('Sos Ana');
    const original = w.store.get('bot1', q.record.id)!;
    expect(original.status).toBe('answered');
    expect(original.answerRelayId).toBe(a.record.id);
  });

  test('the same answer text to two different questions is not a duplicate', async () => {
    w = makeWorld();
    seedPeople(w);
    const op = w.service.ensureOperator('bot1')!;
    const anaParty = w.service.speaker('bot1', {
      channelKind: 'telegram',
      address: String(ANA_CHAT),
      displayName: 'Ana',
    });
    const opParty = w.service.speaker('bot1', {
      channelKind: 'telegram',
      address: String(OP_CHAT),
      displayName: 'Op',
    });
    const q1 = await w.service.send({
      botId: 'bot1',
      from: anaParty,
      to: op,
      text: '¿Venís hoy?',
      expectsReply: true,
    });
    const q2 = await w.service.send({
      botId: 'bot1',
      from: anaParty,
      to: op,
      text: '¿Traés el pan?',
      expectsReply: true,
    });
    for (const q of [q1, q2]) {
      const a = await w.service.send({
        botId: 'bot1',
        from: opParty,
        to: ana(w),
        text: 'Sí',
        expectsReply: false,
        answering: q.record,
      });
      expect(a.duplicate).toBe(false);
    }
    expect(w.store.get('bot1', q1.record.id)!.status).toBe('answered');
    expect(w.store.get('bot1', q2.record.id)!.status).toBe('answered');
  });
});

describe('RelayService.send — Telegram reply prompt and channel preference', () => {
  const anaFrom = (w: World) =>
    w.service.speaker('bot1', {
      channelKind: 'telegram',
      address: String(ANA_CHAT),
      displayName: 'Ana',
    });

  test('a relay expecting a reply opens a Telegram reply to it (force_reply, placeholder)', async () => {
    w = makeWorld();
    seedPeople(w);
    const op = w.service.ensureOperator('bot1')!;
    await w.service.send({
      botId: 'bot1',
      from: anaFrom(w),
      to: op,
      text: '¿Quién soy?',
      expectsReply: true,
    });
    expect(w.sent[0].opts).toEqual({
      reply_markup: { force_reply: true, input_field_placeholder: 'Respuesta para Ana' },
    });
  });

  test('the placeholder follows the locale and fits the 64-char Telegram limit', async () => {
    w = makeWorld({ bots: [{ id: 'bot1', name: 'Bot', relay: { locale: 'en' } }] });
    seedPeople(w);
    const op = w.service.ensureOperator('bot1')!;
    const from = { ...anaFrom(w), displayName: `Ana ${'x'.repeat(80)}` };
    await w.service.send({ botId: 'bot1', from, to: op, text: 'Hi', expectsReply: true });
    const placeholder = (w.sent[0].opts as any).reply_markup.input_field_placeholder as string;
    expect(placeholder.startsWith('Reply to Ana')).toBe(true);
    expect(placeholder.length).toBeLessThanOrEqual(64);
  });

  test('no force_reply without expectsReply, nor on answers', async () => {
    w = makeWorld();
    seedPeople(w);
    const op = w.service.ensureOperator('bot1')!;
    await w.service.send({
      botId: 'bot1',
      from: anaFrom(w),
      to: op,
      text: 'Aviso',
      expectsReply: false,
    });
    const q = await w.service.send({
      botId: 'bot1',
      from: anaFrom(w),
      to: op,
      text: '¿Quién soy?',
      expectsReply: true,
    });
    const opParty = w.service.speaker('bot1', {
      channelKind: 'telegram',
      address: String(OP_CHAT),
      displayName: 'Op',
    });
    await w.service.send({
      botId: 'bot1',
      from: opParty,
      to: ana(w),
      text: 'Sos Ana',
      expectsReply: false,
      answering: q.record,
    });
    expect(w.sent.map((m) => m.opts === undefined)).toEqual([true, false, true]);
  });

  test('preferChannel is a preference: an unusable web address falls back to telegram', async () => {
    w = makeWorld();
    seedPeople(w);
    const op = w.service.ensureOperator('bot1')!;
    const res = await w.service.send({
      botId: 'bot1',
      from: null,
      to: op,
      text: 'Hola',
      expectsReply: false,
      preferChannel: 'web',
    });
    if (res.duplicate) throw new Error('unexpected duplicate');
    expect(res.outcome).toMatchObject({ status: 'delivered', channel: 'telegram' });
    expect(res.outcome.attempts[0]).toMatchObject({ channel: 'web', status: 'failed' });
  });
});

describe('RelayService.botName', () => {
  test("prefers the bot's identity name and falls back to the config name", async () => {
    w = makeWorld({
      bots: [
        { id: 'bot1', name: 'AIBot' },
        { id: 'bot2', name: 'Other' },
      ],
      displayName: (botId) => (botId === 'bot1' ? 'Finny' : undefined),
    });
    expect(w.service.botName('bot1')).toBe('Finny');
    expect(w.service.botName('bot2')).toBe('Other');
    expect(w.service.botName('ghost')).toBe('ghost');
  });

  test('the relay header uses the identity name', async () => {
    w = makeWorld({ bots: [{ id: 'bot1', name: 'AIBot' }], displayName: () => 'Finny' });
    seedPeople(w);
    const op = w.service.ensureOperator('bot1')!;
    const from = w.service.speaker('bot1', {
      channelKind: 'telegram',
      address: String(ANA_CHAT),
      displayName: 'Ana',
    });
    await w.service.send({ botId: 'bot1', from, to: op, text: 'Hola', expectsReply: false });
    expect(w.sent[0].text).toContain('📨 De Ana (vía Finny):');
  });

  test('a throwing or blank identity lookup falls back to the config name', () => {
    w = makeWorld({
      bots: [{ id: 'bot1', name: 'AIBot' }],
      displayName: () => {
        throw new Error('boom');
      },
    });
    expect(w.service.botName('bot1')).toBe('AIBot');
    w.cleanup();
    w = makeWorld({ bots: [{ id: 'bot1', name: 'AIBot' }], displayName: () => '  ' });
    expect(w.service.botName('bot1')).toBe('AIBot');
  });
});

describe('RelayService.routeTelegramReply', () => {
  async function askOperator(w: World) {
    const op = w.service.ensureOperator('bot1')!;
    const from = w.service.speaker('bot1', {
      channelKind: 'telegram',
      address: String(ANA_CHAT),
      displayName: 'Ana',
    });
    const res = await w.service.send({
      botId: 'bot1',
      from,
      to: op,
      text: 'Q',
      expectsReply: true,
    });
    return res.record;
  }

  test('a reply to an open relay is routed back with an ack', async () => {
    w = makeWorld();
    seedPeople(w);
    const relay = await askOperator(w);
    const out = await w.service.routeTelegramReply({
      viaBotId: 'bot1',
      chatAddress: String(OP_CHAT),
      messageId: relay.delivery.telegramMessageId!,
      answererAddress: String(OP_CHAT),
      answererName: 'Op',
      text: 'A',
    });
    expect(out.handled).toBe(true);
    if (!out.handled) return;
    expect(out.ack).toBe('✅ Se lo pasé a Ana.');
    expect(w.sent.at(-1)).toMatchObject({ chatId: ANA_CHAT });
    expect(w.store.get('bot1', relay.id)?.status).toBe('answered');
  });

  test('not a relay message, or a relay that expects no reply → not handled', async () => {
    w = makeWorld();
    seedPeople(w);
    const base = {
      viaBotId: 'bot1',
      chatAddress: String(OP_CHAT),
      answererAddress: String(OP_CHAT),
      answererName: 'Op',
      text: 'A',
    };
    expect((await w.service.routeTelegramReply({ ...base, messageId: 1 })).handled).toBe(false);
    const op = w.service.ensureOperator('bot1')!;
    const noReply = await w.service.send({
      botId: 'bot1',
      from: w.service.speaker('bot1', {
        channelKind: 'telegram',
        address: String(BRUNO_CHAT),
        displayName: 'Bruno',
      }),
      to: op,
      text: 'FYI',
      expectsReply: false,
    });
    const out = await w.service.routeTelegramReply({
      ...base,
      messageId: noReply.record.delivery.telegramMessageId!,
    });
    expect(out.handled).toBe(false);
  });

  test('a bot-originated relay (from null) is never short-circuited', async () => {
    w = makeWorld();
    seedPeople(w);
    const op = w.service.ensureOperator('bot1')!;
    const res = await w.service.send({
      botId: 'bot1',
      from: null,
      to: op,
      text: 'Status',
      expectsReply: true,
    });
    const out = await w.service.routeTelegramReply({
      viaBotId: 'bot1',
      chatAddress: String(OP_CHAT),
      messageId: res.record.delivery.telegramMessageId!,
      answererAddress: String(OP_CHAT),
      answererName: 'Op',
      text: 'ok',
    });
    expect(out.handled).toBe(false);
  });

  test('when the answer cannot be delivered the answerer is told plainly', async () => {
    w = makeWorld();
    seedPeople(w);
    const relay = await askOperator(w);
    w.instances.set(
      'bot1',
      (await import('./fixture')).fakeTelegram('bot1', w.sent, (chatId) =>
        chatId === ANA_CHAT ? tgError(403, 'Forbidden: bot was blocked by the user') : null
      )
    );
    const out = await w.service.routeTelegramReply({
      viaBotId: 'bot1',
      chatAddress: String(OP_CHAT),
      messageId: relay.delivery.telegramMessageId!,
      answererAddress: String(OP_CHAT),
      answererName: 'Op',
      text: 'A',
    });
    expect(out.handled).toBe(true);
    if (!out.handled) return;
    expect(out.ack).toBe('⚠️ No pude pasarle tu respuesta a Ana. No le llegó nada.');
    expect(w.store.get('bot1', relay.id)?.status).toBe('delivered');
  });
});

describe('RelayService.promptSections', () => {
  test("renders the speaker's relay sections ('' when none)", async () => {
    w = makeWorld();
    seedPeople(w);
    const anaParty = w.service.speaker('bot1', {
      channelKind: 'telegram',
      address: String(ANA_CHAT),
      displayName: 'Ana',
    });
    expect(w.service.promptSections('bot1', anaParty)).toBe('');
    const op = w.service.ensureOperator('bot1')!;
    await w.service.send({ botId: 'bot1', from: anaParty, to: op, text: 'Q', expectsReply: true });
    expect(w.service.promptSections('bot1', anaParty)).toContain('→ Op');
  });

  test('never throws', () => {
    w = makeWorld();
    (w.store as any).openFor = () => {
      throw new Error('boom');
    };
    expect(
      w.service.promptSections('bot1', { channelKind: 'telegram', address: '1', displayName: 'x' })
    ).toBe('');
  });
});
