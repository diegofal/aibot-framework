import { describe, expect, it, mock } from 'bun:test';
import {
  type DiscordMessagePayload,
  discordChannel,
  discordToInbound,
  splitDiscordMessage,
} from '../src/channel/discord';
import { DiscordGateway, type DiscordGatewayDeps } from '../src/channel/discord-gateway';

// ─── discordToInbound ────────────────────────────────────────────────────────

describe('discordToInbound', () => {
  const baseMsg: DiscordMessagePayload = {
    id: '1234567890',
    channel_id: '9876543210',
    guild_id: '5555555555',
    author: {
      id: '111222333',
      username: 'testuser',
      global_name: 'Test User',
      bot: false,
    },
    content: 'Hello from Discord!',
    timestamp: '2026-03-15T12:00:00.000Z',
    attachments: [],
  };

  it('converts a basic guild message', () => {
    const inbound = discordToInbound(baseMsg);
    expect(inbound.channelKind).toBe('discord');
    expect(inbound.text).toBe('Hello from Discord!');
    expect(inbound.sender.id).toBe('111222333');
    expect(inbound.sender.username).toBe('testuser');
    expect(inbound.sender.firstName).toBe('Test User');
    expect(inbound.chatId).toBe('9876543210');
    expect(inbound.chatType).toBe('group');
    expect(inbound.messageId).toBe('1234567890');
    expect(inbound.images).toBeUndefined();
    expect(inbound.timestamp).toBe(new Date('2026-03-15T12:00:00.000Z').getTime());
  });

  it('sets chatType to private when no guild_id', () => {
    const dm = { ...baseMsg, guild_id: undefined };
    const inbound = discordToInbound(dm);
    expect(inbound.chatType).toBe('private');
  });

  it('falls back to username when global_name is absent', () => {
    const msg = {
      ...baseMsg,
      author: { ...baseMsg.author, global_name: undefined },
    };
    const inbound = discordToInbound(msg);
    expect(inbound.sender.firstName).toBe('testuser');
  });

  it('extracts image URLs from attachments', () => {
    const msg: DiscordMessagePayload = {
      ...baseMsg,
      attachments: [
        {
          id: '1',
          filename: 'photo.png',
          url: 'https://cdn.discord.com/photo.png',
          content_type: 'image/png',
          size: 1024,
        },
        {
          id: '2',
          filename: 'doc.pdf',
          url: 'https://cdn.discord.com/doc.pdf',
          content_type: 'application/pdf',
          size: 2048,
        },
        {
          id: '3',
          filename: 'pic.jpg',
          url: 'https://cdn.discord.com/pic.jpg',
          content_type: 'image/jpeg',
          size: 512,
        },
      ],
    };
    const inbound = discordToInbound(msg);
    expect(inbound.images).toEqual([
      'https://cdn.discord.com/photo.png',
      'https://cdn.discord.com/pic.jpg',
    ]);
  });

  it('handles missing attachments array', () => {
    const msg = { ...baseMsg, attachments: undefined };
    const inbound = discordToInbound(msg);
    expect(inbound.images).toBeUndefined();
  });
});

// ─── splitDiscordMessage ─────────────────────────────────────────────────────

describe('splitDiscordMessage', () => {
  it('returns single chunk for short messages', () => {
    expect(splitDiscordMessage('hello', 2000)).toEqual(['hello']);
  });

  it('returns single chunk for empty string', () => {
    expect(splitDiscordMessage('', 2000)).toEqual(['']);
  });

  it('returns single chunk when exactly at limit', () => {
    const text = 'a'.repeat(2000);
    expect(splitDiscordMessage(text, 2000)).toEqual([text]);
  });

  it('splits at newline boundary', () => {
    const line1 = 'a'.repeat(1500);
    const line2 = 'b'.repeat(600);
    const text = `${line1}\n${line2}`;
    const chunks = splitDiscordMessage(text, 2000);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toBe(line1);
    expect(chunks[1]).toBe(line2);
  });

  it('hard-splits when no newline found within limit', () => {
    const text = 'a'.repeat(5000);
    const chunks = splitDiscordMessage(text, 2000);
    expect(chunks).toHaveLength(3);
    expect(chunks[0]).toBe('a'.repeat(2000));
    expect(chunks[1]).toBe('a'.repeat(2000));
    expect(chunks[2]).toBe('a'.repeat(1000));
  });

  it('handles multiple newline splits', () => {
    const lines = Array.from({ length: 5 }, (_, i) => `Line ${i}: ${'x'.repeat(500)}`);
    const text = lines.join('\n');
    const chunks = splitDiscordMessage(text, 1100);
    // Each line is ~508 chars, so two per chunk
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(1100);
    }
  });
});

// ─── discordChannel ──────────────────────────────────────────────────────────

describe('discordChannel', () => {
  it('creates a channel with discord kind', () => {
    const ch = discordChannel('123456', { token: 'test-token' });
    expect(ch.kind).toBe('discord');
    expect(typeof ch.sendText).toBe('function');
    expect(typeof ch.showTyping).toBe('function');
  });
});

// ─── DiscordGateway ──────────────────────────────────────────────────────────

describe('DiscordGateway', () => {
  function makeDeps(overrides?: Partial<DiscordGatewayDeps>): DiscordGatewayDeps {
    return {
      handleMessage: overrides?.handleMessage ?? mock(() => Promise.resolve()),
      logger: overrides?.logger ?? {
        info: mock(() => {}),
        warn: mock(() => {}),
        error: mock(() => {}),
      },
    };
  }

  it('handles Hello (op 10) — starts heartbeat and identify', () => {
    const deps = makeDeps();
    const gw = new DiscordGateway('bot1', { token: 'tok' }, deps);

    // Simulate Hello
    gw.handleGatewayEvent({ op: 10, d: { heartbeat_interval: 45000 } });

    // Gateway processes hello without error
    expect(gw.connected).toBe(false); // not yet READY
  });

  it('handles READY (op 0, t=READY) — sets connected and session', () => {
    const deps = makeDeps();
    const gw = new DiscordGateway('bot1', { token: 'tok' }, deps);

    gw.handleGatewayEvent({
      op: 0,
      d: {
        session_id: 'sess123',
        resume_gateway_url: 'wss://resume.discord.gg',
        user: { username: 'TestBot' },
      },
      s: 1,
      t: 'READY',
    });

    expect(gw.connected).toBe(true);
    expect(deps.logger.info).toHaveBeenCalled();
  });

  it('handles MESSAGE_CREATE — calls handleMessage for non-bot user', () => {
    const deps = makeDeps();
    const gw = new DiscordGateway('bot1', { token: 'tok' }, deps);

    const msgPayload: DiscordMessagePayload = {
      id: 'msg1',
      channel_id: 'ch1',
      guild_id: 'guild1',
      author: { id: 'u1', username: 'alice', bot: false },
      content: 'hi there',
      timestamp: '2026-03-15T12:00:00.000Z',
    };

    gw.handleGatewayEvent({ op: 0, d: msgPayload, s: 2, t: 'MESSAGE_CREATE' });

    expect(deps.handleMessage).toHaveBeenCalledTimes(1);
    const [botId, inbound] = (deps.handleMessage as any).mock.calls[0];
    expect(botId).toBe('bot1');
    expect(inbound.text).toBe('hi there');
    expect(inbound.channelKind).toBe('discord');
  });

  it('skips bot messages in MESSAGE_CREATE', () => {
    const deps = makeDeps();
    const gw = new DiscordGateway('bot1', { token: 'tok' }, deps);

    gw.handleGatewayEvent({
      op: 0,
      d: {
        id: 'msg2',
        channel_id: 'ch1',
        author: { id: 'bot99', username: 'OtherBot', bot: true },
        content: 'automated',
        timestamp: '2026-03-15T12:00:00.000Z',
      },
      s: 3,
      t: 'MESSAGE_CREATE',
    });

    expect(deps.handleMessage).not.toHaveBeenCalled();
  });

  it('filters by channelIds when configured', () => {
    const deps = makeDeps();
    const gw = new DiscordGateway('bot1', { token: 'tok', channelIds: ['allowed-ch'] }, deps);

    // Message in a non-allowed channel
    gw.handleGatewayEvent({
      op: 0,
      d: {
        id: 'msg3',
        channel_id: 'blocked-ch',
        author: { id: 'u2', username: 'bob', bot: false },
        content: 'should be filtered',
        timestamp: '2026-03-15T12:00:00.000Z',
      },
      s: 4,
      t: 'MESSAGE_CREATE',
    });

    expect(deps.handleMessage).not.toHaveBeenCalled();

    // Message in allowed channel
    gw.handleGatewayEvent({
      op: 0,
      d: {
        id: 'msg4',
        channel_id: 'allowed-ch',
        author: { id: 'u2', username: 'bob', bot: false },
        content: 'should pass',
        timestamp: '2026-03-15T12:00:00.000Z',
      },
      s: 5,
      t: 'MESSAGE_CREATE',
    });

    expect(deps.handleMessage).toHaveBeenCalledTimes(1);
  });

  it('handles Heartbeat ACK (op 11) without error', () => {
    const deps = makeDeps();
    const gw = new DiscordGateway('bot1', { token: 'tok' }, deps);
    // Should not throw
    gw.handleGatewayEvent({ op: 11, d: null });
  });

  it('disconnect sets connected to false', () => {
    const deps = makeDeps();
    const gw = new DiscordGateway('bot1', { token: 'tok' }, deps);

    // Simulate READY
    gw.handleGatewayEvent({
      op: 0,
      d: { session_id: 's', resume_gateway_url: 'wss://x', user: { username: 'B' } },
      s: 1,
      t: 'READY',
    });
    expect(gw.connected).toBe(true);

    gw.disconnect();
    expect(gw.connected).toBe(false);
  });
});
