/**
 * Instruction crons on headless bots.
 *
 * `handleCronInstruction` used to start with `this.bots.get(botId)` — the
 * grammy instance map, which only holds bots that came up with a valid
 * Telegram token. Every `kind: 'instruction'` cron owned by a headless bot
 * threw `Bot not found for cron instruction: <id>` before doing any work.
 */
import { describe, expect, test } from 'bun:test';
import { BotManager, buildCronDelivery } from '../../src/bot/bot-manager';

function makeApi(sent: Array<[number, string]>, actions: Array<[number, string]> = []) {
  return {
    sendMessage: async (chatId: number, text: string) => {
      sent.push([chatId, text]);
    },
    sendChatAction: async (chatId: number, action: string) => {
      actions.push([chatId, action]);
    },
  };
}

describe('buildCronDelivery', () => {
  test('delivers over Telegram when an instance is available', async () => {
    const sent: Array<[number, string]> = [];
    const actions: Array<[number, string]> = [];
    const appended: string[] = [];

    const { kind, channel } = buildCronDelivery(555, {
      telegram: makeApi(sent, actions),
      appendToSession: (t) => appended.push(t),
    });

    expect(kind).toBe('telegram');
    expect(channel.kind).toBe('telegram');
    await channel.sendText('briefing');
    await channel.showTyping();

    expect(sent).toEqual([[555, 'briefing']]);
    expect(actions).toEqual([[555, 'typing']]);
    expect(appended).toEqual([]);
  });

  test('falls back to the web session when there is no Telegram instance', async () => {
    const appended: string[] = [];
    const { kind, channel } = buildCronDelivery(555, {
      appendToSession: (t) => appended.push(t),
    });

    expect(kind).toBe('web');
    expect(channel.kind).toBe('web');
    await channel.sendText('briefing');

    expect(appended).toEqual(['briefing']);
  });

  test('showTyping never throws without a Telegram instance', async () => {
    const { channel } = buildCronDelivery(555, { appendToSession: () => {} });
    expect(channel.showTyping()).resolves.toBeUndefined();
  });
});

/** Minimal `this` for BotManager.prototype.handleCronInstruction. */
function makeManagerStub(opts: {
  bots: Map<string, unknown>;
  channelKind?: 'telegram' | 'headless';
  appended: Array<{ key: string; messages: unknown[] }>;
  seen: Array<{ msg: Record<string, unknown>; channelKind: string; botId: string }>;
}) {
  return {
    bots: opts.bots,
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    sessionManager: {
      serializeKey: (k: Record<string, unknown>) => JSON.stringify(k),
      appendMessages: (key: string, messages: unknown[]) => {
        opts.appended.push({ key, messages });
      },
    },
    getChannelState: () =>
      opts.channelKind
        ? { kind: opts.channelKind, state: 'ok', lastError: null, checkedAt: null }
        : undefined,
    handleChannelMessage: async (
      msg: Record<string, unknown>,
      channel: { kind: string },
      botId: string
    ) => {
      opts.seen.push({ msg, channelKind: channel.kind, botId });
      await (channel as { sendText: (t: string) => Promise<void> }).sendText('assistant reply');
      return 'assistant reply';
    },
  };
}

const handleCronInstruction = BotManager.prototype.handleCronInstruction;

describe('BotManager.handleCronInstruction', () => {
  test('a headless bot runs the pipeline instead of throwing', async () => {
    const appended: Array<{ key: string; messages: unknown[] }> = [];
    const seen: Array<{ msg: Record<string, unknown>; channelKind: string; botId: string }> = [];
    const stub = makeManagerStub({
      bots: new Map(),
      channelKind: 'headless',
      appended,
      seen,
    });

    const out = await handleCronInstruction.call(stub as never, 123, 'do the check', 'selfimprove');

    expect(out).toBe('assistant reply');
    expect(seen).toHaveLength(1);
    expect(seen[0].botId).toBe('selfimprove');
    expect(seen[0].msg.channelKind).toBe('web');
    expect(seen[0].channelKind).toBe('web');
    // Reply landed in the bot's web session
    expect(appended).toHaveLength(1);
    expect(appended[0].messages).toEqual([{ role: 'assistant', content: 'assistant reply' }]);
  });

  test('a headless bot is delivered through another running bot Telegram instance', async () => {
    const sent: Array<[number, string]> = [];
    const appended: Array<{ key: string; messages: unknown[] }> = [];
    const seen: Array<{ msg: Record<string, unknown>; channelKind: string; botId: string }> = [];
    const stub = makeManagerStub({
      bots: new Map([['other-bot', { api: makeApi(sent) }]]),
      channelKind: 'headless',
      appended,
      seen,
    });

    const out = await handleCronInstruction.call(
      stub as never,
      777,
      'radar semanal',
      'milei-rocca'
    );

    expect(out).toBe('assistant reply');
    expect(seen[0].msg.channelKind).toBe('telegram');
    expect(sent).toEqual([[777, 'assistant reply']]);
    expect(appended).toEqual([]);
  });

  test('a bot with its own Telegram instance still uses it', async () => {
    const own: Array<[number, string]> = [];
    const other: Array<[number, string]> = [];
    const seen: Array<{ msg: Record<string, unknown>; channelKind: string; botId: string }> = [];
    const stub = makeManagerStub({
      bots: new Map<string, unknown>([
        ['other-bot', { api: makeApi(other) }],
        ['bot1', { api: makeApi(own) }],
      ]),
      channelKind: 'telegram',
      appended: [],
      seen,
    });

    await handleCronInstruction.call(stub as never, 42, 'hello', 'bot1');

    expect(own).toEqual([[42, 'assistant reply']]);
    expect(other).toEqual([]);
    expect(seen[0].msg.channelKind).toBe('telegram');
  });

  test('the synthetic inbound message keeps its cron shape', async () => {
    const seen: Array<{ msg: Record<string, unknown>; channelKind: string; botId: string }> = [];
    const stub = makeManagerStub({ bots: new Map(), appended: [], seen });

    await handleCronInstruction.call(stub as never, 321, 'text of the job', 'bot1');

    const msg = seen[0].msg;
    expect(msg.text).toBe('text of the job');
    expect(msg.chatId).toBe('321');
    expect(msg.chatType).toBe('private');
    expect(msg.sender).toMatchObject({ id: '321', firstName: 'Cron' });
    expect(String(msg.messageId)).toStartWith('cron-');
  });
});
