import { createHash } from 'node:crypto';
/**
 * Per-bot, per-group record of WhatsApp exports the operator sent:
 * `<dir>/<botId>/<group-slug>.json`.
 *
 * These are other parents' and children's messages. Only a bounded window is
 * kept (`RETENTION_DAYS`, `MAX_STORED_MESSAGES`, `MAX_MESSAGE_CHARS`), pruned
 * on every ingest (all groups of the bot), every read, and by a sweep over all
 * groups shortly after boot and then daily (`startWhatsAppExportSweep`). Files
 * are written owner-only (0o600). The cursor
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
import type { Logger } from '../logger';
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
  /** This export's id (its `lastExport.at`): every message it added carries it as `seenAt`. */
  exportAt: string;
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
    // Other people's messages: owner-only, like the personal-accounts store.
    writeFileSync(tmp, JSON.stringify(rec, null, 2), { mode: 0o600 });
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

  /**
   * Drops expired messages from every group of every bot (the boot / daily
   * sweep: a group nobody exports or reads again would otherwise keep them).
   */
  pruneAll(nowMs: number): { groups: number; dropped: number } {
    if (!existsSync(this.dir)) return { groups: 0, dropped: 0 };
    let groups = 0;
    let dropped = 0;
    for (const entry of readdirSync(this.dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const botId = entry.name;
      for (const slug of this.slugs(botId)) {
        const rec = this.read(botId, slug);
        if (!rec) continue;
        groups++;
        dropped += rec.messages.length - this.pruned(botId, rec, nowMs).messages.length;
      }
    }
    return { groups, dropped };
  }

  /**
   * Where `group` is stored. Its slug when that is free or already holds this
   * exact group; otherwise (two names one slug apart, "Class 1/A" and "Class 1-A")
   * the slug plus a hash of the name, so neither reads the other's messages.
   */
  private storageSlug(botId: string, group: string): string {
    const slug = groupSlug(group);
    const owner = this.read(botId, slug);
    if (!owner || owner.group === group) return slug;
    const hash = createHash('sha256').update(group).digest('hex').slice(0, 8);
    return `${slug.slice(0, 51).replace(/-+$/, '')}-${hash}`;
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
    const slug = this.storageSlug(botId, group);
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
      exportAt: at,
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
   * The group holding export `exportAt` (the messages it added carry it as
   * `seenAt`), narrowed to `query` when given. Pruned on read.
   */
  findByExport(
    botId: string,
    exportAt: string,
    query: string | undefined,
    nowMs: number
  ): GroupRecord | undefined {
    const named = query?.trim() ? this.find(botId, query, nowMs) : undefined;
    const pool = named
      ? [named]
      : this.slugs(botId)
          .map((s) => this.read(botId, s))
          .filter((r): r is GroupRecord => !!r)
          .map((r) => this.pruned(botId, r, nowMs));
    return pool.find(
      (r) => r.lastExport?.at === exportAt || r.messages.some((m) => m.seenAt === exportAt)
    );
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
      // The exact name first: two names can share a slug ("Class 1/A", "Class 1-A").
      const exact = query.trim().toLowerCase();
      const q = groupSlug(query);
      slug =
        groups.find((g) => g.group.trim().toLowerCase() === exact)?.slug ??
        groups.find((g) => g.slug === q)?.slug ??
        groups.find((g) => g.slug.includes(q))?.slug;
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

type SweepTimer = { unref?: () => void };
export interface WhatsAppSweepTimers {
  setTimeout(fn: () => void, ms: number): SweepTimer;
  setInterval(fn: () => void, ms: number): SweepTimer;
  clear(handle: SweepTimer): void;
}

const realSweepTimers: WhatsAppSweepTimers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clear: (h) => {
    clearTimeout(h as ReturnType<typeof setTimeout>);
    clearInterval(h as ReturnType<typeof setInterval>);
  },
};

/** First sweep shortly after boot, then daily. */
export const WHATSAPP_SWEEP_START_DELAY_MS = 60_000;
export const WHATSAPP_SWEEP_INTERVAL_MS = DAY_MS;

/**
 * Retention sweep over every stored group: once shortly after boot, then every
 * `intervalMs`. Timers are unref'd (never keep the process alive); a failing
 * prune is logged and never escapes.
 */
export function startWhatsAppExportSweep(deps: {
  store: Pick<WhatsAppExportStore, 'pruneAll'>;
  logger: Pick<Logger, 'info' | 'warn'>;
  now?: () => number;
  timers?: WhatsAppSweepTimers;
  startDelayMs?: number;
  intervalMs?: number;
}): { stop: () => void } {
  const timers = deps.timers ?? realSweepTimers;
  const now = deps.now ?? Date.now;
  const handles: SweepTimer[] = [];
  const tick = () => {
    try {
      const r = deps.store.pruneAll(now());
      if (r.dropped > 0) deps.logger.info(r, 'whatsapp-export: retention sweep');
    } catch (err) {
      deps.logger.warn({ err }, 'whatsapp-export: retention sweep failed');
    }
  };
  const first = timers.setTimeout(() => {
    tick();
    const every = timers.setInterval(tick, deps.intervalMs ?? WHATSAPP_SWEEP_INTERVAL_MS);
    every.unref?.();
    handles.push(every);
  }, deps.startDelayMs ?? WHATSAPP_SWEEP_START_DELAY_MS);
  first.unref?.();
  handles.push(first);
  return {
    stop: () => {
      for (const h of handles) timers.clear(h);
    },
  };
}
