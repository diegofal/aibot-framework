import { createHash } from 'node:crypto';
import type { RawChunk } from './types';

export function estimateTokens(text: string): number {
  const words = text.split(/\s+/).filter(Boolean).length;
  return Math.ceil(words * 1.3);
}

export function contentHash(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

export interface ChunkOptions {
  targetTokens: number;
  overlapTokens: number;
}

export function chunkMarkdown(content: string, opts: ChunkOptions): RawChunk[] {
  const { targetTokens, overlapTokens } = opts;
  const lines = content.split('\n');
  const chunks: RawChunk[] = [];

  let currentLines: string[] = [];
  let currentTokens = 0;
  let startLine = 1; // 1-indexed

  function flushChunk() {
    if (currentLines.length === 0) return;

    const text = currentLines.join('\n');
    chunks.push({
      content: text,
      startLine,
      endLine: startLine + currentLines.length - 1,
      tokenEstimate: estimateTokens(text),
      contentHash: contentHash(text),
    });
  }

  function computeOverlap(): { lines: string[]; tokens: number } {
    // Walk backward from the end of currentLines to build overlap
    const overlapLines: string[] = [];
    let overlapToks = 0;
    for (let i = currentLines.length - 1; i >= 0; i--) {
      const lineToks = estimateTokens(currentLines[i]);
      if (overlapToks + lineToks > overlapTokens && overlapLines.length > 0) break;
      overlapLines.unshift(currentLines[i]);
      overlapToks += lineToks;
    }
    return { lines: overlapLines, tokens: overlapToks };
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineTokens = estimateTokens(line);
    const isHeading = /^#{1,6}\s/.test(line);

    // If we hit a heading and already have content, flush current chunk
    if (isHeading && currentLines.length > 0 && currentTokens > 0) {
      flushChunk();
      const overlap = computeOverlap();
      currentLines = overlap.lines;
      currentTokens = overlap.tokens;
      startLine = i + 1 - overlap.lines.length + 1; // adjust for overlap
    }

    currentLines.push(line);
    currentTokens += lineTokens;

    // If we exceeded target tokens, flush
    if (currentTokens >= targetTokens) {
      flushChunk();
      const overlap = computeOverlap();
      currentLines = overlap.lines;
      currentTokens = overlap.tokens;
      startLine = i + 2 - overlap.lines.length; // next line minus overlap
    }
  }

  // Flush remaining content
  flushChunk();

  return chunks;
}
