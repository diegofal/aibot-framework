/**
 * SoulLoader.readIdentityName — the name a bot goes by (IDENTITY.md `name:`),
 * used e.g. in the relay header. Synthetic data only.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SoulLoader, parseIdentityName, stripMarkdownEmphasis } from '../src/soul';

const silentLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  child: () => silentLogger,
} as any;

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function loader(identity?: string): SoulLoader {
  const dir = mkdtempSync(join(tmpdir(), 'soul-name-'));
  dirs.push(dir);
  if (identity !== undefined) writeFileSync(join(dir, 'IDENTITY.md'), identity);
  return new SoulLoader({ enabled: true, dir } as any, silentLogger);
}

describe('SoulLoader.readIdentityName', () => {
  test('reads the name field of IDENTITY.md', () => {
    expect(loader('name: Finny\nemoji: 🐟\nvibe: curious').readIdentityName()).toBe('Finny');
  });

  test('the key is case-insensitive and the value trimmed', () => {
    expect(loader('Name:   Finny  \n').readIdentityName()).toBe('Finny');
  });

  test('null without IDENTITY.md or without a name line', () => {
    expect(loader().readIdentityName()).toBeNull();
    expect(loader('emoji: 🐟\n').readIdentityName()).toBeNull();
  });
});

describe('identity name written in markdown', () => {
  test('bold key and value: "**Name:** MyFirstMillion Bot"', () => {
    expect(loader('# Identity\n\n**Name:** MyFirstMillion Bot\n').readIdentityName()).toBe(
      'MyFirstMillion Bot'
    );
  });

  test('list item, bold value, backticks, underscores', () => {
    expect(loader('- **name**: `Finny`\n').readIdentityName()).toBe('Finny');
    expect(loader('* Name: **Finny**\n').readIdentityName()).toBe('Finny');
    expect(loader('name: __Finny__\n').readIdentityName()).toBe('Finny');
    expect(loader('name: *Finny*\n').readIdentityName()).toBe('Finny');
  });

  test('a value that is only emphasis marks is no name', () => {
    expect(loader('**Name:** **\n').readIdentityName()).toBeNull();
  });

  test('parseIdentityName and stripMarkdownEmphasis are pure', () => {
    expect(parseIdentityName('**Name:** MyFirstMillion Bot')).toBe('MyFirstMillion Bot');
    expect(parseIdentityName(null)).toBeNull();
    expect(stripMarkdownEmphasis('** MyFirstMillion Bot')).toBe('MyFirstMillion Bot');
    expect(stripMarkdownEmphasis('`a_b`')).toBe('a_b');
    expect(stripMarkdownEmphasis('snake_case_name')).toBe('snake_case_name');
  });
});

describe('identity name: only the top identity block', () => {
  test('a name: bullet under another section is not the bot name', () => {
    expect(parseIdentityName('# Identity\n\n## People I serve\n- name: Diego\n')).toBeNull();
    expect(parseIdentityName('## People I serve\n- **Name:** Diego\n')).toBeNull();
  });

  test('the name before the first ## section wins over a later one', () => {
    expect(
      parseIdentityName('# Identity\n\n**Name:** Finny\n\n## People I serve\n- name: Diego\n')
    ).toBe('Finny');
  });

  test('a ## Identity section at the top is the identity block', () => {
    expect(
      parseIdentityName('# Me\n\n## Identity\n- **name**: `Finny`\n\n## People\n- name: Diego\n')
    ).toBe('Finny');
    expect(parseIdentityName('## People\n- name: Diego\n\n## Identity\nname: Finny\n')).toBeNull();
  });
});

describe('identity name: block level and generated-soul headings', () => {
  test('### sub-sections under ## Identity stay inside the block', () => {
    expect(parseIdentityName('## Identity\n### Basics\n- name: Atlas\n')).toBe('Atlas');
    expect(
      parseIdentityName('# Me\n\n## Identity\n### Voice\ncalm\n### Basics\nname: Atlas\n')
    ).toBe('Atlas');
  });

  test('generated souls: ## Profile / ## Core / ## Basics / ## Perfil are identity blocks', () => {
    expect(parseIdentityName('# Atlas\n\n## Profile\n- name: Atlas\n')).toBe('Atlas');
    expect(parseIdentityName('# Atlas\n\n## Core\n- **Name:** Atlas\n')).toBe('Atlas');
    expect(parseIdentityName('## Basics\nname: Atlas\n')).toBe('Atlas');
    expect(parseIdentityName('## Perfil\n- nombre: x\n- name: Atlas\n')).toBe('Atlas');
    expect(parseIdentityName('## 🪪 Bot identity\nname: Atlas\n')).toBe('Atlas');
  });

  test('a ## heading at the same level closes the identity block', () => {
    expect(
      parseIdentityName('## Identity\n### Basics\nemoji: x\n## People I serve\n- name: Diego\n')
    ).toBeNull();
  });

  test('people / contacts / operator sections are still rejected', () => {
    expect(parseIdentityName('## People I serve\n- name: Diego\n')).toBeNull();
    expect(parseIdentityName('## Contacts\n- name: Diego\n')).toBeNull();
    expect(parseIdentityName('## Operator\n- name: Diego\n')).toBeNull();
    expect(parseIdentityName('## Operator profile\n- name: Diego\n')).toBeNull();
    expect(parseIdentityName('## Identity\n### Operator\n- name: Diego\n')).toBeNull();
  });
});

describe('identity: one parser for the prompt, the relay and writeIdentity', () => {
  const MIXED = '## Identity\n**Name:** Luna\n\n## People I serve\nname: Diego\n';

  test('the system prompt names the bot from the identity block, not the People section', () => {
    const l = loader(MIXED);
    expect(l.readIdentityName()).toBe('Luna');
    const prompt = l.composeSystemPrompt() ?? '';
    expect(prompt).toContain('Your name is Luna.');
    expect(prompt).not.toContain('Diego');
  });

  test('writeIdentity updates the bold line in the identity block, never the People line', () => {
    const l = loader(MIXED);
    l.writeIdentity({ name: 'Nova' });
    const raw = readFileSync(join(l.getDir(), 'IDENTITY.md'), 'utf-8');
    expect(raw).toBe('## Identity\n**Name:** Nova\n\n## People I serve\nname: Diego\n');
    expect(l.readIdentityName()).toBe('Nova');
  });

  test('writeIdentity adds a missing field inside the identity block', () => {
    const l = loader(MIXED);
    l.writeIdentity({ emoji: '🦊' });
    const raw = readFileSync(join(l.getDir(), 'IDENTITY.md'), 'utf-8');
    expect(raw).toBe('## Identity\n**Name:** Luna\nemoji: 🦊\n\n## People I serve\nname: Diego\n');
  });

  test('writeIdentity on a flat or missing file writes key: value lines', () => {
    const flat = loader('name: Jarvis\nemoji: x\n');
    flat.writeIdentity({ vibe: 'calm', name: 'J' });
    expect(readFileSync(join(flat.getDir(), 'IDENTITY.md'), 'utf-8')).toBe(
      'name: J\nemoji: x\nvibe: calm\n'
    );
    const none = loader();
    none.writeIdentity({ name: 'Atlas' });
    expect(readFileSync(join(none.getDir(), 'IDENTITY.md'), 'utf-8')).toBe('name: Atlas\n');
  });
});

describe('identity: level-1 headings', () => {
  test('a # heading after the identity block closes it', () => {
    expect(parseIdentityName('## Identity\n- emoji: 🦊\n\n# Operator\nname: Diego\n')).toBeNull();
    expect(parseIdentityName('## Identity\n- emoji: 🦊\n\n# Notes\nname: Diego\n')).toBeNull();
  });

  test('a # title line at the top opens the file', () => {
    expect(parseIdentityName('# Atlas\n\nname: Atlas\n')).toBe('Atlas');
    expect(parseIdentityName('# Identity\nname: Atlas\n')).toBe('Atlas');
    expect(parseIdentityName('# Operator\nname: Diego\n')).toBeNull();
  });
});
