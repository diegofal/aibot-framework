import { describe, expect, test } from 'bun:test';
import type { ContactEntry } from '../../src/bot/user-directory';
import {
  type DeliveryDeps,
  deliverToContact,
  isTelegramUnreachable,
} from '../../src/relay/delivery';

const silentLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  child: () => silentLogger,
} as any;

type Sent = { via: string; chatId: number | string; text: string };

function tgInstance(botId: string, sent: Sent[], fail?: (chatId: number | string) => Error | null) {
  let nextId = 100;
  return {
    botId,
    api: {
      async sendMessage(chatId: number | string, text: string) {
        const err = fail?.(chatId);
        if (err) throw err;
        sent.push({ via: botId, chatId, text });
        return { message_id: nextId++ };
      },
    },
  };
}

/** grammy-shaped Telegram error. */
function tgError(code: number, description: string): Error {
  return Object.assign(new Error(`Call to 'sendMessage' failed! (${code}: ${description})`), {
    error_code: code,
    description,
  });
}

function contact(channels: ContactEntry['channels']): ContactEntry {
  return { id: 'c-ana', displayName: 'Ana', channels, firstSeen: 1, lastSeen: 1 };
}

function deps(overrides: Partial<DeliveryDeps> = {}): DeliveryDeps & { web: Sent[] } {
  const web: Sent[] = [];
  return {
    web,
    telegramInstances: () => [],
    appendWebSession: (botId, address, text) => web.push({ via: botId, chatId: address, text }),
    logger: silentLogger,
    ...overrides,
  };
}

describe('deliverToContact', () => {
  test('reports the address it actually reached (second channel after the first failed)', async () => {
    const sent: Sent[] = [];
    const d = deps({
      telegramInstances: () => [
        tgInstance('bot1', sent, (chatId) =>
          chatId === 1001 ? tgError(400, 'Bad Request: chat not found') : null
        ),
      ],
    });
    const out = await deliverToContact(
      'bot1',
      contact([
        { kind: 'telegram', address: '1001', verified: true },
        { kind: 'telegram', address: '2002', verified: false },
      ]),
      'hola',
      d
    );
    expect(out).toMatchObject({ status: 'delivered', channel: 'telegram', address: '2002' });
  });

  test('a queued web delivery reports the session address', async () => {
    const out = await deliverToContact(
      'bot1',
      contact([{ kind: 'web', address: '5150', verified: true }]),
      'hola',
      deps()
    );
    expect(out).toMatchObject({ status: 'queued', channel: 'web', address: '5150' });
  });

  test('telegram via the own instance first: delivered with message id', async () => {
    const sent: Sent[] = [];
    const d = deps({
      telegramInstances: () => [tgInstance('bot1', sent), tgInstance('bot2', sent)],
    });
    const out = await deliverToContact(
      'bot1',
      contact([{ kind: 'telegram', address: '1001', verified: true }]),
      'hola',
      d
    );
    expect(out).toMatchObject({
      status: 'delivered',
      channel: 'telegram',
      viaBotId: 'bot1',
      telegramMessageId: 100,
    });
    expect(sent).toEqual([{ via: 'bot1', chatId: 1001, text: 'hola' }]);
    expect(out.attempts).toEqual([{ channel: 'telegram', viaBotId: 'bot1', status: 'delivered' }]);
  });

  test('a 403 / chat-not-found on one instance moves on to the next', async () => {
    const sent: Sent[] = [];
    const d = deps({
      telegramInstances: () => [
        tgInstance('bot1', sent, () => tgError(403, 'Forbidden: bot was blocked by the user')),
        tgInstance('bot2', sent, () => tgError(400, 'Bad Request: chat not found')),
        tgInstance('bot3', sent),
      ],
    });
    const out = await deliverToContact(
      'bot1',
      contact([{ kind: 'telegram', address: '1001', verified: true }]),
      'hola',
      d
    );
    expect(out.status).toBe('delivered');
    expect(out.viaBotId).toBe('bot3');
    expect(out.attempts.map((a) => [a.viaBotId, a.status])).toEqual([
      ['bot1', 'failed'],
      ['bot2', 'failed'],
      ['bot3', 'delivered'],
    ]);
    expect(out.attempts[0].error).toContain('blocked');
  });

  test('other telegram errors are recorded and the next instance is tried', async () => {
    const sent: Sent[] = [];
    const d = deps({
      telegramInstances: () => [
        tgInstance('bot1', sent, () => new Error('socket hang up')),
        tgInstance('bot2', sent),
      ],
    });
    const out = await deliverToContact(
      'bot1',
      contact([{ kind: 'telegram', address: '1001', verified: true }]),
      'hola',
      d
    );
    expect(out.status).toBe('delivered');
    expect(out.attempts[0]).toMatchObject({
      viaBotId: 'bot1',
      status: 'failed',
      error: 'socket hang up',
    });
  });

  test('verified telegram channels are tried before unverified ones', async () => {
    const sent: Sent[] = [];
    const d = deps({ telegramInstances: () => [tgInstance('bot1', sent)] });
    await deliverToContact(
      'bot1',
      contact([
        { kind: 'telegram', address: '2002', verified: false },
        { kind: 'telegram', address: '1001', verified: true },
      ]),
      'hola',
      d
    );
    expect(sent[0].chatId).toBe(1001);
  });

  test('a non-numeric telegram address is skipped as failed', async () => {
    const sent: Sent[] = [];
    const d = deps({ telegramInstances: () => [tgInstance('bot1', sent)] });
    const out = await deliverToContact(
      'bot1',
      contact([{ kind: 'telegram', address: '@ana', verified: true }]),
      'hola',
      d
    );
    expect(out.status).toBe('failed');
    expect(sent).toHaveLength(0);
  });

  test('whatsapp after telegram fails', async () => {
    const wa: string[] = [];
    const sent: Sent[] = [];
    const d = deps({
      telegramInstances: () => [tgInstance('bot1', sent, () => tgError(403, 'Forbidden'))],
      sendWhatsApp: async (_bot, address) => {
        wa.push(address);
      },
    });
    const out = await deliverToContact(
      'bot1',
      contact([
        { kind: 'whatsapp', address: '+5400000001', verified: true },
        { kind: 'telegram', address: '1001', verified: true },
      ]),
      'hola',
      d
    );
    expect(out).toMatchObject({ status: 'delivered', channel: 'whatsapp' });
    expect(wa).toEqual(['+5400000001']);
    expect(out.attempts.map((a) => a.channel)).toEqual(['telegram', 'whatsapp']);
  });

  test('whatsapp without a sender dep is not attempted', async () => {
    const out = await deliverToContact(
      'bot1',
      contact([{ kind: 'whatsapp', address: '+5400000001', verified: true }]),
      'hola',
      deps()
    );
    expect(out.status).toBe('failed');
    expect(out.error).toBeTruthy();
  });

  test('web with a live connection: stored and delivered', async () => {
    const d = deps({ isWebLive: () => true });
    const out = await deliverToContact(
      'bot1',
      contact([{ kind: 'web', address: '42', verified: true }]),
      'hola',
      d
    );
    expect(out).toMatchObject({ status: 'delivered', channel: 'web' });
    expect(d.web).toEqual([{ via: 'bot1', chatId: '42', text: 'hola' }]);
  });

  test('web without a live connection: stored, queued, not notified', async () => {
    const d = deps({ isWebLive: () => false });
    const out = await deliverToContact(
      'bot1',
      contact([{ kind: 'web', address: '42', verified: true }]),
      'hola',
      d
    );
    expect(out.status).toBe('queued');
    expect(out.channel).toBe('web');
    expect(out.error).toContain('not notified');
    expect(d.web).toHaveLength(1);
  });

  test('a non-numeric web address is never written (it would land in the shared widget session)', async () => {
    const d = deps({ isWebLive: () => true });
    const out = await deliverToContact(
      'bot1',
      contact([{ kind: 'web', address: 'op@example.test', verified: false }]),
      'hola',
      d
    );
    expect(out.status).toBe('failed');
    expect(d.web).toHaveLength(0);
    expect(out.attempts[0]).toMatchObject({ channel: 'web', status: 'failed' });
  });

  test('telegram wins over web; web is only the fallback', async () => {
    const sent: Sent[] = [];
    const d = deps({ telegramInstances: () => [tgInstance('bot1', sent)] });
    const out = await deliverToContact(
      'bot1',
      contact([
        { kind: 'web', address: '42', verified: true },
        { kind: 'telegram', address: '1001', verified: true },
      ]),
      'hola',
      d
    );
    expect(out.channel).toBe('telegram');
    expect(d.web).toHaveLength(0);
  });

  test('telegram failing everywhere falls back to a queued web copy', async () => {
    const d = deps({
      telegramInstances: () => [tgInstance('bot1', [], () => tgError(403, 'Forbidden'))],
    });
    const out = await deliverToContact(
      'bot1',
      contact([
        { kind: 'telegram', address: '1001', verified: true },
        { kind: 'web', address: '42', verified: true },
      ]),
      'hola',
      d
    );
    expect(out.status).toBe('queued');
    expect(out.attempts.map((a) => [a.channel, a.status])).toEqual([
      ['telegram', 'failed'],
      ['web', 'queued'],
    ]);
  });

  test('no instances and no other channels: failed with a clear error', async () => {
    const out = await deliverToContact(
      'bot1',
      contact([{ kind: 'telegram', address: '1001', verified: true }]),
      'hola',
      deps()
    );
    expect(out.status).toBe('failed');
    expect(out.error).toMatch(/telegram/i);
  });

  test('a contact with no deliverable channel at all: failed', async () => {
    const out = await deliverToContact(
      'bot1',
      contact([{ kind: 'rest', address: 'req-1', verified: true }]),
      'hola',
      deps()
    );
    expect(out.status).toBe('failed');
    expect(out.attempts).toEqual([]);
    expect(out.error).toContain('No deliverable channel');
  });

  test('never throws, even if a dep throws synchronously', async () => {
    const d = deps({
      telegramInstances: () => {
        throw new Error('boom');
      },
      appendWebSession: () => {
        throw new Error('disk full');
      },
    });
    const out = await deliverToContact(
      'bot1',
      contact([
        { kind: 'telegram', address: '1001', verified: true },
        { kind: 'web', address: '42', verified: true },
      ]),
      'hola',
      d
    );
    expect(out.status).toBe('failed');
  });
});

describe('isTelegramUnreachable', () => {
  test('403s, blocked, never-started and unknown chats are unreachable', () => {
    expect(isTelegramUnreachable(tgError(403, 'Forbidden: bot was blocked by the user'))).toBe(
      true
    );
    expect(isTelegramUnreachable(tgError(400, 'Bad Request: chat not found'))).toBe(true);
    expect(
      isTelegramUnreachable(new Error("Forbidden: bot can't initiate conversation with a user"))
    ).toBe(true);
  });

  test('network and rate-limit errors are not', () => {
    expect(isTelegramUnreachable(new Error('socket hang up'))).toBe(false);
    expect(isTelegramUnreachable(tgError(429, 'Too Many Requests: retry after 5'))).toBe(false);
  });
});
