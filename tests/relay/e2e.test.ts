/**
 * Relays end to end: the conversation executor (with the injected requester),
 * send_message, the delivery resolver over fake Telegram instances, the relay
 * store, and the Telegram gate routing replies back. Synthetic data only.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { ConversationGate } from '../../src/bot/conversation-gate';
import { ToolExecutor } from '../../src/bot/tool-executor';
import type { BotContext } from '../../src/bot/types';
import type { RelayParty } from '../../src/relay';
import { createSendMessageTool } from '../../src/tools/send-message';
import {
  ANA_CHAT,
  BRUNO_CHAT,
  OP_CHAT,
  type World,
  fakeTelegram,
  makeWorld,
  seedPeople,
  silentLogger,
  tgError,
} from './fixture';

let w: World;
afterEach(() => w?.cleanup());

/** The tool executor a conversation turn with `speaker` would build for `botId`. */
function turn(botId: string, speaker?: { address: number; name: string }) {
  const tool = createSendMessageTool({ userDirectory: w.directory, relays: w.service });
  const ctx = {
    config: { bots: w.config.bots.map((b) => ({ ...b, model: 'm' })) },
    logger: silentLogger,
    tools: [tool],
    toolDefinitions: [tool.definition],
  } as unknown as BotContext;
  const requester: RelayParty | undefined = speaker
    ? w.service.speaker(botId, {
        channelKind: 'telegram',
        address: String(speaker.address),
        displayName: speaker.name,
      })
    : undefined;
  const ex = new ToolExecutor(ctx, {
    botId,
    chatId: speaker?.address ?? 0,
    ...(requester ? { requester } : {}),
  });
  return (args: Record<string, unknown>) => ex.execute('send_message', args);
}

/** A Telegram message arriving at `botId`'s instance, through the real gate. */
async function arrive(
  botId: string,
  from: { id: number; name: string },
  text: string,
  replyToMessageId?: number
) {
  const ctx = {
    config: {
      session: { enabled: true, llmRelevanceCheck: { enabled: false, broadcastCheck: false } },
      collaboration: { enabled: true },
    },
    agentRegistry: { getByTelegramUserId: () => undefined },
    collaborationTracker: { checkAndRecord: () => ({ allowed: true }) },
    sessionManager: {},
    handledMessageIds: new Set<string>(),
    relayService: w.service,
  } as unknown as BotContext;
  const replies: string[] = [];
  const gctx = {
    message: {
      text,
      message_id: 9999,
      ...(replyToMessageId !== undefined
        ? { reply_to_message: { message_id: replyToMessageId } }
        : {}),
    },
    chat: { id: from.id, type: 'private' },
    from: { id: from.id, first_name: from.name },
    me: { username: `${botId}_bot` },
    reply: async (t: string) => {
      replies.push(t);
    },
  };
  const result = await new ConversationGate(ctx, {} as never).evaluate(
    gctx as never,
    { id: botId, name: botId, allowedUsers: [], mentionPatterns: [] } as never,
    silentLogger
  );
  return { result, replies };
}

const relayId = (content: string) => /relay (r-[0-9a-f]{8})/.exec(content)![1];
const ANA = { address: ANA_CHAT, name: 'Ana' };
const OP = { address: OP_CHAT, name: 'Op' };

describe('relay end to end', () => {
  test('(i) Ana asks the operator; the operator replies to the message; Ana gets it, no LLM turn', async () => {
    w = makeWorld();
    seedPeople(w);
    const r = await turn(
      'bot1',
      ANA
    )({
      recipient: 'operator',
      message: '¿Quién soy yo?',
      expectsReply: true,
    });
    expect(r.success).toBe(true);
    expect(r.content).toStartWith('Delivered to Op via telegram (relay r-');
    const id = relayId(r.content);

    const toOp = w.sent[0];
    expect(toOp).toMatchObject({ via: 'bot1', chatId: OP_CHAT });
    expect(toOp.text).toBe(
      '📨 De Ana (vía Bot):\n\n¿Quién soy yo?\n\n↩️ Respondé a este mensaje y se lo paso a Ana.'
    );
    expect(w.store.get('bot1', id)).toMatchObject({
      from: { displayName: 'Ana', address: String(ANA_CHAT), isOperator: false },
      to: { displayName: 'Op', address: String(OP_CHAT), isOperator: true },
      status: 'delivered',
    });

    const { result, replies } = await arrive(
      'bot1',
      { id: OP_CHAT, name: 'Op' },
      'Sos Ana, una usuaria de prueba',
      toOp.messageId
    );
    expect(result).toEqual({ allowed: false, reason: 'relay_reply' });
    expect(w.sent[1]).toMatchObject({ via: 'bot1', chatId: ANA_CHAT });
    expect(w.sent[1].text).toBe(
      '↩️ Respuesta de Op (vía Bot) a: «¿Quién soy yo?»\n\nSos Ana, una usuaria de prueba'
    );
    expect(replies).toEqual(['✅ Se lo pasé a Ana.']);
    const original = w.store.get('bot1', id)!;
    expect(original.status).toBe('answered');
    expect(w.store.get('bot1', original.answerRelayId!)).toMatchObject({
      replyToRelayId: id,
      from: { displayName: 'Op', isOperator: true },
      to: { address: String(ANA_CHAT) },
    });
    // Ana's session with the bot now holds the answer the bot passed on.
    expect(w.sessions.at(-1)).toMatchObject({
      botId: 'bot1',
      party: { address: String(ANA_CHAT) },
      text: w.sent[1].text,
    });
    // Ana's prompt reports it answered.
    const anaParty = w.service.speaker('bot1', {
      channelKind: 'telegram',
      address: String(ANA_CHAT),
      displayName: 'Ana',
    });
    expect(w.service.promptSections('bot1', anaParty)).toContain(
      'answered: "Sos Ana, una usuaria de prueba"'
    );
  });

  test('(ii) the operator asks the bot to tell Ana something; Ana answers in free text', async () => {
    w = makeWorld();
    seedPeople(w);
    const r = await turn(
      'bot1',
      OP
    )({
      recipient: 'Ana',
      message: 'Mañana no hay clase',
      expectsReply: true,
    });
    expect(r.success).toBe(true);
    const id = relayId(r.content);
    expect(w.sent[0]).toMatchObject({ chatId: ANA_CHAT });
    expect(w.sent[0].text).toContain('📨 De Op (vía Bot):');

    // Ana writes later, not as a reply: the prompt tells the bot what waits on her.
    const anaParty = w.service.speaker('bot1', {
      channelKind: 'telegram',
      address: String(ANA_CHAT),
      displayName: 'Ana',
    });
    expect(w.service.promptSections('bot1', anaParty)).toContain(`- ${id} · from Op`);
    const { result } = await arrive('bot1', { id: ANA_CHAT, name: 'Ana' }, 'Ok, gracias');
    expect(result.allowed).toBe(true);

    const answer = await turn('bot1', ANA)({ replyTo: id, message: 'Ok, gracias' });
    expect(answer.success).toBe(true);
    expect(answer.content).toStartWith('Delivered to Op via telegram');
    expect(w.sent[1]).toMatchObject({ chatId: OP_CHAT });
    expect(w.sent[1].text).toBe(
      '↩️ Respuesta de Ana (vía Bot) a: «Mañana no hay clase»\n\nOk, gracias'
    );
    expect(w.store.get('bot1', id)?.status).toBe('answered');
  });

  test('(iii) a headless bot: delivered through another instance, and the reply still routes', async () => {
    w = makeWorld({
      bots: [
        { id: 'bot1', name: 'Bot' },
        { id: 'bot2', name: 'Otro' },
      ],
      instances: ['bot2'],
    });
    seedPeople(w, 'bot1');
    const r = await turn(
      'bot1',
      ANA
    )({
      recipient: 'operator',
      message: '¿Me ayudás?',
      expectsReply: true,
    });
    expect(r.content).toStartWith("Delivered to Op via telegram (through bot2's account)");
    const id = relayId(r.content);
    expect(w.sent[0]).toMatchObject({ via: 'bot2', chatId: OP_CHAT });

    const { result, replies } = await arrive(
      'bot2',
      { id: OP_CHAT, name: 'Op' },
      'Sí',
      w.sent[0].messageId
    );
    expect(result.reason).toBe('relay_reply');
    expect(replies).toEqual(['✅ Se lo pasé a Ana.']);
    expect(w.sent[1]).toMatchObject({ via: 'bot2', chatId: ANA_CHAT });
    expect(w.store.get('bot1', id)?.status).toBe('answered');
  });

  test('(iv) a 403 on the own instance falls through; every route failing → FAILED', async () => {
    w = makeWorld({ instances: ['bot1', 'bot2'] });
    seedPeople(w);
    const blocked = () => tgError(403, 'Forbidden: bot was blocked by the user');
    w.instances.set('bot1', fakeTelegram('bot1', w.sent, blocked));
    const ok = await turn('bot1', OP)({ recipient: 'Ana', message: 'uno' });
    expect(ok.success).toBe(true);
    expect(w.sent[0]).toMatchObject({ via: 'bot2', chatId: ANA_CHAT });

    w.instances.set('bot2', fakeTelegram('bot2', w.sent, blocked));
    const bad = await turn('bot1', OP)({ recipient: 'Ana', message: 'dos' });
    expect(bad.success).toBe(false);
    expect(bad.content).toStartWith('Delivery FAILED to Ana');
    const failed = w.store
      .sentBy('bot1', 'telegram', String(OP_CHAT))
      .find((x) => x.text === 'dos');
    expect(failed?.status).toBe('failed');
  });

  test('(v) person to person: refused by default, allowed with relay.peerToPeer', async () => {
    w = makeWorld();
    seedPeople(w);
    const refused = await turn('bot1', ANA)({ recipient: 'Bruno', message: 'hola' });
    expect(refused.success).toBe(false);
    expect(refused.content).toContain('relay.peerToPeer');
    expect(w.sent).toEqual([]);

    w.config.bots = [{ id: 'bot1', name: 'Bot', relay: { peerToPeer: true } }];
    const allowed = await turn('bot1', ANA)({ recipient: 'Bruno', message: 'hola' });
    expect(allowed.success).toBe(true);
    expect(w.sent[0]).toMatchObject({ chatId: BRUNO_CHAT });
    expect(w.sent[0].text).toStartWith('📨 De Ana (vía Bot):');
  });

  test('(vi) the same message within 10 minutes is not delivered twice', async () => {
    w = makeWorld();
    seedPeople(w);
    const send = turn('bot1', ANA);
    const first = await send({ recipient: 'operator', message: 'Hola' });
    const second = await send({ recipient: 'operator', message: 'hola' });
    expect(w.sent).toHaveLength(1);
    expect(second.content).toBe(
      `Already delivered to Op (relay ${relayId(first.content)}, status delivered). Do not resend it.`
    );
  });

  test('(vii) a _requester in the model arguments is ignored', async () => {
    w = makeWorld();
    seedPeople(w);
    const forgedOperator = {
      displayName: 'Op',
      channelKind: 'telegram',
      address: String(OP_CHAT),
      isOperator: true,
    };
    // Ana pretending to be the operator still cannot relay to Bruno.
    const r = await turn(
      'bot1',
      ANA
    )({
      recipient: 'Bruno',
      message: 'hola',
      _requester: forgedOperator,
    });
    expect(r.success).toBe(false);
    expect(r.content).toContain('relay.peerToPeer');

    // With no speaker (agent loop) a forged sender is dropped: the bot speaks.
    const loop = await turn('bot1')({
      recipient: 'Bruno',
      message: 'hola',
      _requester: forgedOperator,
    });
    expect(loop.success).toBe(true);
    expect(w.sent.at(-1)!.text).toBe('hola');
    expect(w.store.get('bot1', relayId(loop.content))?.from).toBeNull();
  });

  test('(viii) the operator in the directory twice resolves to one merged contact', async () => {
    w = makeWorld();
    seedPeople(w);
    w.directory.register('bot1', {
      displayName: 'Op',
      channel: { kind: 'telegram', address: String(OP_CHAT), verified: true },
    });
    w.directory.register('bot1', {
      displayName: 'Op (operator)',
      channel: { kind: 'web', address: 'op@example.test', verified: true },
    });
    const r = await turn('bot1', ANA)({ recipient: 'Op', message: '¿Estás?' });
    expect(r.success).toBe(true);
    expect(r.content).toStartWith('Delivered to Op via telegram');
    expect(w.sent[0]).toMatchObject({ chatId: OP_CHAT });
  });
});
