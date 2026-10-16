/**
 * Per-bot, per-group record of WhatsApp exports the operator sent:
 * `<dir>/<botId>/<group-slug>.json`.
 *
 * These are other parents' and children's messages. Only a bounded window is
 * kept (`RETENTION_DAYS`, `MAX_STORED_MESSAGES`, `MAX_MESSAGE_CHARS`), pruned
 * on every ingest (all groups of the bot) and every read. The cursor
 * (`lastMessageAt`) outlives the messages so the next export still starts
 * after it. Nothing here is written to the bot's memory.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { type WaMessage, groupSlug } from './parser';

export const RETENTION_DAYS = 30;
export const MAX_STORED_MESSAGES = 3000;
export const MAX_MESSAGE_CHARS = 2000;
const DAY_MS = 24 * 3600_000;

export interface StoredMessage extends WaMessage {
  /** ISO time of the export that first brought this message. */
  seenAt: string;
}

export interface GroupRecord {
  version: 1;
  group: string;
  slug: string;
  /** Newest message timestamp ever ingested (local, zone-less). */
  lastMessageAt?: string;
  lastExport?: {
    at: string;
    fileName: string;
    previousLastMessageAt?: string;
    newCount: number;
  };
  messages: StoredMessage[];
}

export interface IngestResult {
  group: string;
  slug: string;
  firstExport: boolean;
  newCount: number;
  /** Messages in the file older than the retention window (never stored). */
  droppedOld: number;
  previousLastMessageAt?: string;
  /** First and last new message timestamps. */
  from?: string;
  to?: string;
}

/** A zone-less local timestamp → epoch ms in this process's time zone. */
export function localTsToMs(ts: string): number {
  return new Date(ts).getTime();
}

const keyOf = (m: WaMessage) => `${m.ts}\u0000${m.author}\u0000${m.text}`;

function clip(text: string): string {
  return text.length > MAX_MESSAGE_CHARS ? `${text.slice(0, MAX_MESSAGE_CHARS)} […]` : text;
}

export class WhatsAppExportStore {
  constructor(private readonly dir: string) {}

  private botDir(botId: string): string {
    return join(this.dir, groupSlug(botId));
  }

  private path(botId: string, slug: string): string {
    return join(this.botDir(botId), `${groupSlug(slug)}.json`);
  }

  private read(botId: string, slug: string): GroupRecord | undefined {
    const p = this.path(botId, slug);
    if (!existsSync(p)) return undefined;
    try {
      return JSON.parse(readFileSync(p, 'utf-8')) as GroupRecord;
    } catch {
      return undefined;
    }
  }

  private write(botId: string, rec: GroupRecord): void {
    mkdirSync(this.botDir(botId), { recursive: true });
    const p = this.path(botId, rec.slug);
    const tmp = `${p}.tmp`;
    writeFileSync(tmp, JSON.stringify(rec, null, 2));
    renameSync(tmp, p);
  }

  private slugs(botId: string): string[] {
    const d = this.botDir(botId);
    if (!existsSync(d)) return [];
    return readdirSync(d)
      .filter((f) => f.endsWith('.json'))
      .map((f) => f.slice(0, -5));
  }

  /** Drops expired messages; writes back only when something changed. */
  private pruned(botId: string, rec: GroupRecord, nowMs: number): GroupRecord {
    const cutoff = nowMs - RETENTION_DAYS * DAY_MS;
    const kept = rec.messages.filter((m) => localTsToMs(m.ts) >= cutoff);
    if (kept.length === rec.messages.length) return rec;
    const next = { ...rec, messages: kept };
    this.write(botId, next);
    return next;
  }

  /** Records one export of `group`; returns what was new in it. */
  ingest(
    botId: string,
    group: string,
    messages: WaMessage[],
    opts: { nowMs: number; fileName: string }
  ): IngestResult {
    for (const s of this.slugs(botId)) {
      const r = this.read(botId, s);
      if (r) this.pruned(botId, r, opts.nowMs);
    }
    const slug = groupSlug(group);
    const prev = this.read(botId, slug);
    const cutoff = opts.nowMs - RETENTION_DAYS * DAY_MS;
    const at = new Date(opts.nowMs).toISOString();
    const cursor = prev?.lastMessageAt;

    const stored = new Map<string, number>();
    for (const m of prev?.messages ?? []) {
      const k = keyOf(m);
      stored.set(k, (stored.get(k) ?? 0) + 1);
    }

    let droppedOld = 0;
    const fresh: StoredMessage[] = [];
    let newest = cursor;
    for (const raw of messages) {
      const m = { ...raw, text: clip(raw.text) };
      if (!newest || m.ts > newest) newest = m.ts;
      if (localTsToMs(m.ts) < cutoff) {
        droppedOld++;
        continue;
      }
      const k = keyOf(m);
      const seen = stored.get(k) ?? 0;
      if (seen > 0) {
        stored.set(k, seen - 1);
        continue;
      }
      if (cursor && m.ts < cursor) continue;
      fresh.push({ ...m, seenAt: at });
    }

    const all = [...(prev?.messages ?? []), ...fresh]
      .filter((m) => localTsToMs(m.ts) >= cutoff)
      .sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0))
      .slice(-MAX_STORED_MESSAGES);

    this.write(botId, {
      version: 1,
      group,
      slug,
      ...(newest ? { lastMessageAt: newest } : {}),
      lastExport: {
        at,
        fileName: opts.fileName,
        ...(cursor ? { previousLastMessageAt: cursor } : {}),
        newCount: fresh.length,
      },
      messages: all,
    });

    return {
      group,
      slug,
      firstExport: !prev,
      newCount: fresh.length,
      droppedOld,
      ...(cursor ? { previousLastMessageAt: cursor } : {}),
      ...(fresh.length ? { from: fresh[0].ts, to: fresh[fresh.length - 1].ts } : {}),
    };
  }

  /** Known groups of a bot, newest export first. */
  list(botId: string): Array<{ group: string; slug: string; lastExportAt?: string }> {
    return this.slugs(botId)
      .map((s) => this.read(botId, s))
      .filter((r): r is GroupRecord => !!r)
      .map((r) => ({ group: r.group, slug: r.slug, lastExportAt: r.lastExport?.at }))
      .sort((a, b) => (b.lastExportAt ?? '').localeCompare(a.lastExportAt ?? ''));
  }

  /**
   * A group by slug or by part of its name (accent- and case-insensitive);
   * the most recently exported one when `query` is empty. Pruned on read.
   */
  find(botId: string, query: string | undefined, nowMs: number): GroupRecord | undefined {
    const groups = this.list(botId);
    let slug: string | undefined;
    if (!query?.trim()) {
      slug = groups[0]?.slug;
    } else {
      const q = groupSlug(query);
      slug = groups.find((g) => g.slug === q)?.slug ?? groups.find((g) => g.slug.includes(q))?.slug;
    }
    if (!slug) return undefined;
    const rec = this.read(botId, slug);
    return rec ? this.pruned(botId, rec, nowMs) : undefined;
  }

  /** Messages the latest export of `query` brought for the first time. */
  newMessages(botId: string, query: string | undefined, nowMs: number): StoredMessage[] {
    const rec = this.find(botId, query, nowMs);
    const at = rec?.lastExport?.at;
    if (!rec || !at) return [];
    return rec.messages.filter((m) => m.seenAt === at);
  }
}

/** The store under `<paths.data>/whatsapp-exports`. */
export function whatsappExportStoreFor(dataDir: string): WhatsAppExportStore {
  return new WhatsAppExportStore(join(dataDir, 'whatsapp-exports'));
}
