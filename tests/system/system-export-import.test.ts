import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ConflictError } from '../../src/bot/bot-export-service';
import {
  buildEffectiveConfig,
  readRawBots,
  readRawConfig,
} from '../../src/system/effective-config';
import { SystemExportService } from '../../src/system/system-export-service';
import { SystemImportService, VersionMismatchError } from '../../src/system/system-import-service';
import { packTarGz, unpackTarGz } from '../../src/system/tar-archive';

const TEST_DIR = join(import.meta.dir, '..', '..', '.test-system-export');
const SOURCE = join(TEST_DIR, 'source');
const TARGET = join(TEST_DIR, 'target');
const SOURCE_CONFIG = join(SOURCE, 'config', 'config.json');
const TARGET_CONFIG = join(TARGET, 'config', 'config.json');

/** Fake credentials — none of these may appear anywhere in a bundle. */
const FAKE = {
  telegramA: '111111111:AAHfakeTokenAlphaABCDEFGHIJKLMNOPQRS',
  telegramB: '222222222:AAHfakeTokenBetaABCDEFGHIJKLMNOPQRST',
  brave: 'BSAfakeBraveSearchKeyValue1234',
  ollama: 'fake-ollama-cloud-key-0987654321',
  openai: 'sk-fakeOpenAiKeyValue1234567890abcd',
  whatsapp: 'EAAfakeWhatsAppAccessTokenValue123',
};

function createMockLogger() {
  const logger: any = {
    info: mock(() => {}),
    warn: mock(() => {}),
    error: mock(() => {}),
    debug: mock(() => {}),
    child: () => logger,
  };
  return logger;
}

const SOURCE_CONFIG_JSON = {
  startup: { autoStartBots: true },
  ollama: {
    baseUrl: 'http://192.168.7.7:11434',
    apiKey: FAKE.ollama,
    models: { primary: 'kimi-k2.6:cloud', fallbacks: ['gpt-oss:120b-cloud'] },
  },
  conversation: { systemPrompt: 'You are helpful.', temperature: 0.7, maxHistory: 20 },
  webTools: { enabled: true, search: { apiKey: FAKE.brave, maxResults: 5 } },
  media: { enabled: true, whisper: { endpoint: 'https://api.openai.com', apiKey: FAKE.openai } },
  improve: { enabled: true, claudePath: 'C:\\Users\\User\\claude.exe' },
  soul: { dir: './config/soul', search: { enabled: true, dbPath: './data/memory.db' } },
  cron: { enabled: true, storePath: './data/cron' },
  session: { enabled: true, dataDir: './data/sessions' },
  dynamicTools: { enabled: true, storePath: './data/tools' },
  karma: { enabled: true, baseDir: './data/karma' },
  productions: { enabled: true, baseDir: './productions' },
  multiTenant: { enabled: false, dataDir: './data/tenants' },
  web: { enabled: true, port: 4321, host: '0.0.0.0' },
  logging: { level: 'info', file: '/var/log/aibot.log' },
  paths: { data: './data', logs: './data/logs', skills: './src/skills' },
  skills: { enabled: ['example'], config: {} },
};

const SOURCE_BOTS = [
  {
    id: 'coach',
    name: 'Coach',
    token: FAKE.telegramA,
    enabled: true,
    skills: ['example'],
    whatsapp: { phoneNumberId: '5551234', accessToken: FAKE.whatsapp },
  },
  {
    id: 'helper',
    name: 'Helper',
    token: FAKE.telegramB,
    enabled: true,
    skills: [],
    // A relative soul directory whose name contains spaces: this is real on the
    // author's instance and is the classic Windows -> Linux breakage.
    soulDir: './config/soul/Improve my life',
  },
];

function writeFile(path: string, content: string) {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, content, 'utf-8');
}

function buildSourceInstance() {
  writeFile(SOURCE_CONFIG, JSON.stringify(SOURCE_CONFIG_JSON, null, 2));
  writeFile(join(SOURCE, 'config', 'bots.json'), JSON.stringify(SOURCE_BOTS, null, 2));

  // "coach" uses the default soul location under the tenant tree.
  const coachSoul = join(SOURCE, 'data', 'tenants', '__admin__', 'bots', 'coach', 'soul');
  writeFile(join(coachSoul, 'IDENTITY.md'), 'name: Coach\n');
  writeFile(join(coachSoul, 'SOUL.md'), '# Coach soul');
  writeFile(join(coachSoul, 'memory', '2026-08-01.md'), '# Daily log');
  writeFile(join(coachSoul, '.versions', 'SOUL.md.1'), 'old version');

  const helperSoul = join(SOURCE, 'config', 'soul', 'Improve my life');
  writeFile(join(helperSoul, 'IDENTITY.md'), 'name: Helper\n');
  writeFile(join(helperSoul, 'notes', 'plan.md'), '# Plan');

  writeFile(join(SOURCE, 'data', 'cron', 'jobs.json'), '[{"id":"j1","schedule":"0 * * * *"}]');
  writeFile(join(SOURCE, 'data', 'sessions', 'sessions.json'), '{"chat-1":{"messages":[]}}');
  writeFile(join(SOURCE, 'data', 'tools', 'my-tool.json'), '{"name":"my_tool"}');
  writeFile(join(SOURCE, 'data', 'karma', 'coach', 'scores.json'), '{"u1":50}');
  writeFile(join(SOURCE, 'productions', 'coach', 'article.md'), '# Article');

  // Deliberately excluded artifacts.
  writeFile(join(SOURCE, 'data', 'memory.db'), 'SQLITE-INDEX');
  writeFile(join(SOURCE, 'data', 'logs', 'aibot.log'), `token leaked here: ${FAKE.telegramA}`);
}

function sourceService(logger = createMockLogger()) {
  return new SystemExportService({
    config: buildEffectiveConfig(readRawConfig(SOURCE_CONFIG), readRawBots(SOURCE_CONFIG), SOURCE),
    configPath: SOURCE_CONFIG,
    logger,
    rootDir: SOURCE,
    frameworkVersion: '1.0.0-test',
  });
}

function targetService(overrides: Record<string, unknown> = {}) {
  return new SystemImportService({
    targetRoot: TARGET,
    configPath: TARGET_CONFIG,
    logger: createMockLogger(),
    ...overrides,
  });
}

function bundleText(buffer: Buffer): string {
  const { files } = unpackTarGz(buffer);
  return [...files.values()].map((data) => data.toString('utf-8')).join('\n');
}

describe('system export', () => {
  beforeEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
    buildSourceInstance();
    mkdirSync(TARGET, { recursive: true });
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('produces a bundle with the expected shape', async () => {
    const { buffer, manifest } = await sourceService().export({ productions: true });
    const { files } = unpackTarGz(buffer);

    expect(files.has('manifest.json')).toBe(true);
    expect(files.has('REQUIRED_ENV.txt')).toBe(true);
    expect(files.has('config/config.json')).toBe(true);
    expect(files.has('config/bots.json')).toBe(true);
    expect(files.has('agents/coach/manifest.json')).toBe(true);
    expect(files.has('agents/coach/soul/IDENTITY.md')).toBe(true);
    expect(files.has('agents/coach/soul/memory/2026-08-01.md')).toBe(true);
    expect(files.has('agents/coach/productions/article.md')).toBe(true);
    expect(files.has('agents/helper/soul/notes/plan.md')).toBe(true);
    expect(files.has('data/cron/jobs.json')).toBe(true);
    expect(files.has('data/sessions/sessions.json')).toBe(true);
    expect(files.has('data/tools/my-tool.json')).toBe(true);

    expect(manifest.kind).toBe('aibot-system-export');
    expect(manifest.version).toBe(1);
    expect(manifest.agentExportVersion).toBe(1);
    expect(manifest.frameworkVersion).toBe('1.0.0-test');
    expect(manifest.source.platform).toBe(process.platform);
    expect(manifest.inventory.agents.map((agent) => agent.id).sort()).toEqual(['coach', 'helper']);
    expect(new Date(manifest.exportedAt).toString()).not.toBe('Invalid Date');
  });

  it('contains no secret value anywhere', async () => {
    const { buffer } = await sourceService().export({ productions: true });
    const text = bundleText(buffer);

    for (const [name, value] of Object.entries(FAKE)) {
      expect(`${name}:${text.includes(value)}`).toBe(`${name}:false`);
    }
  });

  it('emits ${VAR} placeholders and a REQUIRED_ENV listing', async () => {
    const { buffer, manifest } = await sourceService().export();
    const { files } = unpackTarGz(buffer);
    const config = JSON.parse(files.get('config/config.json')?.toString('utf-8') ?? '{}');

    expect(config.ollama.apiKey).toBe('${OLLAMA_API_KEY}');
    expect(config.ollama.baseUrl).toBe('${OLLAMA_BASE_URL}');
    expect(config.webTools.search.apiKey).toBe('${BRAVE_SEARCH_API_KEY}');

    const requiredEnv = files.get('REQUIRED_ENV.txt')?.toString('utf-8') ?? '';
    expect(requiredEnv).toContain('OLLAMA_API_KEY');
    expect(requiredEnv).toContain('BRAVE_SEARCH_API_KEY');
    expect(requiredEnv).toContain('AIBOT_BOT_COACH_WHATSAPP_TOKEN');
    expect(manifest.security.requiredEnv.map((entry) => entry.variable)).toContain(
      'OLLAMA_API_KEY'
    );
  });

  it('excludes the vector index, logs and soul version history', async () => {
    const { buffer, manifest } = await sourceService().export();
    const { files } = unpackTarGz(buffer);
    const paths = [...files.keys()];

    expect(paths.some((path) => path.includes('memory.db'))).toBe(false);
    expect(paths.some((path) => path.includes('/logs/'))).toBe(false);
    expect(paths.some((path) => path.includes('.versions'))).toBe(false);
    expect(manifest.inventory.excluded.some((note) => note.path === 'data/memory.db')).toBe(true);
  });

  it('includes productions by default and omits them when opted out', async () => {
    const included = unpackTarGz((await sourceService().export()).buffer);
    expect(included.files.has('agents/coach/productions/article.md')).toBe(true);

    const excluded = unpackTarGz((await sourceService().export({ productions: false })).buffer);
    expect(excluded.files.has('agents/coach/productions/article.md')).toBe(false);
  });

  it('uses only POSIX separators so a Windows export restores on Linux', async () => {
    const { buffer } = await sourceService().export({ productions: true });
    for (const path of unpackTarGz(buffer).files.keys()) {
      expect(path).not.toContain('\\');
      expect(path).not.toMatch(/^[a-zA-Z]:/);
    }
    // A directory name containing spaces survives the round-trip verbatim.
    expect(unpackTarGz(buffer).files.has('agents/helper/soul/notes/plan.md')).toBe(true);
  });

  it('checksums every file except the manifest', async () => {
    const { buffer, manifest } = await sourceService().export();
    const { files } = unpackTarGz(buffer);

    for (const path of files.keys()) {
      if (path === 'manifest.json') continue;
      expect(manifest.checksums[path]).toMatch(/^[a-f0-9]{64}$/);
    }
    expect(manifest.checksums['manifest.json']).toBeUndefined();
  });

  it('restricts the agents section when ids are given', async () => {
    const { buffer, manifest } = await sourceService().export({ agentIds: ['helper'] });
    const { files } = unpackTarGz(buffer);

    expect(manifest.inventory.agents.map((agent) => agent.id)).toEqual(['helper']);
    expect(files.has('agents/coach/manifest.json')).toBe(false);
    expect(JSON.parse(files.get('config/bots.json')?.toString('utf-8') ?? '[]')).toHaveLength(1);
  });

  it('exports only the requested sections', async () => {
    const { buffer, manifest } = await sourceService().export({ sections: ['config'] });
    const { files } = unpackTarGz(buffer);

    expect(manifest.sections).toEqual(['config']);
    expect(files.has('config/config.json')).toBe(true);
    expect(files.has('config/bots.json')).toBe(false);
    expect([...files.keys()].some((path) => path.startsWith('agents/'))).toBe(false);
    expect([...files.keys()].some((path) => path.startsWith('data/'))).toBe(false);
  });

  it('scrubs a credential pasted into a soul file', async () => {
    writeFile(
      join(SOURCE, 'data', 'tenants', '__admin__', 'bots', 'coach', 'soul', 'memory', 'leak.md'),
      `The user shared their bot token: ${FAKE.telegramA}`
    );

    const { buffer, manifest } = await sourceService().export();
    const { files } = unpackTarGz(buffer);
    const leaked = files.get('agents/coach/soul/memory/leak.md')?.toString('utf-8') ?? '';

    expect(leaked).not.toContain(FAKE.telegramA);
    expect(leaked).toContain('[REDACTED:telegram-bot-token]');
    expect(manifest.security.scrubbedFiles).toContain('agents/coach/soul/memory/leak.md');
  });
});

describe('system import', () => {
  beforeEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
    buildSourceInstance();
    mkdirSync(TARGET, { recursive: true });
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('round-trips an instance into a clean target', async () => {
    const { buffer } = await sourceService().export({ productions: true });
    const result = await targetService().import(buffer);

    expect(result.dryRun).toBe(false);
    expect(result.agents.map((agent) => agent.botId).sort()).toEqual(['coach', 'helper']);

    const config = JSON.parse(readFileSync(TARGET_CONFIG, 'utf-8'));
    expect(config.ollama.models.primary).toBe('kimi-k2.6:cloud');
    expect(config.ollama.apiKey).toBe('${OLLAMA_API_KEY}');

    const bots = JSON.parse(readFileSync(join(TARGET, 'config', 'bots.json'), 'utf-8'));
    expect(bots).toHaveLength(2);

    expect(readFileSync(join(TARGET, 'config', 'soul', 'coach', 'IDENTITY.md'), 'utf-8')).toBe(
      'name: Coach\n'
    );
    expect(existsSync(join(TARGET, 'config', 'soul', 'coach', 'memory', '2026-08-01.md'))).toBe(
      true
    );
    expect(
      readFileSync(join(TARGET, 'config', 'soul', 'helper', 'notes', 'plan.md'), 'utf-8')
    ).toBe('# Plan');

    expect(readFileSync(join(TARGET, 'data', 'cron', 'jobs.json'), 'utf-8')).toContain('j1');
    expect(existsSync(join(TARGET, 'data', 'sessions', 'sessions.json'))).toBe(true);
    expect(existsSync(join(TARGET, 'data', 'tools', 'my-tool.json'))).toBe(true);
    expect(readFileSync(join(TARGET, 'productions', 'coach', 'article.md'), 'utf-8')).toBe(
      '# Article'
    );
  });

  it('leaves no directory override pointing away from the restored files', async () => {
    const { buffer } = await sourceService().export();
    await targetService().import(buffer);

    const bots = JSON.parse(readFileSync(join(TARGET, 'config', 'bots.json'), 'utf-8'));
    const helper = bots.find((bot: { id: string }) => bot.id === 'helper');

    // The source pointed this bot at "./config/soul/Improve my life"; the soul
    // is restored to the framework's per-bot location, so the stale override
    // must not survive or the agent would read an empty soul.
    expect(helper.soulDir).toBeUndefined();
    expect(existsSync(join(TARGET, 'config', 'soul', 'helper', 'IDENTITY.md'))).toBe(true);
  });

  it('lands every imported bot disabled and tokenless', async () => {
    const { buffer } = await sourceService().export();
    await targetService().import(buffer);

    const bots = JSON.parse(readFileSync(join(TARGET, 'config', 'bots.json'), 'utf-8'));
    for (const bot of bots) {
      expect(bot.token).toBe('');
      expect(bot.enabled).toBe(false);
    }
  });

  it('refuses to clobber an existing instance without overwrite', async () => {
    const { buffer } = await sourceService().export();
    await targetService().import(buffer);

    await expect(targetService().import(buffer)).rejects.toThrow(ConflictError);
  });

  it('reports the conflicts it refused on', async () => {
    const { buffer } = await sourceService().export();
    await targetService().import(buffer);

    const error = await targetService()
      .import(buffer)
      .catch((err: Error) => err);

    expect(error.message).toContain('overwrite=true');
    expect(error.message).toContain('config/config.json');
  });

  it('replaces existing state when overwrite is set', async () => {
    const { buffer } = await sourceService().export();
    await targetService().import(buffer);
    const result = await targetService().import(buffer, { overwrite: true });

    expect(result.agents).toHaveLength(2);
    expect(result.collisions.length).toBeGreaterThan(0);
    // The previous config is preserved next to the restored one.
    expect(result.warnings.some((warning) => warning.includes('.bak-'))).toBe(true);
  });

  it('writes nothing on a dry run', async () => {
    const { buffer } = await sourceService().export();
    const result = await targetService().import(buffer, { dryRun: true });

    expect(result.dryRun).toBe(true);
    expect(result.filesWritten).toBe(0);
    expect(existsSync(TARGET_CONFIG)).toBe(false);
    expect(existsSync(join(TARGET, 'config', 'bots.json'))).toBe(false);
  });

  it('restores only the requested sections', async () => {
    const { buffer } = await sourceService().export();
    const result = await targetService().import(buffer, { sections: ['agents'] });

    expect(result.sections).toEqual(['agents']);
    expect(existsSync(TARGET_CONFIG)).toBe(false);
    expect(existsSync(join(TARGET, 'config', 'bots.json'))).toBe(true);
    expect(existsSync(join(TARGET, 'config', 'soul', 'coach', 'IDENTITY.md'))).toBe(true);
    expect(existsSync(join(TARGET, 'data', 'cron', 'jobs.json'))).toBe(false);
  });

  it('restores only the requested agents', async () => {
    const { buffer } = await sourceService().export();
    const result = await targetService().import(buffer, {
      sections: ['agents'],
      agentIds: ['helper'],
    });

    expect(result.agents.map((agent) => agent.botId)).toEqual(['helper']);
    expect(existsSync(join(TARGET, 'config', 'soul', 'coach'))).toBe(false);
    expect(existsSync(join(TARGET, 'config', 'soul', 'helper', 'IDENTITY.md'))).toBe(true);
  });

  it('warns about required environment variables missing on the target', async () => {
    const { buffer } = await sourceService().export();
    const result = await targetService().import(buffer);

    // A per-bot channel variable is guaranteed absent; OLLAMA_API_KEY and
    // friends may legitimately be set in the developer's own environment.
    expect(result.missingEnv).toContain('AIBOT_BOT_COACH_WHATSAPP_TOKEN');
    expect(result.warnings.some((warning) => warning.includes('REQUIRED_ENV.txt'))).toBe(true);
  });

  it('refuses while any bot is running', async () => {
    const { buffer } = await sourceService().export();
    const service = targetService({ isAnyBotRunning: () => ['coach'] });

    await expect(service.import(buffer)).rejects.toThrow('Stop all running agents');
  });

  it('rejects a bundle from a newer schema version', async () => {
    const { buffer } = await sourceService().export();
    const { files } = unpackTarGz(buffer);
    const manifest = JSON.parse(files.get('manifest.json')?.toString('utf-8') ?? '{}');
    manifest.version = 99;

    const tampered = packTarGz(
      [...files].map(([path, data]) =>
        path === 'manifest.json'
          ? { path, data: Buffer.from(JSON.stringify(manifest), 'utf-8') }
          : { path, data }
      )
    );

    await expect(targetService().import(tampered)).rejects.toThrow(VersionMismatchError);
    await expect(targetService().import(tampered)).rejects.toThrow('version 99');
  });

  it('rejects a single-agent archive with an actionable message', async () => {
    const perBot = packTarGz([
      { path: 'manifest.json', data: Buffer.from(JSON.stringify({ version: 1, botId: 'x' })) },
      { path: 'config.json', data: Buffer.from('{}') },
    ]);

    await expect(targetService().import(perBot)).rejects.toThrow(VersionMismatchError);
    await expect(targetService().import(perBot)).rejects.toThrow('agent importer');
  });

  it('rejects a bundle with no manifest', async () => {
    const junk = packTarGz([{ path: 'readme.txt', data: Buffer.from('hello') }]);
    await expect(targetService().import(junk)).rejects.toThrow('missing manifest.json');
  });

  it('detects a tampered payload via the manifest checksum', async () => {
    const { buffer } = await sourceService().export();
    const { files } = unpackTarGz(buffer);

    const tampered = packTarGz(
      [...files].map(([path, data]) =>
        path === 'config/bots.json'
          ? { path, data: Buffer.from('[{"id":"evil","name":"Evil","token":"x"}]') }
          : { path, data }
      )
    );

    await expect(targetService().import(tampered)).rejects.toThrow('checksum mismatch');
  });

  it('detects a file listed in the manifest but missing from the archive', async () => {
    const { buffer } = await sourceService().export();
    const { files } = unpackTarGz(buffer);

    const truncated = packTarGz(
      [...files]
        .filter(([path]) => path !== 'data/cron/jobs.json')
        .map(([path, data]) => ({ path, data }))
    );

    await expect(targetService().import(truncated)).rejects.toThrow('missing');
  });

  it('normalizes Windows-style paths in a hand-built bundle', async () => {
    // Simulates a bundle whose producer wrote host separators into entry names.
    const { buffer } = await sourceService().export({ sections: ['agents'] });
    const { files } = unpackTarGz(buffer);
    const rebuilt = packTarGz(
      [...files].map(([path, data]) => ({ path: path.replace(/\//g, '\\'), data }))
    );

    const result = await targetService().import(rebuilt);
    expect(result.agents.map((agent) => agent.botId).sort()).toEqual(['coach', 'helper']);
    expect(existsSync(join(TARGET, 'config', 'soul', 'coach', 'IDENTITY.md'))).toBe(true);
  });

  it('refuses to extract a path that escapes the target', () => {
    expect(() => packTarGz([{ path: '../../evil.sh', data: Buffer.from('x') }])).toThrow(
      'unsafe path'
    );
  });

  it('reports the source host in the restored manifest', async () => {
    const { buffer } = await sourceService().export();
    const result = await targetService().import(buffer, { dryRun: true });

    expect(result.manifest.source.hostname.length).toBeGreaterThan(0);
    expect(result.manifest.sections).toEqual(['config', 'agents', 'data', 'tenants']);
  });
});
