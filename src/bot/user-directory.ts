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
  /** Other names this contact answers to in `find` (exact, case-insensitive). */
  aliases?: string[];
  /**
   * Free-form metadata. Reserved keys: `role: 'operator'` marks the bot's
   * operator; `mergedInto: <contactId>` marks an entry folded into another one
   * (excluded from `find`/`list`/`findByChannel`, `getById` follows it).
   */
  metadata?: Record<string, string>;
}

/** The operator as configured (`config.operator`). */
export interface OperatorSeed {
  name: string;
  telegramChatId?: number;
  email?: string;
}

/** Names the operator answers to besides its display name and aliases. */
export const OPERATOR_KEYWORDS = ['operator', 'operador'] as const;

/** A lastSeen-only change is persisted at most this often. */
export const LAST_SEEN_PERSIST_MS = 60 * 60 * 1000;

const isMerged = (e: ContactEntry): boolean => !!e.metadata?.mergedInto;
const isOperator = (e: ContactEntry): boolean => e.metadata?.role === 'operator';

export interface RegisterInput {
  displayName: string;
  channel: ContactChannel;
  metadata?: Record<string, string>;
}

export class UserDirectory {
  /** botId → (contactId → ContactEntry), merged entries included */
  private cache = new Map<string, Map<string, ContactEntry>>();
  /** botId → (channelKind:address → contactId) — live (non-merged) entries only */
  private senderIndex = new Map<string, Map<string, string>>();
  /** botId → (contactId → last persisted { json, lastSeen }) — drives the write throttle */
  private persisted = new Map<string, Map<string, { json: string; lastSeen: number }>>();
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
   * The operator keeps its configured name. A change that only moves lastSeen
   * is written at most once per `LAST_SEEN_PERSIST_MS`.
   */
  track(botId: string, inbound: InboundMessage): ContactEntry {
    this.ensureLoaded(botId);
    const senderKey = `${inbound.channelKind}:${inbound.sender.id}`;
    const index = this.senderIndex.get(botId)!;
    const contacts = this.cache.get(botId)!;

    const existingId = index.get(senderKey);
    const existing = existingId ? contacts.get(existingId) : undefined;
    if (existing) {
      existing.lastSeen = inbound.timestamp || Date.now();
      if (
        inbound.sender.firstName &&
        inbound.sender.firstName !== existing.displayName &&
        !isOperator(existing)
      ) {
        existing.displayName = inbound.sender.firstName;
      }
      const ch = existing.channels.find(
        (c) => c.kind === inbound.channelKind && c.address === inbound.sender.id
      );
      if (ch) {
        if (inbound.sender.username && ch.username !== inbound.sender.username) {
          ch.username = inbound.sender.username;
        }
        // Writing through the channel proves the address belongs to them.
        if (!ch.verified) ch.verified = true;
      }
      this.persistIfChanged(botId, existing);
      return existing;
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
    const existing = existingId ? contacts.get(existingId) : undefined;
    if (existing) {
      existing.displayName = input.displayName;
      if (input.metadata) existing.metadata = { ...existing.metadata, ...input.metadata };
      this.persistIfChanged(botId, existing);
      return existing;
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
    const entry = this.getById(botId, contactId);
    if (!entry) return null;

    // Avoid duplicates
    const exists = entry.channels.some(
      (c) => c.kind === channel.kind && c.address === channel.address
    );
    if (!exists) {
      entry.channels.push(channel);
      const index = this.senderIndex.get(botId)!;
      index.set(`${channel.kind}:${channel.address}`, entry.id);
    }
    this.persistIfChanged(botId, entry);
    return entry;
  }

  /**
   * Seed the operator from config and fold every entry that owns one of the
   * operator's addresses into a single contact with `metadata.role = 'operator'`.
   *
   * - The kept entry is the existing operator, else the earliest owner, else a new one.
   * - Folded entries contribute channels (verified wins), earliest firstSeen,
   *   latest lastSeen, aliases and their old display name as an alias; they are
   *   marked `metadata.mergedInto` and disappear from `find`/`list`.
   * - Configured addresses missing from the contact are added unverified.
   * - Idempotent: nothing is written when nothing changed.
   */
  ensureOperator(botId: string, op: OperatorSeed): ContactEntry {
    this.ensureLoaded(botId);
    const contacts = this.cache.get(botId)!;
    const index = this.senderIndex.get(botId)!;

    const seeds: ContactChannel[] = [];
    if (op.telegramChatId !== undefined && op.telegramChatId !== null) {
      seeds.push({ kind: 'telegram', address: String(op.telegramChatId), verified: false });
    }
    if (op.email) seeds.push({ kind: 'web', address: op.email, verified: false });

    const group: ContactEntry[] = [];
    for (const e of contacts.values()) {
      if (!isMerged(e) && isOperator(e)) group.push(e);
    }
    for (const seed of seeds) {
      const id = index.get(`${seed.kind}:${seed.address}`);
      const e = id ? contacts.get(id) : undefined;
      if (e && !isMerged(e) && !group.includes(e)) group.push(e);
    }

    let primary = group.find(isOperator) ?? [...group].sort((a, b) => a.firstSeen - b.firstSeen)[0];
    if (!primary) {
      const now = Date.now();
      primary = {
        id: randomUUID().slice(0, 8),
        displayName: op.name,
        channels: [],
        firstSeen: now,
        lastSeen: now,
        metadata: { role: 'operator' },
      };
      contacts.set(primary.id, primary);
    }

    if (primary.displayName !== op.name) {
      const previousName = primary.displayName;
      primary.displayName = op.name;
      addAliasTo(primary, previousName);
    }
    if (!isOperator(primary)) primary.metadata = { ...primary.metadata, role: 'operator' };

    const merged: ContactEntry[] = [];
    for (const other of group) {
      if (other === primary) continue;
      foldInto(primary, other);
      merged.push(other);
    }
    for (const seed of seeds) {
      if (!primary.channels.some((c) => c.kind === seed.kind && c.address === seed.address)) {
        primary.channels.push({ ...seed });
      }
    }
    for (const ch of primary.channels) index.set(`${ch.kind}:${ch.address}`, primary.id);

    this.persistIfChanged(botId, primary);
    for (const m of merged) {
      this.appendLine(botId, m);
      this.logger.info(
        { botId, contactId: m.id, operatorId: primary.id },
        'contact merged into operator'
      );
    }
    return primary;
  }

  /** The bot's operator contact, if one was seeded. */
  getOperator(botId: string): ContactEntry | undefined {
    return this.list(botId).find(isOperator);
  }

  /** Add a name the contact answers to. Case-insensitive dedupe; null for unknown ids. */
  addAlias(botId: string, contactId: string, alias: string): ContactEntry | null {
    const entry = this.getById(botId, contactId);
    if (!entry) return null;
    addAliasTo(entry, alias);
    this.persistIfChanged(botId, entry);
    return entry;
  }

  /**
   * Search contacts by displayName, alias, username, address, or contact ID.
   * If exactly one contact matches exactly (id, name, alias, username, address,
   * or — for the operator — "operator"/"operador"), only that one is returned;
   * otherwise displayName/alias match partially. Merged entries never match.
   */
  find(botId: string, query: string): ContactEntry[] {
    const live = this.list(botId);
    const q = query.trim().toLowerCase().replace(/^@/, '');

    const exact = live.filter(
      (e) =>
        e.id === query ||
        e.displayName.toLowerCase() === q ||
        (e.aliases ?? []).some((a) => a.toLowerCase() === q) ||
        (isOperator(e) && (OPERATOR_KEYWORDS as readonly string[]).includes(q)) ||
        e.channels.some((ch) => ch.username?.toLowerCase() === q || ch.address === query)
    );
    if (exact.length === 1) return exact;

    return live.filter(
      (e) =>
        exact.includes(e) ||
        e.displayName.toLowerCase().includes(q) ||
        (e.aliases ?? []).some((a) => a.toLowerCase().includes(q))
    );
  }

  /** Exact lookup by channel kind + address. Never returns a merged entry. */
  findByChannel(botId: string, kind: ChannelKind, address: string): ContactEntry | undefined {
    this.ensureLoaded(botId);
    const id = this.senderIndex.get(botId)!.get(`${kind}:${address}`);
    const entry = id ? this.cache.get(botId)!.get(id) : undefined;
    return entry && !isMerged(entry) ? entry : undefined;
  }

  /**
   * Get a contact by exact ID. A merged entry resolves to the contact it was
   * folded into, so ids stored elsewhere (relay records) keep working.
   */
  getById(botId: string, contactId: string): ContactEntry | undefined {
    this.ensureLoaded(botId);
    const contacts = this.cache.get(botId)!;
    let entry = contacts.get(contactId);
    for (let hops = 0; entry?.metadata?.mergedInto && hops < 5; hops++) {
      const next = contacts.get(entry.metadata.mergedInto);
      if (!next) break;
      entry = next;
    }
    return entry;
  }

  /**
   * List all live contacts for a bot (merged entries excluded).
   */
  list(botId: string): ContactEntry[] {
    this.ensureLoaded(botId);
    return [...(this.cache.get(botId)?.values() ?? [])].filter((e) => !isMerged(e));
  }

  // --- Internal ---

  private filePath(botId: string): string {
    return join(this.dir, `${botId}.jsonl`);
  }

  private ensureLoaded(botId: string): void {
    if (this.cache.has(botId)) return;

    const contacts = new Map<string, ContactEntry>();
    const index = new Map<string, string>();
    const persisted = new Map<string, { json: string; lastSeen: number }>();
    const fp = this.filePath(botId);

    if (existsSync(fp)) {
      const lines = readFileSync(fp, 'utf-8').split('\n').filter(Boolean);
      // JSONL: last line for each ID wins (append-only with overwrites)
      for (const line of lines) {
        try {
          const entry = JSON.parse(line) as ContactEntry;
          if (!entry?.id || !Array.isArray(entry.channels)) continue;
          contacts.set(entry.id, entry);
          persisted.set(entry.id, { json: line.trim(), lastSeen: entry.lastSeen });
        } catch {
          // skip malformed lines
        }
      }
    }
    // Index only live entries: a merged entry's addresses belong to its target.
    for (const entry of contacts.values()) {
      if (isMerged(entry)) continue;
      for (const ch of entry.channels) index.set(`${ch.kind}:${ch.address}`, entry.id);
    }

    this.cache.set(botId, contacts);
    this.senderIndex.set(botId, index);
    this.persisted.set(botId, persisted);
  }

  /**
   * Append the entry unless it equals what was last written, ignoring a
   * lastSeen that moved by no more than `LAST_SEEN_PERSIST_MS`.
   */
  private persistIfChanged(botId: string, entry: ContactEntry): void {
    const prev = this.persisted.get(botId)?.get(entry.id);
    if (
      prev &&
      JSON.stringify({ ...entry, lastSeen: prev.lastSeen }) === prev.json &&
      Math.abs(entry.lastSeen - prev.lastSeen) <= LAST_SEEN_PERSIST_MS
    ) {
      return;
    }
    this.appendLine(botId, entry);
  }

  private appendLine(botId: string, entry: ContactEntry): void {
    const json = JSON.stringify(entry);
    appendFileSync(this.filePath(botId), `${json}\n`);
    let persisted = this.persisted.get(botId);
    if (!persisted) {
      persisted = new Map();
      this.persisted.set(botId, persisted);
    }
    persisted.set(entry.id, { json, lastSeen: entry.lastSeen });
  }
}

/** Add an alias unless it equals the display name or an existing alias (case-insensitive). */
function addAliasTo(entry: ContactEntry, alias: string): void {
  const a = alias.trim();
  if (!a) return;
  const lower = a.toLowerCase();
  if (entry.displayName.toLowerCase() === lower) return;
  if ((entry.aliases ?? []).some((x) => x.toLowerCase() === lower)) return;
  entry.aliases = [...(entry.aliases ?? []), a];
}

/** Fold `other` into `primary` and mark it merged. */
function foldInto(primary: ContactEntry, other: ContactEntry): void {
  for (const ch of other.channels) {
    const mine = primary.channels.find((c) => c.kind === ch.kind && c.address === ch.address);
    if (mine) {
      if (ch.verified && !mine.verified) mine.verified = true;
      if (!mine.username && ch.username) mine.username = ch.username;
    } else {
      primary.channels.push({ ...ch });
    }
  }
  primary.firstSeen = Math.min(primary.firstSeen, other.firstSeen);
  primary.lastSeen = Math.max(primary.lastSeen, other.lastSeen);
  addAliasTo(primary, other.displayName);
  for (const a of other.aliases ?? []) addAliasTo(primary, a);
  other.metadata = { ...other.metadata, mergedInto: primary.id };
}
