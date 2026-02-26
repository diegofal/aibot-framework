import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  discoverSkillDirs,
  discoverProductionSkillPaths,
  checkRequirements,
  normalizeToolDefs,
  loadExternalSkill,
  type ExternalSkillManifest,
} from '../../src/core/external-skill-loader';

const tmpBase = join(import.meta.dir, '..', '..', '.tmp-test-skills');

function makeSkillDir(name: string, manifest: Record<string, unknown>, handlerCode?: string): string {
  const dir = join(tmpBase, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'skill.json'), JSON.stringify(manifest, null, 2));
  if (handlerCode) {
    writeFileSync(join(dir, 'index.ts'), handlerCode);
  }
  return dir;
}

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

describe('discoverSkillDirs', () => {
  test('finds directories with valid skill.json containing tools[]', () => {
    const skillDir = makeSkillDir('discover-valid', {
      id: 'test-skill',
      name: 'Test',
      tools: [{ name: 'do_thing', description: 'does stuff', parameters: { type: 'object', properties: {} } }],
    });

    const dirs = discoverSkillDirs([tmpBase]);
    expect(dirs).toContain(skillDir);
  });

  test('skips directories without skill.json', () => {
    const dir = join(tmpBase, 'no-manifest');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'index.ts'), 'export const handlers = {};');

    const dirs = discoverSkillDirs([tmpBase]);
    expect(dirs).not.toContain(dir);
  });

  test('skips skill.json without tools[]', () => {
    makeSkillDir('no-tools', {
      id: 'no-tools',
      name: 'No Tools',
      // no tools array
    });

    const dirs = discoverSkillDirs([tmpBase]);
    const noToolsDir = join(tmpBase, 'no-tools');
    expect(dirs).not.toContain(noToolsDir);
  });

  test('skips skill.json with empty tools[]', () => {
    makeSkillDir('empty-tools', {
      id: 'empty-tools',
      name: 'Empty Tools',
      tools: [],
    });

    const dirs = discoverSkillDirs([tmpBase]);
    const emptyDir = join(tmpBase, 'empty-tools');
    expect(dirs).not.toContain(emptyDir);
  });

  test('skips malformed JSON', () => {
    const dir = join(tmpBase, 'bad-json');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'skill.json'), 'not valid json{{{');

    const dirs = discoverSkillDirs([tmpBase]);
    expect(dirs).not.toContain(dir);
  });

  test('handles non-existent paths gracefully', () => {
    const dirs = discoverSkillDirs(['/tmp/does-not-exist-12345']);
    expect(dirs).toEqual([]);
  });

  test('handles empty paths array', () => {
    const dirs = discoverSkillDirs([]);
    expect(dirs).toEqual([]);
  });
});

describe('checkRequirements', () => {
  test('returns empty for no requirements', () => {
    const manifest: ExternalSkillManifest = {
      id: 'test', name: 'Test', tools: [],
    };
    expect(checkRequirements(manifest)).toEqual([]);
  });

  test('detects missing binary', () => {
    const manifest: ExternalSkillManifest = {
      id: 'test', name: 'Test', tools: [],
      requires: { bins: ['nonexistent-binary-xyz-123'] },
    };
    const warnings = checkRequirements(manifest);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('Missing binary');
  });

  test('detects missing env var', () => {
    const manifest: ExternalSkillManifest = {
      id: 'test', name: 'Test', tools: [],
      requires: { env: ['TOTALLY_NONEXISTENT_VAR_XYZ'] },
    };
    const warnings = checkRequirements(manifest);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('Missing env var');
  });

  test('passes when binary exists', () => {
    const manifest: ExternalSkillManifest = {
      id: 'test', name: 'Test', tools: [],
      requires: { bins: ['ls'] },
    };
    const warnings = checkRequirements(manifest);
    expect(warnings).toEqual([]);
  });

  test('passes when env var is set', () => {
    const envKey = 'TEST_LOADER_CHECK_' + Date.now();
    process.env[envKey] = 'yes';
    const manifest: ExternalSkillManifest = {
      id: 'test', name: 'Test', tools: [],
      requires: { env: [envKey] },
    };
    const warnings = checkRequirements(manifest);
    expect(warnings).toEqual([]);
    delete process.env[envKey];
  });

  test('accumulates multiple warnings', () => {
    const manifest: ExternalSkillManifest = {
      id: 'test', name: 'Test', tools: [],
      requires: {
        bins: ['nonexistent-bin-1', 'nonexistent-bin-2'],
        env: ['MISSING_VAR_1'],
      },
    };
    const warnings = checkRequirements(manifest);
    expect(warnings.length).toBeGreaterThanOrEqual(3);
  });
});

describe('normalizeToolDefs', () => {
  test('uses name field as-is', () => {
    const manifest: ExternalSkillManifest = {
      id: 'test', name: 'Test',
      tools: [{ name: 'my_tool', description: 'desc', parameters: { type: 'object', properties: {} } }],
    };
    const defs = normalizeToolDefs(manifest);
    expect(defs[0].name).toBe('my_tool');
  });

  test('falls back to id when name is missing', () => {
    const manifest: ExternalSkillManifest = {
      id: 'test', name: 'Test',
      tools: [{ id: 'alt_tool', description: 'desc', parameters: { type: 'object', properties: {} } } as any],
    };
    const defs = normalizeToolDefs(manifest);
    expect(defs[0].name).toBe('alt_tool');
  });

  test('provides default parameters when missing', () => {
    const manifest: ExternalSkillManifest = {
      id: 'test', name: 'Test',
      tools: [{ name: 'bare', description: 'desc' } as any],
    };
    const defs = normalizeToolDefs(manifest);
    expect(defs[0].parameters).toEqual({ type: 'object', properties: {} });
  });
});

describe('loadExternalSkill', () => {
  test('loads a valid skill with matching handlers', async () => {
    makeSkillDir('load-valid', {
      id: 'load-valid',
      name: 'Load Valid',
      tools: [
        { name: 'greet', description: 'Say hello', parameters: { type: 'object', properties: { name: { type: 'string' } } } },
      ],
    }, `
export const handlers = {
  greet: async (args) => ({ message: 'Hello ' + args.name }),
};
`);

    const loaded = await loadExternalSkill(join(tmpBase, 'load-valid'), mockLogger);
    expect(loaded.manifest.id).toBe('load-valid');
    expect(loaded.manifest.tools).toHaveLength(1);
    expect(loaded.manifest.tools[0].name).toBe('greet');
    expect(typeof loaded.handlers.greet).toBe('function');
    expect(loaded.warnings).toEqual([]);
  });

  test('warns about missing handler for declared tool', async () => {
    makeSkillDir('load-missing-handler', {
      id: 'missing-handler',
      name: 'Missing Handler',
      tools: [
        { name: 'tool_a', description: 'exists', parameters: { type: 'object', properties: {} } },
        { name: 'tool_b', description: 'missing', parameters: { type: 'object', properties: {} } },
      ],
    }, `
export const handlers = {
  tool_a: async () => 'ok',
};
`);

    const loaded = await loadExternalSkill(join(tmpBase, 'load-missing-handler'), mockLogger);
    expect(loaded.warnings).toContain('Tool "tool_b" declared in manifest but no handler found');
  });

  test('throws on missing id', async () => {
    makeSkillDir('no-id', { name: 'No ID', tools: [{ name: 'x', description: 'x', parameters: { type: 'object', properties: {} } }] });

    expect(
      loadExternalSkill(join(tmpBase, 'no-id'), mockLogger)
    ).rejects.toThrow('missing "id"');
  });

  test('throws on empty tools array', async () => {
    makeSkillDir('empty-arr', { id: 'empty', name: 'Empty', tools: [] });

    expect(
      loadExternalSkill(join(tmpBase, 'empty-arr'), mockLogger)
    ).rejects.toThrow('missing or empty "tools" array');
  });

  test('throws when handler file is missing', async () => {
    makeSkillDir('no-handler-file', {
      id: 'no-handler',
      name: 'No Handler File',
      tools: [{ name: 'x', description: 'x', parameters: { type: 'object', properties: {} } }],
    });
    // No index.ts written

    expect(
      loadExternalSkill(join(tmpBase, 'no-handler-file'), mockLogger)
    ).rejects.toThrow('Handler file not found');
  });

  test('respects custom entry field', async () => {
    const dir = join(tmpBase, 'custom-entry');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'skill.json'), JSON.stringify({
      id: 'custom-entry',
      name: 'Custom Entry',
      entry: 'custom.ts',
      tools: [{ name: 'ping', description: 'ping', parameters: { type: 'object', properties: {} } }],
    }));
    writeFileSync(join(dir, 'custom.ts'), `export const handlers = { ping: async () => 'pong' };`);

    const loaded = await loadExternalSkill(dir, mockLogger);
    expect(loaded.manifest.id).toBe('custom-entry');
    expect(typeof loaded.handlers.ping).toBe('function');
  });
});

describe('discoverProductionSkillPaths', () => {
  const prodBase = join(tmpBase, 'productions');

  test('discovers valid production skill paths', () => {
    const skillsDir = join(prodBase, 'mybot', 'src', 'skills');
    mkdirSync(skillsDir, { recursive: true });

    const results = discoverProductionSkillPaths(prodBase);
    expect(results.length).toBe(1);
    expect(results[0].botName).toBe('mybot');
    expect(results[0].path).toBe(skillsDir);
  });

  test('skips production dirs without src/skills/', () => {
    const noSkillsDir = join(prodBase, 'otherbot', 'src');
    mkdirSync(noSkillsDir, { recursive: true });

    const results = discoverProductionSkillPaths(prodBase);
    const otherBot = results.find((r) => r.botName === 'otherbot');
    expect(otherBot).toBeUndefined();
  });

  test('returns empty for non-existent base directory', () => {
    const results = discoverProductionSkillPaths('/tmp/nonexistent-prod-dir-12345');
    expect(results).toEqual([]);
  });

  test('discovers multiple production bots', () => {
    mkdirSync(join(prodBase, 'bot-a', 'src', 'skills'), { recursive: true });
    mkdirSync(join(prodBase, 'bot-b', 'src', 'skills'), { recursive: true });

    const results = discoverProductionSkillPaths(prodBase);
    const botNames = results.map((r) => r.botName);
    expect(botNames).toContain('bot-a');
    expect(botNames).toContain('bot-b');
  });
});
