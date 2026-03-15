/**
 * Discord channel adapter.
 *
 * Converts Discord messages to InboundMessage format and provides
 * a Channel interface for sending replies.
 *
 * Uses Discord REST API directly (no discord.js dependency) for lightweight integration.
 */
import type { Channel, ChannelKind, InboundMessage } from './types';

export interface DiscordConfig {
  token: string;
  applicationId?: string;
  guildIds?: string[];
  /** Channel IDs to listen on (empty = all channels the bot can see) */
  channelIds?: string[];
}

export interface DiscordMessagePayload {
  id: string;
  channel_id: string;
  guild_id?: string;
  author: {
    id: string;
    username: string;
    discriminator?: string;
    global_name?: string;
    bot?: boolean;
  };
  content: string;
  timestamp: string;
  attachments?: Array<{
    id: string;
    filename: string;
    url: string;
    content_type?: string;
    size: number;
  }>;
  referenced_message?: DiscordMessagePayload;
}

const DISCORD_API = 'https://discord.com/api/v10';

/**
 * Convert a Discord message payload to InboundMessage.
 */
export function discordToInbound(msg: DiscordMessagePayload): InboundMessage {
  const images = (msg.attachments ?? [])
    .filter((a) => a.content_type?.startsWith('image/'))
    .map((a) => a.url);

  return {
    channelKind: 'discord' as ChannelKind,
    text: msg.content,
    sender: {
      id: msg.author.id,
      username: msg.author.username,
      firstName: msg.author.global_name ?? msg.author.username,
    },
    chatId: msg.channel_id,
    chatType: msg.guild_id ? 'group' : 'private',
    messageId: msg.id,
    images: images.length > 0 ? images : undefined,
    timestamp: new Date(msg.timestamp).getTime(),
  };
}

/**
 * Create a Channel interface for Discord.
 */
export function discordChannel(channelId: string, config: DiscordConfig): Channel {
  return {
    kind: 'discord' as ChannelKind,
    async sendText(text: string) {
      // Discord has a 2000 char limit per message
      const chunks = splitDiscordMessage(text, 2000);
      for (const chunk of chunks) {
        await discordApiPost(`/channels/${channelId}/messages`, config.token, {
          content: chunk,
        });
      }
    },
    async showTyping() {
      await discordApiPost(`/channels/${channelId}/typing`, config.token, {});
    },
  };
}

/**
 * Send a POST request to the Discord API.
 */
async function discordApiPost(path: string, token: string, body: unknown): Promise<unknown> {
  const resp = await fetch(`${DISCORD_API}${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bot ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Discord API error ${resp.status}: ${text}`);
  }
  // typing endpoint returns 204 No Content
  if (resp.status === 204) return undefined;
  return resp.json();
}

/**
 * Split a long message into chunks for Discord's 2000 char limit.
 * Exported for testing.
 */
export function splitDiscordMessage(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }
    // Try to split at a newline within the limit
    let splitIdx = remaining.lastIndexOf('\n', maxLen);
    if (splitIdx <= 0) splitIdx = maxLen;
    chunks.push(remaining.slice(0, splitIdx));
    remaining = remaining.slice(splitIdx).replace(/^\n/, '');
  }
  return chunks;
}
