import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { existsSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Hono } from 'hono';
import { skillsRoutes } from '../../../src/web/routes/skills';
import type { SkillsRouteDeps } from '../../../src/web/routes/skills';
import type { Config } from '../../../src/config';
import type { Logger } from '../../../src/logger';

const noopLogger: Logger = {
  info: () => {},
  warn: () => {},
  debug: () => {},
  error: () => {},
  child: () => noopLogger,
};

const TEST_DIR = join(process.cwd(), '.test-skills-routes');
const SKILLS_FOLDER = join(TEST_DIR, 'external-skills');

function makeSkillRegistry(skills: any[] = []) {
  return {
    getAll: () => skills,
    getContext: (id: string) => ({ config: {} }),
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
  tools: [{ name: 'test_tool', description: 'A test tool', parameters: { type: 'object', properties: {} } }],
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
    test('returns merged built-in + external list', async () => {
      const builtInSkills = [
        { id: 'calibrate', name: 'Soul Calibration', version: '1.0.0', description: 'Calibrate', commands: { calibrate: {} }, jobs: [] },
      ];
      const externalSkills = [
        { manifest: { id: 'github', name: 'GitHub', version: '2.0.0', description: 'GitHub integration', tools: [{ name: 't1' }, { name: 't2' }] }, dir: '/some/dir', warnings: [] },
      ];

      const app = makeApp({
        skillRegistry: makeSkillRegistry(builtInSkills) as any,
        botManager: makeBotManager(externalSkills) as any,
      });

      const res = await app.request('http://localhost/api/skills');
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.length).toBe(2);

      const builtin = data.find((s: any) => s.id === 'calibrate');
      expect(builtin.type).toBe('builtin');
      expect(builtin.commands).toEqual(['calibrate']);

      const ext = data.find((s: any) => s.id === 'github');
      expect(ext.type).toBe('external');
      expect(ext.toolCount).toBe(2);
    });

    test('returns empty array when no skills', async () => {
      const app = makeApp();
      const res = await app.request('http://localhost/api/skills');
      const data = await res.json();
      expect(data).toEqual([]);
    });
  });

  describe('GET /:id', () => {
    test('returns built-in skill detail', async () => {
      const skills = [
        { id: 'calibrate', name: 'Soul Calibration', version: '1.0.0', description: 'Calibrate', commands: { start: {} }, jobs: [{ id: 'j1', schedule: '0 0 * * *' }], onMessage: null },
      ];
      const app = makeApp({ skillRegistry: makeSkillRegistry(skills) as any });

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
            tools: [{ name: 'repo_list', description: 'List repos', parameters: { type: 'object', properties: {} } }],
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
      const updatedHandler = 'export const handlers = { test_tool: async () => ({ success: false }) };';

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

      const extSkills = [{ manifest: { ...sampleManifest, id: 'rogue' }, dir: outsideDir, warnings: [] }];
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
