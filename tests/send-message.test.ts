import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UserDirectory } from '../src/bot/user-directory';
import type { Channel } from '../src/channel/types';
import { createSendMessageTool } from '../src/tools/send-message';

const silentLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  child: () => silentLogger,
} as any;

let tmpDir: string;
let ud: UserDirectory;
let sentMessages: Array<{ channel: string; text: string }>;

function makeChannel(kind: string): Channel {
  return {
    kind: kind as any,
    async sendText(text: string) {
      sentMessages.push({ channel: kind, text });
    },
    async showTyping() {},
  };
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'sm-test-'));
  ud = new UserDirectory(tmpDir, silentLogger);
  sentMessages = [];
});

afterAll(() => {
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {}
});

function createTool(channelFactory?: (botId: string, contact: any) => Channel | null) {
  return createSendMessageTool({
    userDirectory: ud,
    createOutboundChannel: channelFactory ?? ((_botId, contact) => makeChannel(contact.kind)),
  });
}

describe('send_message tool', () => {
  test('single match — sends message successfully', async () => {
    ud.register('bot1', {
      displayName: 'Diego',
      channel: { kind: 'telegram', address: '12345', verified: true },
    });

    const tool = createTool();
    const result = await tool.execute(
      { recipient: 'Diego', message: 'Hola!', _botId: 'bot1' },
      silentLogger
    );

    expect(result.success).toBe(true);
    expect(result.content).toContain('Diego');
    expect(result.content).toContain('telegram');
    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0].text).toBe('Hola!');
  });

  test('multiple matches — returns disambiguation list', async () => {
    ud.register('bot1', {
      displayName: 'Diego A',
      channel: { kind: 'telegram', address: '111', verified: true },
    });
    ud.register('bot1', {
      displayName: 'Diego B',
      channel: { kind: 'telegram', address: '222', verified: true },
    });

    const tool = createTool();
    const result = await tool.execute(
      { recipient: 'Diego', message: 'Hola!', _botId: 'bot1' },
      silentLogger
    );

    expect(result.success).toBe(false);
    expect(result.content).toContain('Multiple contacts');
    expect(result.content).toContain('Diego A');
    expect(result.content).toContain('Diego B');
    expect(sentMessages).toHaveLength(0);
  });

  test('no match without register — returns instructions to ask user', async () => {
    const tool = createTool();
    const result = await tool.execute(
      { recipient: 'Unknown', message: 'Hi', _botId: 'bot1' },
      silentLogger
    );

    expect(result.success).toBe(false);
    expect(result.content).toContain('not found');
    expect(result.content).toContain('Ask the user');
    expect(sentMessages).toHaveLength(0);
  });

  test('no match with register — registers and sends', async () => {
    const tool = createTool();
    const result = await tool.execute(
      {
        recipient: 'NewUser',
        message: 'Welcome!',
        _botId: 'bot1',
        register: {
          displayName: 'NewUser',
          channelKind: 'telegram',
          address: '99999',
        },
      },
      silentLogger
    );

    expect(result.success).toBe(true);
    expect(result.content).toContain('NewUser');
    expect(sentMessages).toHaveLength(1);

    // Verify contact was persisted
    expect(ud.find('bot1', 'NewUser')).toHaveLength(1);
  });

  test('channel preference — uses specified channel', async () => {
    ud.register('bot1', {
      displayName: 'Multi',
      channel: { kind: 'telegram', address: '111', verified: true },
    });
    const entry = ud.find('bot1', 'Multi')[0];
    ud.addChannel('bot1', entry.id, {
      kind: 'whatsapp',
      address: '+54911',
      verified: true,
    });

    const tool = createTool();
    const result = await tool.execute(
      { recipient: 'Multi', message: 'Hi', channel: 'whatsapp', _botId: 'bot1' },
      silentLogger
    );

    expect(result.success).toBe(true);
    expect(sentMessages[0].channel).toBe('whatsapp');
  });

  test('auto channel — picks telegram first', async () => {
    ud.register('bot1', {
      displayName: 'Multi',
      channel: { kind: 'web', address: 'sess-1', verified: true },
    });
    const entry = ud.find('bot1', 'Multi')[0];
    ud.addChannel('bot1', entry.id, {
      kind: 'telegram',
      address: '111',
      verified: true,
    });

    const tool = createTool();
    await tool.execute({ recipient: 'Multi', message: 'Hi', _botId: 'bot1' }, silentLogger);

    expect(sentMessages[0].channel).toBe('telegram');
  });

  test('outbound channel returns null — error message', async () => {
    ud.register('bot1', {
      displayName: 'RestUser',
      channel: { kind: 'rest', address: 'req-1', verified: true },
    });

    const tool = createTool((_botId, _contact) => null);
    const result = await tool.execute(
      { recipient: 'RestUser', message: 'Hi', _botId: 'bot1' },
      silentLogger
    );

    expect(result.success).toBe(false);
    expect(result.content).toContain('Cannot create outbound channel');
  });

  test('missing recipient — returns error', async () => {
    const tool = createTool();
    const result = await tool.execute(
      { recipient: '', message: 'Hi', _botId: 'bot1' },
      silentLogger
    );
    expect(result.success).toBe(false);
    expect(result.content).toContain('Missing recipient');
  });

  test('missing message — returns error', async () => {
    const tool = createTool();
    const result = await tool.execute(
      { recipient: 'Diego', message: '', _botId: 'bot1' },
      silentLogger
    );
    expect(result.success).toBe(false);
    expect(result.content).toContain('Missing message');
  });

  test('message too long — returns error', async () => {
    const tool = createTool();
    const result = await tool.execute(
      { recipient: 'Diego', message: 'x'.repeat(4001), _botId: 'bot1' },
      silentLogger
    );
    expect(result.success).toBe(false);
    expect(result.content).toContain('too long');
  });

  test('delivery failure — returns error message', async () => {
    ud.register('bot1', {
      displayName: 'Diego',
      channel: { kind: 'telegram', address: '12345', verified: true },
    });

    const failChannel: Channel = {
      kind: 'telegram',
      async sendText() {
        throw new Error('Telegram API error 403: bot was blocked');
      },
      async showTyping() {},
    };

    const tool = createTool((_botId, _contact) => failChannel);
    const result = await tool.execute(
      { recipient: 'Diego', message: 'Hi', _botId: 'bot1' },
      silentLogger
    );

    expect(result.success).toBe(false);
    expect(result.content).toContain('Delivery failed');
    expect(result.content).toContain('403');
  });
});
