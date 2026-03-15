/**
 * Channel abstraction layer — decouples the conversation pipeline from
 * Telegram's grammy framework so multiple channels (Telegram, REST API,
 * web widget, etc.) can share the same pipeline.
 */

/**
 * A channel-agnostic inbound message.
 * Telegram handlers, REST API, web widget, etc. all map their native
 * message format into this structure before entering the pipeline.
 */
export interface InboundMessage {
  /** Unique message id within the channel (used for dedup) */
  messageId: string;
  /** Channel origin identifier (e.g. "telegram", "rest", "web") */
  channelKind: ChannelKind;
  /** Plain text content of the message */
  text: string;
  /** Chat / conversation identifier (channel-specific) */
  chatId: string;
  /** Chat type for session key derivation */
  chatType: 'private' | 'group' | 'supergroup' | 'channel';
  /** Sender information */
  sender: {
    id: string;
    username?: string;
    firstName?: string;
  };
  /** Base64-encoded images for vision models */
  images?: string[];
  /** Whether the original message was a voice note (triggers TTS reply) */
  isVoice?: boolean;
  /** Thread/topic id for forum-style chats */
  threadId?: string;
  /** Optional raw text for session persistence (differs from `text` when media has a caption) */
  sessionText?: string;
  /** Timestamp of the inbound message */
  timestamp: number;
}

export type ChannelKind = 'telegram' | 'rest' | 'web' | 'mcp' | 'whatsapp' | 'discord';

/**
 * A channel's reply interface — the pipeline calls these methods to send
 * responses back through whatever channel originated the message.
 */
export interface Channel {
  readonly kind: ChannelKind;

  /** Send a text reply. Long messages are automatically chunked by the pipeline. */
  sendText(text: string): Promise<void>;

  /** Show a "typing" or "thinking" indicator (no-op for channels that don't support it) */
  showTyping(): Promise<void>;

  /** Send a voice reply (optional — channels that don't support voice can throw/no-op) */
  sendVoice?(audioBuffer: Buffer, filename?: string): Promise<void>;
}
