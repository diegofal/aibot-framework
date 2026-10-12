/**
 * Durable relay records: `<dataDir>/relays/<botId>.jsonl`, append-only, the
 * last line per id wins. Loaded lazily per bot; malformed lines are skipped.
 */
import { randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { ChannelKind } from '../channel/types';
import type { Logger } from '../logger';
import type { NewRelayRecord, RelayRecord } from './types';

/** `r-` + 8 hex. */
export function newRelayId(): string {
  return `r-${randomBytes(4).toString('hex')}`;
}

/** Waiting for an answer: expects one, reached someone, not answered yet. */
export const isRelayOpen = (r: RelayRecord): boolean =>
  r.expectsReply && (r.status === 'delivered' || r.status === 'queued') && !r.answeredAt;

export class RelayStore {
  private readonly dir: string;
  /** botId → (relayId → record) */
  private cache = new Map<string, Map<string, RelayRecord>>();

  constructor(
    dataDir: string,
    private logger: Logger
  ) {
    this.dir = join(dataDir, 'relays');
  }

  /** Store a new relay; assigns id, createdAt and updatedAt. */
  create(input: NewRelayRecord): RelayRecord {
    const now = Date.now();
    const record: RelayRecord = { ...input, id: newRelayId(), createdAt: now, updatedAt: now };
    this.load(record.botId).set(record.id, record);
    this.append(record);
    return record;
  }

  /** Patch a relay (id, botId and createdAt are kept); null when unknown. */
  update(
    botId: string,
    id: string,
    patch: Partial<Omit<RelayRecord, 'id' | 'botId' | 'createdAt'>>
  ): RelayRecord | null {
    const records = this.load(botId);
    const current = records.get(id);
    if (!current) return null;
    const next: RelayRecord = {
      ...current,
      ...patch,
      id: current.id,
      botId: current.botId,
      createdAt: current.createdAt,
      updatedAt: Math.max(Date.now(), current.updatedAt + 1),
    };
    records.set(id, next);
    this.append(next);
    return next;
  }

  get(botId: string, id: string): RelayRecord | undefined {
    return this.load(botId).get(id);
  }

  /**
   * The relay delivered as Telegram message `messageId` in chat `chatAddress`
   * (`to.address` is the chat the message went to). Telegram message ids are
   * per chat *and* per bot, so pass `viaBotId` when the replying instance is known.
   */
  findByTelegramMessage(
    botId: string,
    chatAddress: string,
    messageId: number,
    viaBotId?: string
  ): RelayRecord | undefined {
    for (const r of this.load(botId).values()) {
      if (
        r.delivery.channel === 'telegram' &&
        r.delivery.telegramMessageId === messageId &&
        r.to.address === chatAddress &&
        (viaBotId === undefined || r.delivery.viaBotId === viaBotId)
      ) {
        return r;
      }
    }
    return undefined;
  }

  /**
   * Same lookup across every bot's relays: a headless bot's relay is carried
   * by another bot's Telegram instance, so the reply reaches that instance.
   */
  findByTelegramDelivery(
    viaBotId: string,
    chatAddress: string,
    messageId: number
  ): RelayRecord | undefined {
    for (const botId of this.knownBots()) {
      const hit = this.findByTelegramMessage(botId, chatAddress, messageId, viaBotId);
      if (hit) return hit;
    }
    return undefined;
  }

  /** Relays waiting on this party's answer: expectsReply, delivered/queued, not answered. */
  openFor(botId: string, channelKind: ChannelKind, address: string): RelayRecord[] {
    return [...this.load(botId).values()]
      .filter((r) => r.to.channelKind === channelKind && r.to.address === address && isRelayOpen(r))
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  /** Relays this party asked for, newest first, optionally created at/after `sinceMs`. */
  sentBy(
    botId: string,
    channelKind: ChannelKind,
    address: string,
    sinceMs?: number
  ): RelayRecord[] {
    return [...this.load(botId).values()]
      .filter(
        (r) =>
          r.from?.channelKind === channelKind &&
          r.from.address === address &&
          (sinceMs === undefined || r.createdAt >= sinceMs)
      )
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  /**
   * A non-failed relay with the same dedupe key created within `withinMs`.
   * A failed one does not count: retrying it is legitimate.
   */
  findDuplicate(botId: string, dedupeKey: string, withinMs: number): RelayRecord | undefined {
    const since = Date.now() - withinMs;
    let best: RelayRecord | undefined;
    for (const r of this.load(botId).values()) {
      if (r.dedupeKey !== dedupeKey || r.status === 'failed' || r.createdAt < since) continue;
      if (!best || r.createdAt > best.createdAt) best = r;
    }
    return best;
  }

  // --- Internal ---

  private filePath(botId: string): string {
    return join(this.dir, `${botId}.jsonl`);
  }

  private knownBots(): string[] {
    const bots = new Set(this.cache.keys());
    try {
      if (existsSync(this.dir)) {
        for (const f of readdirSync(this.dir)) {
          if (f.endsWith('.jsonl')) bots.add(f.slice(0, -'.jsonl'.length));
        }
      }
    } catch (err) {
      this.logger.warn({ err }, 'relay store: cannot list relays dir');
    }
    return [...bots];
  }

  private load(botId: string): Map<string, RelayRecord> {
    const cached = this.cache.get(botId);
    if (cached) return cached;
    const records = new Map<string, RelayRecord>();
    const fp = this.filePath(botId);
    try {
      if (existsSync(fp)) {
        for (const line of readFileSync(fp, 'utf-8').split('\n')) {
          if (!line.trim()) continue;
          try {
            const r = JSON.parse(line) as RelayRecord;
            if (r && typeof r.id === 'string' && r.to && r.delivery) records.set(r.id, r);
          } catch {
            // skip malformed lines
          }
        }
      }
    } catch (err) {
      this.logger.warn({ err, botId }, 'relay store: cannot read relays file');
    }
    this.cache.set(botId, records);
    return records;
  }

  private append(record: RelayRecord): void {
    try {
      mkdirSync(this.dir, { recursive: true });
      appendFileSync(this.filePath(record.botId), `${JSON.stringify(record)}\n`);
    } catch (err) {
      this.logger.error(
        { err, botId: record.botId, relayId: record.id },
        'relay store: write failed'
      );
    }
  }
}
