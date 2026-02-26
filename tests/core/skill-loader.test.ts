import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { SkillLoader } from '../../src/core/skill-loader';

const tmpBase = join(import.meta.dir, '..', '..', '.tmp-test-skill-loader');

const mockLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => mockLogger,
  level: 'debug',
  fatal: () => {},
} as any;

beforeAll(() => {
  mkdirSync(tmpBase, { recursive: true });
});

afterAll(() => {
  if (existsSync(tmpBase)) {
    rmSync(tmpBase, { recursive: true });
  }
});

describe('SkillLoader.readManifest', () => {
  test('returns manifest for a valid skill.json', () => {
    const skillId = 'valid-skill';
    const skillDir = join(tmpBase, skillId);
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, 'skill.json'), JSON.stringify({
      id: skillId,
      name: 'Valid Skill',
      version: '1.0.0',
      description: 'A test skill',
      main: 'index.ts',
    }));

    const loader = new SkillLoader(tmpBase, mockLogger);
    const manifest = loader.readManifest(skillId);
    expect(manifest).not.toBeNull();
    expect(manifest!.id).toBe(skillId);
    expect(manifest!.name).toBe('Valid Skill');
    expect(manifest!.version).toBe('1.0.0');
    expect(manifest!.description).toBe('A test skill');
  });

  test('returns null for missing skill directory', () => {
    const loader = new SkillLoader(tmpBase, mockLogger);
    const manifest = loader.readManifest('nonexistent');
    expect(manifest).toBeNull();
  });

  test('returns null for invalid JSON', () => {
    const skillId = 'bad-json-skill';
    const skillDir = join(tmpBase, skillId);
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, 'skill.json'), 'not valid json');

    const loader = new SkillLoader(tmpBase, mockLogger);
    const manifest = loader.readManifest(skillId);
    expect(manifest).toBeNull();
  });

  test('returns null for manifest missing required fields', () => {
    const skillId = 'incomplete-skill';
    const skillDir = join(tmpBase, skillId);
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, 'skill.json'), JSON.stringify({
      id: skillId,
      name: 'Incomplete',
      // missing version and main
    }));

    const loader = new SkillLoader(tmpBase, mockLogger);
    const manifest = loader.readManifest(skillId);
    expect(manifest).toBeNull();
  });
});
