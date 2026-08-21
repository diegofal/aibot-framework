import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const CSS = readFileSync(join(import.meta.dir, '../../web/style.css'), 'utf-8').replace(
  /\/\*[\s\S]*?\*\//g,
  ''
);

/** Return the declaration block of the first rule whose selector list matches exactly. */
function ruleBlock(selector: string): string {
  const rules = CSS.matchAll(/([^{}]+)\{([^{}]*)\}/g);
  for (const [, sel, body] of rules) {
    const normalized = sel
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .join(', ');
    if (normalized === selector) return body;
  }
  throw new Error(`CSS rule not found: ${selector}`);
}

describe('thread layout', () => {
  it('lets the transcript use the full width of the content area', () => {
    const block = ruleBlock('.transcript');
    expect(block).not.toMatch(/max-width:\s*700px/);
    expect(block).toMatch(/max-width:\s*100%/);
  });

  it('sizes thread messages against the viewport instead of a fixed 300px box', () => {
    const block = ruleBlock('.thread-messages');
    expect(block).not.toMatch(/max-height:\s*300px;/);
    expect(block).toMatch(/max-height:\s*max\(300px,\s*calc\(100vh\s*-\s*\d+px\)\)/);
  });

  it('gives every full-page thread view the tall variant', () => {
    const selector = [
      '#conv-thread-container .thread-messages',
      '#inbox-thread-container .thread-messages',
      '#prod-chat-thread .thread-messages',
    ].join(', ');
    const block = ruleBlock(selector);
    expect(block).toMatch(/max-height:\s*calc\(100vh\s*-\s*\d+px\)/);
  });
});
