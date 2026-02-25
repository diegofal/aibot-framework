import { describe, test, expect, beforeAll, afterAll, mock } from 'bun:test';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { ToolRegistry } from '../../src/bot/tool-registry';
import type { BotContext } from '../../src/bot/types';

const tmpBase = join(import.meta.dir, '..', '..', '.tmp-test-ext-skip');

const logMessages: { level: string; msg: string; data: any }[] = [];

const mockLogger = {
  debug: (...args: any[]) => { logMessages.push({ level: 'debug', msg: args[1] ?? '', data: args[0] }); },
  info: (...args: any[]) => { logMessages.push({ level: 'info', msg: args[1] ?? '', data: args[0] }); },
  warn: (...args: any[]) => { logMessages.push({ level: 'warn', msg: args[1] ?? '', data: args[0] }); },
  error: (...args: any[]) => { logMessages.push({ level: 'error', msg: args[1] ?? '', data: args[0] }); },
  child: () => mockLogger,
  level: 'debug',
  fatal: () => {},
} as any;

function makeSkillDir(name: string, manifest: Record<string, unknown>, handlerCode: string): string {
  const dir = join(tmpBase, 'skills', name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'skill.json'), JSON.stringify(manifest, null, 2));
  writeFileSync(join(dir, 'index.ts'), handlerCode);
  return dir;
}

function createMockContext(): BotContext {
  return {
    config: {
      bots: [{ id: 'bot-1' }],
      skillsFolders: { paths: [join(tmpBase, 'skills')] },
      skills: {},
    },
    tools: [],
    toolDefinitions: [],
    logger: mockLogger,
  } as unknown as BotContext;
}

beforeAll(() => {
  mkdirSync(join(tmpBase, 'skills'), { recursive: true });
});

afterAll(() => {
  if (existsSync(tmpBase)) {
    rmSync(tmpBase, { recursive: true });
  }
});

describe('ToolRegistry.initializeExternalSkills: skip on missing requirements', () => {
  test('skips skill with missing env var and logs at info level', async () => {
    makeSkillDir('env-missing', {
      id: 'env-missing',
      name: 'Env Missing Skill',
      requires: { env: ['TOTALLY_NONEXISTENT_VAR_FOR_TEST_XYZ'] },
      tools: [{
        name: 'do_thing',
        description: 'does stuff',
        parameters: { type: 'object', properties: {} },
      }],
    }, `export const handlers = { do_thing: async () => ({ result: 'ok' }) };`);

    logMessages.length = 0;
    const ctx = createMockContext();
    const registry = new ToolRegistry(ctx);
    await registry.initializeExternalSkills();

    // Tool should NOT be registered
    const toolNames = ctx.tools.map(t => t.definition.function.name);
    expect(toolNames).not.toContain('env-missing_do_thing');

    // Should log at info level about skipping
    const skipLog = logMessages.find(
      m => m.level === 'info' && m.msg.includes('Skipping external skill'),
    );
    expect(skipLog).toBeTruthy();
    expect(skipLog!.data.skillId).toBe('env-missing');

    // Should NOT log at warn level for this skill
    const warnLog = logMessages.find(
      m => m.level === 'warn' && m.data?.skillId === 'env-missing',
    );
    expect(warnLog).toBeFalsy();
  });

  test('loads skill when env var IS set', async () => {
    const envKey = 'TEST_SKILL_PRESENT_' + Date.now();
    process.env[envKey] = 'yes';

    makeSkillDir('env-present', {
      id: 'env-present',
      name: 'Env Present Skill',
      requires: { env: [envKey] },
      tools: [{
        name: 'do_thing',
        description: 'does stuff',
        parameters: { type: 'object', properties: {} },
      }],
    }, `export const handlers = { do_thing: async () => ({ result: 'ok' }) };`);

    logMessages.length = 0;
    const ctx = createMockContext();
    const registry = new ToolRegistry(ctx);
    await registry.initializeExternalSkills();

    // Tool SHOULD be registered (namespaced)
    const toolNames = ctx.tools.map(t => t.definition.function.name);
    expect(toolNames).toContain('env-present_do_thing');

    delete process.env[envKey];
  });

  test('skips skill with missing binary requirement', async () => {
    makeSkillDir('bin-missing', {
      id: 'bin-missing',
      name: 'Bin Missing Skill',
      requires: { bins: ['totally_nonexistent_binary_xyz_123'] },
      tools: [{
        name: 'run_bin',
        description: 'runs binary',
        parameters: { type: 'object', properties: {} },
      }],
    }, `export const handlers = { run_bin: async () => ({ result: 'ok' }) };`);

    logMessages.length = 0;
    const ctx = createMockContext();
    const registry = new ToolRegistry(ctx);
    await registry.initializeExternalSkills();

    const toolNames = ctx.tools.map(t => t.definition.function.name);
    expect(toolNames).not.toContain('bin-missing_run_bin');

    const skipLog = logMessages.find(
      m => m.level === 'info' && m.msg.includes('Skipping external skill'),
    );
    expect(skipLog).toBeTruthy();
  });

  test('loads skill with no requirements specified', async () => {
    makeSkillDir('no-reqs', {
      id: 'no-reqs',
      name: 'No Requirements Skill',
      tools: [{
        name: 'simple_tool',
        description: 'simple',
        parameters: { type: 'object', properties: {} },
      }],
    }, `export const handlers = { simple_tool: async () => ({ result: 'ok' }) };`);

    logMessages.length = 0;
    const ctx = createMockContext();
    const registry = new ToolRegistry(ctx);
    await registry.initializeExternalSkills();

    const toolNames = ctx.tools.map(t => t.definition.function.name);
    expect(toolNames).toContain('no-reqs_simple_tool');
  });

  test('warning about missing handler does NOT cause skill to be skipped', async () => {
    makeSkillDir('handler-warn', {
      id: 'handler-warn',
      name: 'Handler Warning Skill',
      tools: [
        { name: 'tool_a', description: 'exists', parameters: { type: 'object', properties: {} } },
        { name: 'tool_b', description: 'missing handler', parameters: { type: 'object', properties: {} } },
      ],
    }, `export const handlers = { tool_a: async () => ({ result: 'ok' }) };`);

    logMessages.length = 0;
    const ctx = createMockContext();
    const registry = new ToolRegistry(ctx);
    await registry.initializeExternalSkills();

    // tool_a should be registered (tool_b has no handler but that's a non-env warning)
    const toolNames = ctx.tools.map(t => t.definition.function.name);
    expect(toolNames).toContain('handler-warn_tool_a');

    // Should log warning (not info/skip) for missing handler
    const warnLog = logMessages.find(
      m => m.level === 'warn' && m.data?.skillId === 'handler-warn',
    );
    expect(warnLog).toBeTruthy();
  });
});
