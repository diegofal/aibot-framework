/**
 * RssSensor — Polls RSS/Atom feeds and reports new articles.
 *
 * Self-contained RSS parser (no external deps). Tracks last-seen entry IDs
 * per feed to detect new items.
 */

import type { Sensor, StimulusEvent } from './types';

const MAX_BODY_SIZE = 256 * 1024; // 256KB max per feed
const FETCH_TIMEOUT_MS = 10_000;

export class RssSensor implements Sensor {
  id = 'rss';
  /** feedUrl → Set<entryId> of previously seen items */
  private seenIds = new Map<string, Set<string>>();

  constructor(private feeds: string[]) {}

  async poll(_botId: string): Promise<StimulusEvent[]> {
    const events: StimulusEvent[] = [];

    for (const feedUrl of this.feeds) {
      try {
        const newItems = await this.checkFeed(feedUrl);
        for (const item of newItems.slice(0, 3)) {
          events.push({
            sensorId: this.id,
            timestamp: Date.now(),
            category: 'content',
            summary: `New: ${item.title}`.slice(0, 100),
            relevance: 0.6,
            data: { feedUrl, title: item.title, link: item.link, published: item.published },
          });
        }
      } catch {
        // Skip failed feeds silently
      }
    }

    return events;
  }

  private async checkFeed(url: string): Promise<FeedItem[]> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    try {
      const resp = await fetch(url, {
        signal: controller.signal,
        headers: { 'User-Agent': 'AIBot-Framework/1.0 RSS-Sensor' },
      });
      if (!resp.ok) return [];

      const text = await readBoundedBody(resp, MAX_BODY_SIZE);
      const items = parseRssXml(text);

      // Track seen IDs
      let seen = this.seenIds.get(url);
      if (!seen) {
        // First poll: mark all as seen, return nothing
        seen = new Set(items.map((i) => i.id));
        this.seenIds.set(url, seen);
        return [];
      }

      const newItems = items.filter((i) => !seen?.has(i.id));
      for (const item of items) seen.add(item.id);

      // Prune seen set to prevent memory leak (keep last 200)
      if (seen.size > 200) {
        const arr = [...seen];
        this.seenIds.set(url, new Set(arr.slice(-200)));
      }

      return newItems;
    } finally {
      clearTimeout(timeout);
    }
  }
}

// ── Lightweight RSS/Atom parser ──

interface FeedItem {
  id: string;
  title: string;
  link?: string;
  published?: string;
}

/**
 * Parse RSS 2.0 and Atom feeds from XML text.
 * Minimal regex-based parser — no XML library needed.
 */
export function parseRssXml(xml: string): FeedItem[] {
  const items: FeedItem[] = [];

  // Try RSS 2.0 <item> elements
  const rssItems = xml.match(/<item[\s>][\s\S]*?<\/item>/gi) ?? [];
  for (const itemXml of rssItems) {
    const title = extractTag(itemXml, 'title');
    const link = extractTag(itemXml, 'link');
    const guid = extractTag(itemXml, 'guid');
    const pubDate = extractTag(itemXml, 'pubDate');
    if (title) {
      items.push({
        id: guid || link || title,
        title: decodeEntities(title),
        link: link || undefined,
        published: pubDate || undefined,
      });
    }
  }

  // Try Atom <entry> elements
  if (items.length === 0) {
    const atomEntries = xml.match(/<entry[\s>][\s\S]*?<\/entry>/gi) ?? [];
    for (const entryXml of atomEntries) {
      const title = extractTag(entryXml, 'title');
      const id = extractTag(entryXml, 'id');
      const linkMatch = entryXml.match(/<link[^>]*href="([^"]*)"[^>]*\/?>/i);
      const link = linkMatch?.[1];
      const updated = extractTag(entryXml, 'updated') || extractTag(entryXml, 'published');
      if (title) {
        items.push({
          id: id || link || title,
          title: decodeEntities(title),
          link: link || undefined,
          published: updated || undefined,
        });
      }
    }
  }

  return items;
}

function extractTag(xml: string, tag: string): string | null {
  // Handle CDATA: <tag><![CDATA[content]]></tag>
  const cdataMatch = xml.match(
    new RegExp(`<${tag}[^>]*>\\s*<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>\\s*</${tag}>`, 'i')
  );
  if (cdataMatch) return cdataMatch[1].trim();
  // Normal text content
  const match = xml.match(new RegExp(`<${tag}[^>]*>([^<]*)</${tag}>`, 'i'));
  return match ? match[1].trim() : null;
}

function decodeEntities(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCharCode(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(Number.parseInt(dec)));
}

async function readBoundedBody(resp: Response, maxBytes: number): Promise<string> {
  const reader = resp.body?.getReader();
  if (!reader) return '';

  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > maxBytes) {
      reader.cancel();
      break;
    }
    chunks.push(value);
  }

  const decoder = new TextDecoder('utf-8');
  return chunks.map((c) => decoder.decode(c, { stream: true })).join('') + decoder.decode();
}
