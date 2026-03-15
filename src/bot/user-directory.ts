import { randomUUID } from 'node:crypto';
/**
 * Persistent user/contact directory — tracks known users across all channels.
 *
 * Auto-populates from inbound messages and supports manual registration.
 * Storage: one JSONL file per bot under {dataDir}/user-directory/{botId}.jsonl
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ChannelKind, InboundMessage } from '../channel/types';
import type { Logger } from '../logger';

export interface ContactChannel {
  kind: ChannelKind;
  /** Channel-specific address: chatId for telegram, phone for whatsapp, sessionId for web */
  address: string;
  username?: string;
  /** true when the user actually sent a message through this channel */
  verified: boolean;
}

export interface ContactEntry {
  id: string;
  displayName: string;
  channels: ContactChannel[];
  firstSeen: number;
  lastSeen: number;
  metadata?: Record<string, string>;
}

export interface RegisterInput {
  displayName: string;
  channel: ContactChannel;
  metadata?: Record<string, string>;
}

export class UserDirectory {
  /** botId → (contactId → ContactEntry) */
  private cache = new Map<string, Map<string, ContactEntry>>();
  /** botId → (channelKind:senderId → contactId) — fast lookup index */
  private senderIndex = new Map<string, Map<string, string>>();
  private readonly dir: string;

  constructor(
    dataDir: string,
    private logger: Logger
  ) {
    this.dir = join(dataDir, 'user-directory');
    mkdirSync(this.dir, { recursive: true });
  }

  /**
   * Auto-track a user from any inbound message.
   * Upserts: updates lastSeen + displayName if changed, creates if new.
   */
  track(botId: string, inbound: InboundMessage): ContactEntry {
    this.ensureLoaded(botId);
    const senderKey = `${inbound.channelKind}:${inbound.sender.id}`;
    const index = this.senderIndex.get(botId)!;
    const contacts = this.cache.get(botId)!;

    const existingId = index.get(senderKey);
    if (existingId) {
      const entry = contacts.get(existingId)!;
      entry.lastSeen = inbound.timestamp || Date.now();
      if (inbound.sender.firstName && inbound.sender.firstName !== entry.displayName) {
        entry.displayName = inbound.sender.firstName;
      }
      // Update username if provided
      const ch = entry.channels.find(
        (c) => c.kind === inbound.channelKind && c.address === inbound.sender.id
      );
      if (ch && inbound.sender.username && ch.username !== inbound.sender.username) {
        ch.username = inbound.sender.username;
      }
      this.appendLine(botId, entry);
      return entry;
    }

    // New contact
    const now = inbound.timestamp || Date.now();
    const entry: ContactEntry = {
      id: randomUUID().slice(0, 8),
      displayName: inbound.sender.firstName || inbound.sender.id,
      channels: [
        {
          kind: inbound.channelKind,
          address: inbound.sender.id,
          username: inbound.sender.username,
          verified: true,
        },
      ],
      firstSeen: now,
      lastSeen: now,
    };

    contacts.set(entry.id, entry);
    index.set(senderKey, entry.id);
    this.appendLine(botId, entry);
    this.logger.info({ botId, contactId: entry.id, name: entry.displayName }, 'contact tracked');
    return entry;
  }

  /**
   * Manually register a contact (e.g. when the bot asks the user for details).
   */
  register(botId: string, input: RegisterInput): ContactEntry {
    this.ensureLoaded(botId);
    const contacts = this.cache.get(botId)!;
    const index = this.senderIndex.get(botId)!;

    // Check if this channel address already exists
    const senderKey = `${input.channel.kind}:${input.channel.address}`;
    const existingId = index.get(senderKey);
    if (existingId) {
      const entry = contacts.get(existingId)!;
      entry.displayName = input.displayName;
      if (input.metadata) entry.metadata = { ...entry.metadata, ...input.metadata };
      this.appendLine(botId, entry);
      return entry;
    }

    const now = Date.now();
    const entry: ContactEntry = {
      id: randomUUID().slice(0, 8),
      displayName: input.displayName,
      channels: [input.channel],
      firstSeen: now,
      lastSeen: now,
      metadata: input.metadata,
    };

    contacts.set(entry.id, entry);
    index.set(senderKey, entry.id);
    this.appendLine(botId, entry);
    this.logger.info({ botId, contactId: entry.id, name: entry.displayName }, 'contact registered');
    return entry;
  }

  /**
   * Add a channel to an existing contact.
   */
  addChannel(botId: string, contactId: string, channel: ContactChannel): ContactEntry | null {
    this.ensureLoaded(botId);
    const contacts = this.cache.get(botId)!;
    const entry = contacts.get(contactId);
    if (!entry) return null;

    // Avoid duplicates
    const exists = entry.channels.some(
      (c) => c.kind === channel.kind && c.address === channel.address
    );
    if (!exists) {
      entry.channels.push(channel);
      const index = this.senderIndex.get(botId)!;
      index.set(`${channel.kind}:${channel.address}`, contactId);
    }
    this.appendLine(botId, entry);
    return entry;
  }

  /**
   * Search contacts by displayName (partial), username, address, or contact ID.
   */
  find(botId: string, query: string): ContactEntry[] {
    this.ensureLoaded(botId);
    const contacts = this.cache.get(botId)!;
    const q = query.toLowerCase().replace(/^@/, '');
    const results: ContactEntry[] = [];

    for (const entry of contacts.values()) {
      // Match by ID
      if (entry.id === query) {
        results.push(entry);
        continue;
      }
      // Match by displayName (partial, case-insensitive)
      if (entry.displayName.toLowerCase().includes(q)) {
        results.push(entry);
        continue;
      }
      // Match by channel username or address
      for (const ch of entry.channels) {
        if (ch.username?.toLowerCase() === q || ch.address === query) {
          results.push(entry);
          break;
        }
      }
    }
    return results;
  }

  /**
   * Get a contact by exact ID.
   */
  getById(botId: string, contactId: string): ContactEntry | undefined {
    this.ensureLoaded(botId);
    return this.cache.get(botId)?.get(contactId);
  }

  /**
   * List all contacts for a bot.
   */
  list(botId: string): ContactEntry[] {
    this.ensureLoaded(botId);
    return [...(this.cache.get(botId)?.values() ?? [])];
  }

  // --- Internal ---

  private filePath(botId: string): string {
    return join(this.dir, `${botId}.jsonl`);
  }

  private ensureLoaded(botId: string): void {
    if (this.cache.has(botId)) return;

    const contacts = new Map<string, ContactEntry>();
    const index = new Map<string, string>();
    const fp = this.filePath(botId);

    if (existsSync(fp)) {
      const lines = readFileSync(fp, 'utf-8').split('\n').filter(Boolean);
      // JSONL: last line for each ID wins (append-only with overwrites)
      for (const line of lines) {
        try {
          const entry = JSON.parse(line) as ContactEntry;
          contacts.set(entry.id, entry);
          for (const ch of entry.channels) {
            index.set(`${ch.kind}:${ch.address}`, entry.id);
          }
        } catch {
          // skip malformed lines
        }
      }
    }

    this.cache.set(botId, contacts);
    this.senderIndex.set(botId, index);
  }

  private appendLine(botId: string, entry: ContactEntry): void {
    const fp = this.filePath(botId);
    appendFileSync(fp, `${JSON.stringify(entry)}\n`);
  }
}
