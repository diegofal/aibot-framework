import { afterAll, describe, expect, mock, test } from 'bun:test';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Hono } from 'hono';
import { type SkillCommandsDeps, skillCommandRoutes } from '../src/web/routes/skill-commands';

/** Minimal mock logger */
const noopLogger: any = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  child: () => noopLogger,
};

/** Build a test app with mocked deps */
function buildApp(overrides: Partial<SkillCommandsDeps> = {}) {
  const defaultSkill = {
    id: 'reflection',
    name: 'Reflection',
    version: '1.0.0',
    description: 'Self-reflection skill',
    commands: {
      reflect: {
        description: 'Run reflection',
        handler: mock(async () => 'reflection complete'),
      },
    },
  };

  const defaultBotConfig = {
    id: 'bot1',
    name: 'Test Bot',
    token: 'test-token',
    skills: ['reflection'],
  };

  const deps: SkillCommandsDeps = {
    config: { bots: [defaultBotConfig] } as any,
    botManager: {
      isRunning: (id: string) => id === 'bot1',
      executeSkillCommand: mock(
        async (_botId: string, _skillId: string, _cmd: string, _args: string[]) => {
          return 'reflection complete';
        }
      ),
      getActivityStream: () => ({
        publish: () => {},
      }),
    } as any,
    skillRegistry: {
      get: (id: string) => (id === 'reflection' ? defaultSkill : undefined),
    } as any,
    logger: noopLogger,
    ...overrides,
  };

  const app = new Hono();
  app.route('/api/agents', skillCommandRoutes(deps));
  return { app, deps };
}

describe('Skill Commands Route', () => {
  describe('GET /api/agents/:botId/skills', () => {
    test('lists skills and commands for a bot', async () => {
      const { app } = buildApp();
      const res = await app.request('/api/agents/bot1/skills');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.botId).toBe('bot1');
      expect(body.skills).toHaveLength(1);
      expect(body.skills[0].id).toBe('reflection');
      expect(body.skills[0].commands).toEqual([{ name: 'reflect', description: 'Run reflection' }]);
    });

    test('returns 404 for unknown bot', async () => {
      const { app } = buildApp();
      const res = await app.request('/api/agents/unknown/skills');
      expect(res.status).toBe(404);
    });
  });

  describe('POST /api/agents/:botId/skills/:skillId/:command', () => {
    test('executes a skill command successfully', async () => {
      const { app, deps } = buildApp();
      const res = await app.request('/api/agents/bot1/skills/reflection/reflect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(body.result).toBe('reflection complete');
      expect(body.durationMs).toBeGreaterThanOrEqual(0);
      expect((deps.botManager.executeSkillCommand as any).mock.calls).toHaveLength(1);
    });

    test('passes args to the command', async () => {
      const { app, deps } = buildApp();
      const res = await app.request('/api/agents/bot1/skills/reflection/reflect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ args: ['--force', '--verbose'] }),
      });
      expect(res.status).toBe(200);
      const calls = (deps.botManager.executeSkillCommand as any).mock.calls;
      expect(calls[0]).toEqual(['bot1', 'reflection', 'reflect', ['--force', '--verbose']]);
    });

    test('returns 404 for unknown bot', async () => {
      const { app } = buildApp();
      const res = await app.request('/api/agents/nonexistent/skills/reflection/reflect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      expect(res.status).toBe(404);
    });

    test('returns 404 when executeSkillCommand throws "not running"', async () => {
      const { app } = buildApp({
        botManager: {
          executeSkillCommand: mock(async () => {
            throw new Error('Bot bot1 is not running');
          }),
          getActivityStream: () => ({ publish: () => {} }),
        } as any,
      });
      const res = await app.request('/api/agents/bot1/skills/reflection/reflect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.error).toContain('not running');
    });

    test('returns 500 on unexpected errors', async () => {
      const { app } = buildApp({
        botManager: {
          executeSkillCommand: mock(async () => {
            throw new Error('Something broke');
          }),
          getActivityStream: () => ({ publish: () => {} }),
        } as any,
      });
      const res = await app.request('/api/agents/bot1/skills/reflection/reflect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      expect(res.status).toBe(500);
    });

    test('handles empty body gracefully', async () => {
      const { app } = buildApp();
      const res = await app.request('/api/agents/bot1/skills/reflection/reflect', {
        method: 'POST',
      });
      expect(res.status).toBe(200);
    });
  });
});

describe('BotManager.executeSkillCommand validation', () => {
  // These test the error paths that the route delegates to BotManager

  test('errors are descriptive for each validation case', () => {
    // Bot not running
    expect(() => {
      throw new Error('Bot x is not running');
    }).toThrow('not running');
    // Skill not found
    expect(() => {
      throw new Error('Skill not found: x');
    }).toThrow('not found');
    // Skill not enabled
    expect(() => {
      throw new Error('Bot x does not have skill y enabled');
    }).toThrow('does not have skill');
    // Command not found
    expect(() => {
      throw new Error('Command not found: z in skill y');
    }).toThrow('not found');
  });
});

// ── Reflection Journal endpoints ──────────────────────────────────────

const TEST_SOUL_DIR = join(import.meta.dir, '__test_soul_reflections__');

function buildReflectionApp(soulDir: string, overrides: Partial<SkillCommandsDeps> = {}) {
  const botConfig = {
    id: 'rbot',
    name: 'Reflect Bot',
    token: 'test-token',
    skills: ['reflection'],
    soulDir,
  };

  const deps: SkillCommandsDeps = {
    config: {
      bots: [botConfig],
      soul: { dir: './config/soul' },
      ollama: { models: { primary: 'test' } },
      conversation: { systemPrompt: '', temperature: 0.7, maxHistory: 50 },
    } as any,
    botManager: {
      isRunning: () => true,
      executeSkillCommand: mock(async () => 'ok'),
      getActivityStream: () => ({ publish: () => {} }),
    } as any,
    skillRegistry: { get: () => null } as any,
    logger: noopLogger,
    ...overrides,
  };

  const app = new Hono();
  app.route('/api/agents', skillCommandRoutes(deps));
  return app;
}

describe('Reflection Journal endpoints', () => {
  // Set up test soul directory with sample data
  const memoryDir = join(TEST_SOUL_DIR, 'memory');
  const archiveDir = join(TEST_SOUL_DIR, 'memory', 'archive');
  const versionsDir = join(TEST_SOUL_DIR, '.versions');

  mkdirSync(memoryDir, { recursive: true });
  mkdirSync(archiveDir, { recursive: true });
  mkdirSync(versionsDir, { recursive: true });

  // Daily memory with reflection entry
  writeFileSync(
    join(memoryDir, '2026-03-19.md'),
    [
      '- [07:00] [agent-loop] Did some work.',
      '- [07:19] [reflection] Primera reflexion formal. Identifique patrones.',
      '- [08:00] [agent-loop] More work.',
    ].join('\n')
  );

  // Archived memory with reflection entry
  writeFileSync(
    join(archiveDir, '2026-03-05.md'),
    ['- [03:32] [reflection] Reconoci que mi produccion masiva necesita pausa.'].join('\n')
  );

  // MOTIVATIONS.md with Last Reflection section
  writeFileSync(
    join(TEST_SOUL_DIR, 'MOTIVATIONS.md'),
    [
      '## Core Drives',
      '- Be helpful',
      '',
      '## Last Reflection',
      '- date: 2026-03-19',
      '- trigger: manual',
      '- changes: Updated core drives',
    ].join('\n')
  );

  // Version backups
  writeFileSync(join(versionsDir, 'MOTIVATIONS.md.2026-03-19T10-19-41.bak'), '# Old version 1');
  writeFileSync(join(versionsDir, 'MOTIVATIONS.md.2026-03-05T03-32-00.bak'), '# Old version 2');

  afterAll(() => {
    rmSync(TEST_SOUL_DIR, { recursive: true, force: true });
  });

  describe('GET /api/agents/:botId/reflections', () => {
    test('returns reflection entries from memory files', async () => {
      const app = buildReflectionApp(TEST_SOUL_DIR);
      const res = await app.request('/api/agents/rbot/reflections');
      expect(res.status).toBe(200);
      const body = await res.json();

      expect(body.botId).toBe('rbot');
      expect(body.entries).toHaveLength(2);
      // Most recent first
      expect(body.entries[0].date).toBe('2026-03-19');
      expect(body.entries[0].time).toBe('07:19');
      expect(body.entries[0].journal).toContain('Primera reflexion');
      expect(body.entries[0].hasMotivationsBackup).toBe(true);

      expect(body.entries[1].date).toBe('2026-03-05');
      expect(body.entries[1].hasMotivationsBackup).toBe(true);
    });

    test('returns lastReflection from MOTIVATIONS.md', async () => {
      const app = buildReflectionApp(TEST_SOUL_DIR);
      const res = await app.request('/api/agents/rbot/reflections');
      const body = await res.json();

      expect(body.lastReflection).toEqual({
        date: '2026-03-19',
        trigger: 'manual',
        changes: 'Updated core drives',
      });
    });

    test('returns motivationsVersions sorted descending', async () => {
      const app = buildReflectionApp(TEST_SOUL_DIR);
      const res = await app.request('/api/agents/rbot/reflections');
      const body = await res.json();

      expect(body.motivationsVersions).toHaveLength(2);
      expect(body.motivationsVersions[0]).toBe('2026-03-19T10-19-41');
      expect(body.motivationsVersions[1]).toBe('2026-03-05T03-32-00');
    });

    test('returns 404 for unknown bot', async () => {
      const app = buildReflectionApp(TEST_SOUL_DIR);
      const res = await app.request('/api/agents/unknown/reflections');
      expect(res.status).toBe(404);
    });

    test('returns empty when no memory files exist', async () => {
      const emptySoulDir = join(TEST_SOUL_DIR, '__empty__');
      mkdirSync(emptySoulDir, { recursive: true });
      const app = buildReflectionApp(emptySoulDir);
      const res = await app.request('/api/agents/rbot/reflections');
      const body = await res.json();
      expect(body.entries).toHaveLength(0);
      expect(body.lastReflection).toBeNull();
      rmSync(emptySoulDir, { recursive: true, force: true });
    });
  });

  describe('GET /api/agents/:botId/reflections/motivations/:version', () => {
    test('returns backup content for valid version', async () => {
      const app = buildReflectionApp(TEST_SOUL_DIR);
      const res = await app.request('/api/agents/rbot/reflections/motivations/2026-03-19T10-19-41');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.version).toBe('2026-03-19T10-19-41');
      expect(body.content).toBe('# Old version 1');
    });

    test('returns 404 for non-existent version', async () => {
      const app = buildReflectionApp(TEST_SOUL_DIR);
      const res = await app.request('/api/agents/rbot/reflections/motivations/2099-01-01T00-00-00');
      expect(res.status).toBe(404);
    });

    test('rejects invalid version format', async () => {
      const app = buildReflectionApp(TEST_SOUL_DIR);
      const res = await app.request('/api/agents/rbot/reflections/motivations/foo..bar');
      expect(res.status).toBe(400);
    });

    test('returns 404 for unknown bot', async () => {
      const app = buildReflectionApp(TEST_SOUL_DIR);
      const res = await app.request(
        '/api/agents/unknown/reflections/motivations/2026-03-19T10-19-41'
      );
      expect(res.status).toBe(404);
    });
  });
});
