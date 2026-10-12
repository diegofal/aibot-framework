/**
 * SoulLoader.readIdentityName — the name a bot goes by (IDENTITY.md `name:`),
 * used e.g. in the relay header. Synthetic data only.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SoulLoader } from '../src/soul';

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
