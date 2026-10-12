/**
 * send_message on top of relays: honest delivery statuses, sender attribution
 * from `_requester`, policy, dedupe and `replyTo`. Synthetic data only.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import type { RelayParty } from '../src/relay';
import { createSendMessageTool } from '../src/tools/send-message';
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
} from './relay/fixture';

let w: World;
afterEach(() => w?.cleanup());

function setup(opts: Parameters<typeof makeWorld>[0] = {}) {
  w = makeWorld(opts);
  seedPeople(w);
  return createSendMessageTool({ userDirectory: w.directory, relays: w.service });
}

const party = (address: number, displayName: string): RelayParty => ({
  displayName,
  channelKind: 'telegram',
  address: String(address),
});
const anaSpeaking = () => w.service.speaker('bot1', party(ANA_CHAT, 'Ana'));
const opSpeaking = () => w.service.speaker('bot1', party(OP_CHAT, 'Op'));

const run = (tool: ReturnType<typeof setup>, args: Record<string, unknown>) =>
  tool.execute({ _botId: 'bot1', ...args }, silentLogger);

describe('send_message — validation and lookup', () => {
  test('missing recipient, missing message, too long', async () => {
    const tool = setup();
    expect((await run(tool, { message: 'x' })).content).toBe('Missing recipient');
    expect((await run(tool, { recipient: 'Ana' })).content).toBe('Missing message');
    expect((await run(tool, { recipient: 'Ana', message: 'x'.repeat(4001) })).content).toBe(
      'Message too long (max 4000 chars)'
    );
  });

  test('unknown contact without register asks for details', async () => {
    const tool = setup();
    const r = await run(tool, { recipient: 'Zoe', message: 'hola' });
    expect(r.success).toBe(false);
    expect(r.content).toContain('not found in directory');
  });

  test('several matches return a list with ids', async () => {
    const tool = setup();
    w.directory.register('bot1', {
      displayName: 'Ana Two',
      channel: { kind: 'telegram', address: '1003', verified: true },
    });
    w.directory.register('bot1', {
      displayName: 'Ana Three',
      channel: { kind: 'telegram', address: '1004', verified: true },
    });
    const r = await run(tool, { recipient: 'Ana T', message: 'hola' });
    expect(r.success).toBe(false);
    expect(r.content).toContain('Multiple contacts match');
    expect(r.content).toContain('id: ');
  });

  test('register adds an unverified contact and delivers', async () => {
    const tool = setup();
    const r = await run(tool, {
      recipient: 'Carla',
      message: 'hola',
      register: { displayName: 'Carla', channelKind: 'telegram', address: '1005' },
    });
    expect(r.success).toBe(true);
    expect(w.sent.at(-1)).toMatchObject({ chatId: 1005, text: 'hola' });
    expect(w.directory.find('bot1', 'Carla')[0].channels[0].verified).toBe(false);
  });

  test('"operator" resolves to the seeded operator, even when it was in the directory twice', async () => {
    const tool = setup();
    w.directory.register('bot1', {
      displayName: 'Op',
      channel: { kind: 'telegram', address: String(OP_CHAT), verified: true },
    });
    w.directory.register('bot1', {
      displayName: 'Op (operator)',
      channel: { kind: 'web', address: 'op@example.test', verified: true },
    });
    for (const recipient of ['operator', 'Op', 'operador', 'Op (operator)']) {
      const r = await run(tool, {
        recipient,
        message: `ping ${recipient}`,
        _requester: anaSpeaking(),
      });
      expect(r.content).toStartWith('Delivered to Op via telegram');
    }
  });
});

describe('send_message — delivery statuses', () => {
  test('the bot speaking (no requester): bare text, delivered', async () => {
    const tool = setup();
    const r = await run(tool, { recipient: 'Ana', message: 'Hola Ana' });
    expect(r.success).toBe(true);
    expect(r.content).toMatch(/^Delivered to Ana via telegram \(relay r-[0-9a-f]{8}\)\.$/);
    expect(w.sent).toEqual([expect.objectContaining({ chatId: ANA_CHAT, text: 'Hola Ana' })]);
  });

  test('a requester is attributed in the header; expectsReply explains the return path', async () => {
    const tool = setup();
    const r = await run(tool, {
      recipient: 'operator',
      message: '¿Quién soy?',
      expectsReply: true,
      _requester: anaSpeaking(),
    });
    expect(r.success).toBe(true);
    const id = /relay (r-[0-9a-f]{8})/.exec(r.content)![1];
    expect(r.content).toContain(
      `When they reply to that message it will be forwarded to Ana automatically; if they answer in free text, close it with send_message replyTo=${id}.`
    );
    expect(w.sent[0].text).toBe(
      '📨 De Ana (vía Bot):\n\n¿Quién soy?\n\n↩️ Respondé a este mensaje y se lo paso a Ana.'
    );
    expect(w.store.get('bot1', id)).toMatchObject({ expectsReply: true, status: 'delivered' });
  });

  test('carried by another bot instance: says so', async () => {
    const tool = setup({ instances: ['bot2'] });
    const r = await run(tool, { recipient: 'Ana', message: 'hola' });
    expect(r.content).toStartWith("Delivered to Ana via telegram (through bot2's account)");
  });

  test('queued (web only, nobody connected): NOT delivered', async () => {
    const tool = setup();
    w.directory.register('bot1', {
      displayName: 'Dora',
      channel: { kind: 'web', address: '4242', verified: true },
    });
    const r = await run(tool, { recipient: 'Dora', message: 'hola' });
    expect(r.success).toBe(false);
    expect(r.content).toMatch(
      /^NOT delivered — Dora has no reachable channel right now \(no live connection; stored, not notified\)\. Stored as relay r-[0-9a-f]{8}\. Do not tell anyone it was delivered\.$/
    );
  });

  // `channel` used to restrict the routes; an agent loop that remembered
  // "channel: web" for the operator then failed every send. It is a preference.
  test('channel is a preference: an offline web route falls back to telegram', async () => {
    const tool = setup();
    const ana = w.directory.findByChannel('bot1', 'telegram', String(ANA_CHAT))!;
    w.directory.addChannel('bot1', ana.id, { kind: 'web', address: '4343', verified: true });
    const r = await run(tool, { recipient: 'Ana', message: 'hola', channel: 'web' });
    expect(r.content).toStartWith('Delivered to Ana via telegram');
    expect(w.sent).toHaveLength(1);
  });

  test('channel web for the operator (email address): refused, then delivered via telegram', async () => {
    const tool = setup();
    w.service.ensureOperator('bot1');
    const r = await run(tool, { recipient: 'operator', message: 'reporte', channel: 'web' });
    expect(r.success).toBe(true);
    expect(r.content).toStartWith('Delivered to Op via telegram');
    expect(w.sent[0]).toMatchObject({ chatId: OP_CHAT });
    const record = w.store.get('bot1', /relay (r-[0-9a-f]{8})/.exec(r.content)![1])!;
    expect(record.delivery.attempts.map((a) => `${a.channel}:${a.status}`)).toEqual([
      'web:failed',
      'telegram:delivered',
    ]);
  });

  test('a channel the contact does not have is just skipped', async () => {
    const tool = setup();
    const r = await run(tool, { recipient: 'Ana', message: 'hola', channel: 'whatsapp' });
    expect(r.content).toStartWith('Delivered to Ana via telegram');
  });

  test('the old id of a merged contact still reaches it', async () => {
    const tool = setup();
    w.directory.register('bot1', {
      displayName: 'Op',
      channel: { kind: 'telegram', address: String(OP_CHAT), verified: true },
    });
    const web = w.directory.register('bot1', {
      displayName: 'Op (operator)',
      channel: { kind: 'web', address: 'op@example.test', verified: true },
    });
    w.directory.getById('bot1', web.id)!.firstSeen = Date.now() + 60_000; // folded, not kept
    const op = w.service.ensureOperator('bot1')!;
    expect(op.id).not.toBe(web.id);
    const r = await run(tool, { recipient: web.id, message: 'hola' });
    expect(r.content).toStartWith('Delivered to Op via telegram');
  });

  test('a 403 on the first instance falls through to the next; all failing → FAILED', async () => {
    const tool = setup({ instances: ['bot1', 'bot2'] });
    const blocked = () => tgError(403, 'Forbidden: bot was blocked by the user');
    w.instances.set('bot1', fakeTelegram('bot1', w.sent, blocked));
    const ok = await run(tool, { recipient: 'Ana', message: 'uno' });
    expect(ok.content).toStartWith("Delivered to Ana via telegram (through bot2's account)");

    w.instances.set('bot2', fakeTelegram('bot2', w.sent, blocked));
    const r = await run(tool, { recipient: 'Ana', message: 'dos' });
    expect(r.success).toBe(false);
    expect(r.content).toStartWith('Delivery FAILED to Ana: Not delivered — telegram via bot1');
    expect(r.content).toEndWith(
      'Nothing was sent. Do not claim it was sent; tell the requester plainly.'
    );
  });

  test('the same message within 10 minutes is not re-sent', async () => {
    const tool = setup();
    const first = await run(tool, { recipient: 'Ana', message: 'hola' });
    const id = /relay (r-[0-9a-f]{8})/.exec(first.content)![1];
    const again = await run(tool, { recipient: 'Ana', message: 'Hola ' });
    expect(w.sent).toHaveLength(1);
    expect(again.success).toBe(true);
    expect(again.content).toBe(
      `Already delivered to Ana (relay ${id}, status delivered). Do not resend it.`
    );
  });
});

describe('send_message — policy', () => {
  test('person to person is refused by default', async () => {
    const tool = setup();
    const r = await run(tool, { recipient: 'Bruno', message: 'hola', _requester: anaSpeaking() });
    expect(r.success).toBe(false);
    expect(r.content).toContain('relay.peerToPeer');
    expect(w.sent).toEqual([]);
  });

  test('person to person is allowed with relay.peerToPeer', async () => {
    const tool = setup({ bots: [{ id: 'bot1', name: 'Bot', relay: { peerToPeer: true } }] });
    const r = await run(tool, { recipient: 'Bruno', message: 'hola', _requester: anaSpeaking() });
    expect(r.success).toBe(true);
    expect(w.sent[0]).toMatchObject({ chatId: BRUNO_CHAT });
  });

  test('relay.enabled false: the bot speaks for itself (no attribution, no return path)', async () => {
    const tool = setup({ bots: [{ id: 'bot1', name: 'Bot', relay: { enabled: false } }] });
    const r = await run(tool, {
      recipient: 'Bruno',
      message: 'hola',
      expectsReply: true,
      _requester: anaSpeaking(),
    });
    expect(r.success).toBe(true);
    expect(w.sent[0].text).toBe('hola');
    expect(r.content).not.toContain('forwarded');
  });
});

describe('send_message — replyTo', () => {
  async function anaAsksOperator(tool: ReturnType<typeof setup>) {
    const r = await run(tool, {
      recipient: 'operator',
      message: '¿Quién soy?',
      expectsReply: true,
      _requester: anaSpeaking(),
    });
    return /relay (r-[0-9a-f]{8})/.exec(r.content)![1];
  }

  test('the recipient answers in free text: routed to the requester, original answered', async () => {
    const tool = setup();
    const id = await anaAsksOperator(tool);
    const r = await run(tool, { replyTo: id, message: 'Sos Ana', _requester: opSpeaking() });
    expect(r.success).toBe(true);
    expect(r.content).toStartWith('Delivered to Ana via telegram');
    expect(w.sent.at(-1)!.chatId).toBe(ANA_CHAT);
    expect(w.sent.at(-1)!.text).toBe('↩️ Respuesta de Op (vía Bot) a: «¿Quién soy?»\n\nSos Ana');
    expect(w.store.get('bot1', id)?.status).toBe('answered');
  });

  test('unknown relay id', async () => {
    const tool = setup();
    const r = await run(tool, { replyTo: 'r-00000000', message: 'x', _requester: opSpeaking() });
    expect(r.success).toBe(false);
    expect(r.content).toBe('Relay r-00000000 not found.');
  });

  test('only the person the relay was for can answer it', async () => {
    const tool = setup();
    const id = await anaAsksOperator(tool);
    const bruno = w.service.speaker('bot1', party(BRUNO_CHAT, 'Bruno'));
    const r = await run(tool, { replyTo: id, message: 'x', _requester: bruno });
    expect(r.success).toBe(false);
    expect(r.content).toContain('was addressed to Op');
    expect(w.store.get('bot1', id)?.status).toBe('delivered');
  });

  test('an answered relay cannot be answered again', async () => {
    const tool = setup();
    const id = await anaAsksOperator(tool);
    await run(tool, { replyTo: id, message: 'Sos Ana', _requester: opSpeaking() });
    const r = await run(tool, { replyTo: id, message: 'Otra cosa', _requester: opSpeaking() });
    expect(r.success).toBe(false);
    expect(r.content).toContain('already answered');
  });
});
