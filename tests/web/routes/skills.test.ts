import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Hono } from 'hono';
import type { Config } from '../../../src/config';
import type { Logger } from '../../../src/logger';
import { skillsRoutes } from '../../../src/web/routes/skills';
import type { SkillsRouteDeps } from '../../../src/web/routes/skills';

const noopLogger: Logger = {
  info: () => {},
  warn: () => {},
  debug: () => {},
  error: () => {},
  child: () => noopLogger,
};

const TEST_DIR = join(process.cwd(), '.test-skills-routes');
const SKILLS_FOLDER = join(TEST_DIR, 'external-skills');

function makeSkillRegistry(skills: any[] = [], enabledIds: string[] = [], available?: any[]) {
  const enabledSet = new Set(enabledIds);
  return {
    getAll: () => skills,
    get: (id: string) => skills.find((s: any) => s.id === id),
    getContext: (id: string) => ({ config: {} }),
    getEnabledIds: () => enabledSet,
    listAvailable: async () =>
      available ??
      skills.map((s: any) => ({
        id: s.id,
        manifest: { id: s.id, name: s.name, version: s.version, description: s.description },
      })),
  };
}

function makeBotManager(externalSkills: any[] = []) {
  return {
    getExternalSkills: () => externalSkills,
  };
}

function makeConfig(overrides?: Partial<Config>): Config {
  return {
    skillsFolders: { paths: [SKILLS_FOLDER] },
    improve: { claudePath: 'claude', timeout: 30_000 },
    ...overrides,
  } as unknown as Config;
}

function makeApp(deps: Partial<SkillsRouteDeps> = {}) {
  const fullDeps: SkillsRouteDeps = {
    skillRegistry: makeSkillRegistry() as any,
    config: makeConfig(),
    configPath: join(TEST_DIR, 'config.json'),
    botManager: makeBotManager() as any,
    logger: noopLogger,
    ...deps,
  };
  const app = new Hono();
  app.route('/api/skills', skillsRoutes(fullDeps));
  return app;
}

function createExternalSkillOnDisk(id: string, manifest: object, handlerCode: string) {
  const dir = join(SKILLS_FOLDER, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'skill.json'), JSON.stringify(manifest, null, 2));
  writeFileSync(join(dir, 'index.ts'), handlerCode);
  return dir;
}

const sampleManifest = {
  id: 'test-skill',
  name: 'Test Skill',
  version: '1.0.0',
  description: 'A test skill',
  tools: [
    {
      name: 'test_tool',
      description: 'A test tool',
      parameters: { type: 'object', properties: {} },
    },
  ],
};

const sampleHandler = 'export const handlers = { test_tool: async () => ({ success: true }) };';

describe('skills routes', () => {
  beforeEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(SKILLS_FOLDER, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  describe('GET /', () => {
    test('returns merged built-in + external list with enabled field', async () => {
      const builtInSkills = [
        {
          id: 'calibrate',
          name: 'Soul Calibration',
          version: '1.0.0',
          description: 'Calibrate',
          commands: { calibrate: {} },
          jobs: [],
        },
      ];
      const externalSkills = [
        {
          manifest: {
            id: 'github',
            name: 'GitHub',
            version: '2.0.0',
            description: 'GitHub integration',
            tools: [{ name: 't1' }, { name: 't2' }],
          },
          dir: '/some/dir',
          warnings: [],
        },
      ];

      const app = makeApp({
        skillRegistry: makeSkillRegistry(builtInSkills, ['calibrate']) as any,
        botManager: makeBotManager(externalSkills) as any,
      });

      const res = await app.request('http://localhost/api/skills');
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.length).toBe(2);

      const builtin = data.find((s: any) => s.id === 'calibrate');
      expect(builtin.type).toBe('builtin');
      expect(builtin.enabled).toBe(true);
      expect(builtin.commands).toEqual(['calibrate']);

      const ext = data.find((s: any) => s.id === 'github');
      expect(ext.type).toBe('external');
      expect(ext.toolCount).toBe(2);
    });

    test('returns disabled built-in skills from listAvailable', async () => {
      // No loaded skills, but available via manifest
      const available = [
        {
          id: 'twitter',
          manifest: {
            id: 'twitter',
            name: 'Twitter',
            version: '1.0.0',
            description: 'Twitter integration',
          },
        },
      ];

      const app = makeApp({
        skillRegistry: makeSkillRegistry([], [], available) as any,
      });

      const res = await app.request('http://localhost/api/skills');
      const data = await res.json();
      expect(data.length).toBe(1);

      const twitter = data.find((s: any) => s.id === 'twitter');
      expect(twitter.type).toBe('builtin');
      expect(twitter.enabled).toBe(false);
      expect(twitter.name).toBe('Twitter');
    });

    test('returns external skills with botName', async () => {
      const externalSkills = [
        {
          manifest: {
            id: 'daily-digest',
            name: 'Daily Digest',
            version: '1.0.0',
            tools: [{ name: 'digest' }],
          },
          dir: '/prod/mybot/src/skills/daily-digest',
          warnings: [],
          botName: 'mybot',
        },
      ];

      const app = makeApp({
        botManager: makeBotManager(externalSkills) as any,
      });

      const res = await app.request('http://localhost/api/skills');
      const data = await res.json();
      const ext = data.find((s: any) => s.id === 'daily-digest');
      expect(ext.botName).toBe('mybot');
    });

    test('returns empty array when no skills', async () => {
      const app = makeApp();
      const res = await app.request('http://localhost/api/skills');
      const data = await res.json();
      expect(data).toEqual([]);
    });

    test('deduplicates skills that appear as both builtin and external', async () => {
      const builtInSkills = [
        { id: 'calendar', name: 'Calendar', version: '1.0.0', description: 'Calendar skill' },
      ];
      const externalSkills = [
        {
          manifest: {
            id: 'calendar',
            name: 'Calendar',
            version: '1.0.0',
            description: 'Calendar skill',
            tools: [{ name: 'calendar_list' }],
          },
          dir: '/some/dir',
          warnings: [],
        },
        {
          manifest: {
            id: 'unique-ext',
            name: 'Unique External',
            version: '1.0.0',
            description: 'Only external',
            tools: [{ name: 'ext_tool' }],
          },
          dir: '/other/dir',
          warnings: [],
        },
      ];

      const app = makeApp({
        skillRegistry: makeSkillRegistry(builtInSkills, ['calendar']) as any,
        botManager: makeBotManager(externalSkills) as any,
      });

      const res = await app.request('http://localhost/api/skills');
      const data = await res.json();
      const calendarEntries = data.filter((s: any) => s.id === 'calendar');
      expect(calendarEntries.length).toBe(1);
      expect(calendarEntries[0].type).toBe('builtin');

      const uniqueExt = data.find((s: any) => s.id === 'unique-ext');
      expect(uniqueExt).toBeDefined();
      expect(uniqueExt.type).toBe('external');

      expect(data.length).toBe(2);
    });

    test('deduplicates external skills with same ID from different dirs', async () => {
      const externalSkills = [
        {
          manifest: { id: 'reddit', name: 'Reddit', version: '1.0.0', tools: [{ name: 'r1' }] },
          dir: '/dir1',
          warnings: [],
        },
        {
          manifest: { id: 'reddit', name: 'Reddit', version: '1.0.0', tools: [{ name: 'r1' }] },
          dir: '/dir2',
          warnings: [],
          botName: 'bot2',
        },
      ];

      const app = makeApp({
        botManager: makeBotManager(externalSkills) as any,
      });

      const res = await app.request('http://localhost/api/skills');
      const data = await res.json();
      const redditEntries = data.filter((s: any) => s.id === 'reddit');
      expect(redditEntries.length).toBe(1);
    });
  });

  describe('GET /:id', () => {
    test('returns built-in skill detail', async () => {
      const skills = [
        {
          id: 'calibrate',
          name: 'Soul Calibration',
          version: '1.0.0',
          description: 'Calibrate',
          commands: { start: {} },
          jobs: [{ id: 'j1', schedule: '0 0 * * *' }],
          onMessage: null,
        },
      ];
      const app = makeApp({ skillRegistry: makeSkillRegistry(skills, ['calibrate']) as any });

      const res = await app.request('http://localhost/api/skills/calibrate');
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.type).toBe('builtin');
      expect(data.commands).toEqual(['start']);
      expect(data.jobs.length).toBe(1);
    });

    test('returns external skill detail', async () => {
      const extSkills = [
        {
          manifest: {
            id: 'github',
            name: 'GitHub',
            version: '2.0.0',
            description: 'GitHub tools',
            tools: [
              {
                name: 'repo_list',
                description: 'List repos',
                parameters: { type: 'object', properties: {} },
              },
            ],
            requires: { bins: ['gh'] },
            config: { token: 'xxx' },
          },
          dir: '/some/dir',
          warnings: ['Missing binary: gh'],
        },
      ];
      const app = makeApp({ botManager: makeBotManager(extSkills) as any });

      const res = await app.request('http://localhost/api/skills/github');
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.type).toBe('external');
      expect(data.tools.length).toBe(1);
      expect(data.warnings).toEqual(['Missing binary: gh']);
      expect(data.requires.bins).toEqual(['gh']);
    });

    test('returns 404 for unknown skill', async () => {
      const app = makeApp();
      const res = await app.request('http://localhost/api/skills/nonexistent');
      expect(res.status).toBe(404);
    });
  });

  describe('GET /:id/source', () => {
    test('returns handler code for external skill', async () => {
      const dir = createExternalSkillOnDisk('my-skill', sampleManifest, sampleHandler);
      const extSkills = [{ manifest: { ...sampleManifest }, dir, warnings: [] }];
      const app = makeApp({ botManager: makeBotManager(extSkills) as any });

      const res = await app.request('http://localhost/api/skills/test-skill/source');
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.source).toContain('handlers');
    });

    test('returns 404 for built-in skill', async () => {
      const app = makeApp();
      const res = await app.request('http://localhost/api/skills/nonexistent/source');
      expect(res.status).toBe(404);
    });
  });

  describe('POST /', () => {
    test('creates skill dir and files', async () => {
      const app = makeApp();

      const res = await app.request('http://localhost/api/skills', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: 'new-skill',
          targetFolder: SKILLS_FOLDER,
          skillJson: sampleManifest,
          handlerCode: sampleHandler,
        }),
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.ok).toBe(true);

      const skillDir = join(SKILLS_FOLDER, 'new-skill');
      expect(existsSync(join(skillDir, 'skill.json'))).toBe(true);
      expect(existsSync(join(skillDir, 'index.ts'))).toBe(true);

      const manifest = JSON.parse(readFileSync(join(skillDir, 'skill.json'), 'utf-8'));
      expect(manifest.id).toBe('test-skill');
    });

    test('rejects folder not in skillsFolders', async () => {
      const app = makeApp();

      const res = await app.request('http://localhost/api/skills', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: 'bad-skill',
          targetFolder: '/tmp/unauthorized',
          skillJson: sampleManifest,
          handlerCode: sampleHandler,
        }),
      });

      expect(res.status).toBe(403);
    });

    test('rejects missing fields', async () => {
      const app = makeApp();

      const res = await app.request('http://localhost/api/skills', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: 'x' }),
      });

      expect(res.status).toBe(400);
    });

    test('rejects if directory already exists', async () => {
      createExternalSkillOnDisk('existing-skill', sampleManifest, sampleHandler);

      const app = makeApp();
      const res = await app.request('http://localhost/api/skills', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: 'existing-skill',
          targetFolder: SKILLS_FOLDER,
          skillJson: sampleManifest,
          handlerCode: sampleHandler,
        }),
      });

      expect(res.status).toBe(409);
    });
  });

  describe('PUT /:id', () => {
    test('updates external skill files', async () => {
      const dir = createExternalSkillOnDisk('updatable', sampleManifest, sampleHandler);
      const extSkills = [{ manifest: { ...sampleManifest, id: 'updatable' }, dir, warnings: [] }];
      const app = makeApp({ botManager: makeBotManager(extSkills) as any });

      const updatedManifest = { ...sampleManifest, name: 'Updated Skill' };
      const updatedHandler =
        'export const handlers = { test_tool: async () => ({ success: false }) };';

      const res = await app.request('http://localhost/api/skills/updatable', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ skillJson: updatedManifest, handlerCode: updatedHandler }),
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.ok).toBe(true);

      const saved = JSON.parse(readFileSync(join(dir, 'skill.json'), 'utf-8'));
      expect(saved.name).toBe('Updated Skill');
      expect(readFileSync(join(dir, 'index.ts'), 'utf-8')).toContain('success: false');
    });

    test('rejects built-in skill update', async () => {
      const skills = [{ id: 'calibrate', name: 'Calibrate', version: '1.0.0' }];
      const app = makeApp({ skillRegistry: makeSkillRegistry(skills) as any });

      const res = await app.request('http://localhost/api/skills/calibrate', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ skillJson: {} }),
      });

      expect(res.status).toBe(403);
    });

    test('returns 404 for unknown external skill', async () => {
      const app = makeApp();

      const res = await app.request('http://localhost/api/skills/nonexistent', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ skillJson: {} }),
      });

      expect(res.status).toBe(404);
    });
  });

  describe('DELETE /:id', () => {
    test('removes external skill directory', async () => {
      const dir = createExternalSkillOnDisk('deletable', sampleManifest, sampleHandler);
      const extSkills = [{ manifest: { ...sampleManifest, id: 'deletable' }, dir, warnings: [] }];
      const app = makeApp({ botManager: makeBotManager(extSkills) as any });

      expect(existsSync(dir)).toBe(true);

      const res = await app.request('http://localhost/api/skills/deletable', {
        method: 'DELETE',
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.ok).toBe(true);
      expect(existsSync(dir)).toBe(false);
    });

    test('rejects built-in skill delete', async () => {
      const skills = [{ id: 'calibrate', name: 'Calibrate' }];
      const app = makeApp({ skillRegistry: makeSkillRegistry(skills) as any });

      const res = await app.request('http://localhost/api/skills/calibrate', {
        method: 'DELETE',
      });

      expect(res.status).toBe(403);
    });

    test('returns 404 for unknown skill', async () => {
      const app = makeApp();

      const res = await app.request('http://localhost/api/skills/nonexistent', {
        method: 'DELETE',
      });

      expect(res.status).toBe(404);
    });

    test('rejects delete when dir is outside skillsFolders', async () => {
      const outsideDir = join(TEST_DIR, 'outside', 'rogue-skill');
      mkdirSync(outsideDir, { recursive: true });
      writeFileSync(join(outsideDir, 'skill.json'), JSON.stringify(sampleManifest));
      writeFileSync(join(outsideDir, 'index.ts'), sampleHandler);

      const extSkills = [
        { manifest: { ...sampleManifest, id: 'rogue' }, dir: outsideDir, warnings: [] },
      ];
      const app = makeApp({ botManager: makeBotManager(extSkills) as any });

      const res = await app.request('http://localhost/api/skills/rogue', {
        method: 'DELETE',
      });

      expect(res.status).toBe(403);
      // Directory should still exist
      expect(existsSync(outsideDir)).toBe(true);
    });
  });

  describe('POST /generate/apply', () => {
    test('writes generated files to disk', async () => {
      const app = makeApp();

      const res = await app.request('http://localhost/api/skills/generate/apply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: 'gen-skill',
          targetFolder: SKILLS_FOLDER,
          skillJson: sampleManifest,
          handlerCode: sampleHandler,
        }),
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.ok).toBe(true);

      const dir = join(SKILLS_FOLDER, 'gen-skill');
      expect(existsSync(join(dir, 'skill.json'))).toBe(true);
      expect(existsSync(join(dir, 'index.ts'))).toBe(true);
    });

    test('rejects unauthorized folder', async () => {
      const app = makeApp();

      const res = await app.request('http://localhost/api/skills/generate/apply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: 'gen-skill',
          targetFolder: '/tmp/unauthorized',
          skillJson: sampleManifest,
          handlerCode: sampleHandler,
        }),
      });

      expect(res.status).toBe(403);
    });
  });
});

describe('POST /api/skills/toggle', () => {
  const builtins = [
    { id: 'reminders', name: 'Reminders' },
    { id: 'calendar', name: 'Calendar' },
    { id: 'reddit', name: 'Reddit' },
  ];
  const configPath = join(TEST_DIR, 'config.json');

  function setup(enabled: string[], opts: { tenantId?: string; configPath?: string } = {}) {
    const config = makeConfig({
      skills: { enabled: [...enabled], config: {} },
    } as unknown as Partial<Config>);
    const app = new Hono();
    if (opts.tenantId) {
      app.use('*', async (c, next) => {
        c.set('tenant' as never, { tenantId: opts.tenantId } as never);
        return next();
      });
    }
    app.route(
      '/api/skills',
      skillsRoutes({
        skillRegistry: makeSkillRegistry(builtins, enabled) as any,
        config,
        configPath: opts.configPath ?? configPath,
        botManager: makeBotManager() as any,
        logger: noopLogger,
      })
    );
    return { app, config };
  }

  const post = (app: Hono, body: unknown) =>
    app.request('/api/skills/toggle', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

  const onDisk = () => JSON.parse(readFileSync(configPath, 'utf-8'));

  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
    writeFileSync(
      configPath,
      JSON.stringify({ ollama: { model: 'm' }, skills: { enabled: ['reminders'], config: {} } })
    );
  });
  afterEach(() => rmSync(TEST_DIR, { recursive: true, force: true }));

  test('enables several skills at once, in memory and in config.json', async () => {
    const { app, config } = setup(['reminders']);
    const res = await post(app, { ids: ['calendar', 'reddit'], enabled: true });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.enabled).toEqual(['reminders', 'calendar', 'reddit']);
    expect(body.results).toEqual([
      { id: 'calendar', ok: true },
      { id: 'reddit', ok: true },
    ]);
    expect(body.restartRequired).toBe(true);
    expect(config.skills.enabled).toEqual(['reminders', 'calendar', 'reddit']);
    expect(onDisk().skills.enabled).toEqual(['reminders', 'calendar', 'reddit']);
    expect(onDisk().ollama).toEqual({ model: 'm' });
  });

  test('disables skills', async () => {
    const { app, config } = setup(['reminders', 'calendar']);
    const body = await (await post(app, { ids: ['reminders'], enabled: false })).json();
    expect(body.enabled).toEqual(['calendar']);
    expect(config.skills.enabled).toEqual(['calendar']);
    expect(onDisk().skills.enabled).toEqual(['calendar']);
  });

  test('is idempotent: enabling an enabled skill adds no duplicate and reports no restart', async () => {
    const { app, config } = setup(['reminders']);
    const body = await (await post(app, { ids: ['reminders'], enabled: true })).json();
    expect(body.results).toEqual([{ id: 'reminders', ok: true }]);
    expect(body.restartRequired).toBe(false);
    expect(config.skills.enabled).toEqual(['reminders']);
  });

  test('fails only the unknown ids and applies the rest', async () => {
    const { app, config } = setup([]);
    const body = await (await post(app, { ids: ['calendar', 'nope'], enabled: true })).json();
    expect(body.results).toEqual([
      { id: 'calendar', ok: true },
      { id: 'nope', ok: false, error: 'Unknown built-in skill' },
    ]);
    expect(config.skills.enabled).toEqual(['calendar']);
  });

  test('rejects a malformed body with 400', async () => {
    const { app } = setup([]);
    expect((await post(app, { ids: [], enabled: true })).status).toBe(400);
    expect((await post(app, { ids: 'calendar', enabled: true })).status).toBe(400);
    expect((await post(app, { ids: ['calendar'] })).status).toBe(400);
    expect((await post(app, { ids: [1], enabled: true })).status).toBe(400);
    expect(
      (await post(app, { ids: Array.from({ length: 101 }, (_, i) => `s${i}`), enabled: true }))
        .status
    ).toBe(400);
  });

  test('is admin-only in multi-tenant mode', async () => {
    const { app, config } = setup([], { tenantId: 't1' });
    const res = await post(app, { ids: ['calendar'], enabled: true });
    expect(res.status).toBe(403);
    expect(config.skills.enabled).toEqual([]);
  });

  test('leaves memory untouched when config.json cannot be written', async () => {
    const { app, config } = setup(['reminders'], {
      configPath: join(TEST_DIR, 'missing-dir', 'config.json'),
    });
    const res = await post(app, { ids: ['calendar'], enabled: true });
    expect(res.status).toBe(500);
    expect(config.skills.enabled).toEqual(['reminders']);
  });
});
