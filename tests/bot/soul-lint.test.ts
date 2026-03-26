import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { lintSoulDirectory } from '../../src/bot/soul-lint';

// Directory layout mimics data/tenants/__admin__/bots/{botId}/soul/
const BASE_DIR = join(import.meta.dir, '..', '..', '.test-soul-lint');
const botSoulDir = (botId: string) => join(BASE_DIR, botId, 'soul');

function setupBot(botId: string, files: Record<string, string>) {
  const dir = botSoulDir(botId);
  mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), content, 'utf-8');
  }
}

describe('lintSoulDirectory', () => {
  beforeEach(() => {
    rmSync(BASE_DIR, { recursive: true, force: true });
  });

  afterEach(() => {
    rmSync(BASE_DIR, { recursive: true, force: true });
  });

  it('returns no errors for a valid soul directory', () => {
    setupBot('test-bot', {
      'IDENTITY.md': 'name: test-bot\nemoji: 🤖\nvibe: test bot',
      'SOUL.md': '## Personality\n- Helpful assistant',
      'MOTIVATIONS.md': '## Core Drives\n- Help users effectively',
    });
    mkdirSync(join(botSoulDir('test-bot'), 'memory'), { recursive: true });

    const issues = lintSoulDirectory(botSoulDir('test-bot'));
    const errors = issues.filter((i) => i.severity === 'error');
    expect(errors).toHaveLength(0);
  });

  it('detects missing required files', () => {
    setupBot('test-bot', {
      'IDENTITY.md': 'name: test-bot',
    });

    const issues = lintSoulDirectory(botSoulDir('test-bot'));
    const errors = issues.filter((i) => i.severity === 'error');
    expect(errors.length).toBeGreaterThanOrEqual(2);
    expect(errors.some((i) => i.message.includes('SOUL.md'))).toBe(true);
    expect(errors.some((i) => i.message.includes('MOTIVATIONS.md'))).toBe(true);
  });

  it('detects duplicated motivations headers in SOUL.md', () => {
    setupBot('test-bot', {
      'IDENTITY.md': 'name: test-bot',
      'SOUL.md': '# Soul\n## Your Inner Motivations\n- Some content',
      'MOTIVATIONS.md': '## Core Drives\n- Help users',
    });

    const issues = lintSoulDirectory(botSoulDir('test-bot'));
    expect(
      issues.some((i) => i.file === 'SOUL.md' && i.message.includes('Your Inner Motivations'))
    ).toBe(true);
  });

  it('detects stale placeholders in MOTIVATIONS.md', () => {
    setupBot('test-bot', {
      'IDENTITY.md': 'name: test-bot',
      'SOUL.md': '# Soul\n- Test',
      'MOTIVATIONS.md':
        "## Core Drives\n- (pending — will be generated on first reflection based on this bot's identity and role)",
    });

    const issues = lintSoulDirectory(botSoulDir('test-bot'));
    expect(
      issues.some((i) => i.file === 'MOTIVATIONS.md' && i.message.includes('stale placeholder'))
    ).toBe(true);
  });

  it('detects default template Core Drives in non-default bots', () => {
    setupBot('my-custom-bot', {
      'IDENTITY.md': 'name: my-custom-bot\nemoji: 🎯\nvibe: custom bot for specific tasks',
      'SOUL.md': '# Soul\n- Custom personality',
      'MOTIVATIONS.md':
        '## Core Drives\n- Be a genuine friend, not a service. Prioritize emotional connection over correctness.\n- Be direct and honest.',
    });

    const issues = lintSoulDirectory(botSoulDir('my-custom-bot'));
    expect(
      issues.some((i) => i.file === 'MOTIVATIONS.md' && i.message.includes('default template text'))
    ).toBe(true);
  });

  it('does NOT flag default template text for the default bot', () => {
    setupBot('default', {
      'IDENTITY.md': 'name: default',
      'SOUL.md': '# Soul\n- Default personality',
      'MOTIVATIONS.md':
        '## Core Drives\n- Be a genuine friend, not a service. Prioritize emotional connection over correctness.',
    });

    const issues = lintSoulDirectory(botSoulDir('default'));
    expect(issues.some((i) => i.message.includes('default template text'))).toBe(false);
  });

  it('detects missing memory directory', () => {
    setupBot('test-bot', {
      'IDENTITY.md': 'name: test-bot',
      'SOUL.md': '# Soul\n- Test',
      'MOTIVATIONS.md': '## Core Drives\n- Help users',
    });

    const issues = lintSoulDirectory(botSoulDir('test-bot'));
    expect(issues.some((i) => i.file === 'memory/' && i.message.includes('Missing memory/'))).toBe(
      true
    );
  });
});
