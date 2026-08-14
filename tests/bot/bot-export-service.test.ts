import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BotExportService, ConflictError } from '../../src/bot/bot-export-service';
import type { BotConfig, Config } from '../../src/config';
import { packTarGz, unpackTarGz } from '../../src/system/tar-archive';

/**
 * Read an export archive in-process. These assertions used to spawn `tar`,
 * which made the whole suite fail on any host without the binary.
 */
function extract(buffer: Buffer) {
  const { files } = unpackTarGz(buffer);
  return {
    has: (path: string) => files.has(path),
    text: (path: string) => files.get(path)?.toString('utf-8') ?? '',
    json: (path: string) => JSON.parse(files.get(path)?.toString('utf-8') ?? 'null'),
    paths: () => [...files.keys()],
  };
}

const TEST_DIR = join(import.meta.dir, '..', '..', '.test-export-service');
const SOUL_DIR = join(TEST_DIR, 'soul');
const PROD_DIR = join(TEST_DIR, 'productions');
const CONV_DIR = join(TEST_DIR, 'conversations');
const KARMA_DIR = join(TEST_DIR, 'karma');
const SESSION_DIR = join(TEST_DIR, 'data', 'sessions');
const CONFIG_PATH = join(TEST_DIR, 'config.json');
const BOTS_PATH = join(TEST_DIR, 'bots.json');

function createMockLogger() {
  return {
    info: mock(() => {}),
    warn: mock(() => {}),
    error: mock(() => {}),
    debug: mock(() => {}),
    child: () => createMockLogger(),
  } as any;
}

function makeBot(overrides: Partial<BotConfig> = {}): BotConfig {
  const id = (overrides.id as string) || 'test-bot';
  return {
    id,
    name: 'Test Bot',
    token: 'secret-token-12345678',
    enabled: true,
    skills: ['skill1', 'skill2'],
    soulDir: join(SOUL_DIR, id),
    ...overrides,
  };
}

const DATA_DIR = join(TEST_DIR, 'data', 'tenants');

function makeConfig(bots: BotConfig[] = [makeBot()]): Config {
  return {
    bots,
    soul: { dir: SOUL_DIR } as any,
    productions: { baseDir: PROD_DIR, enabled: true } as any,
    conversations: { baseDir: CONV_DIR } as any,
    karma: { baseDir: KARMA_DIR, enabled: true } as any,
    session: { dataDir: SESSION_DIR } as any,
    ollama: { models: { primary: 'test-model' } } as any,
    conversation: {} as any,
    agentLoop: {} as any,
    paths: { data: join(TEST_DIR, 'data') } as any,
    multiTenant: { dataDir: DATA_DIR } as any,
  } as Config;
}

function createMockCoreMemory(entries: any[] = []) {
  return {
    list: mock(async () => entries),
    set: mock(async () => {}),
    get: mock(async () => null),
    delete: mock(async () => false),
    search: mock(async () => []),
    renderForSystemPrompt: mock(() => ''),
  } as any;
}

function writeSoul(botId: string) {
  const soulDir = join(SOUL_DIR, botId);
  mkdirSync(join(soulDir, 'memory'), { recursive: true });
  writeFileSync(join(soulDir, 'IDENTITY.md'), `name: ${botId}\n`);
}

function plantSessions(
  botId: string,
  opts: { nested?: boolean; legacy?: boolean; extraBot?: string } = {}
) {
  mkdirSync(join(SESSION_DIR, 'transcripts', botId), { recursive: true });

  const sessions: Record<string, { key: string; messageCount: number }> = {
    [`bot:${botId}:private:111`]: { key: `bot:${botId}:private:111`, messageCount: 3 },
  };
  const active: Record<string, number> = {
    [`${botId}:-100:111`]: 1_700_000_000_000,
  };

  if (opts.extraBot) {
    sessions[`bot:${opts.extraBot}:private:222`] = {
      key: `bot:${opts.extraBot}:private:222`,
      messageCount: 1,
    };
    active[`${opts.extraBot}:-100:222`] = 1_700_000_000_001;
    mkdirSync(join(SESSION_DIR, 'transcripts', opts.extraBot), { recursive: true });
    writeFileSync(
      join(SESSION_DIR, 'transcripts', opts.extraBot, `bot-${opts.extraBot}-private-222.jsonl`),
      '{"role":"user","content":"other"}\n'
    );
    writeFileSync(
      join(SESSION_DIR, 'transcripts', `bot-${opts.extraBot}-group-888.jsonl`),
      '{"role":"user","content":"other-legacy"}\n'
    );
  }

  writeFileSync(join(SESSION_DIR, 'sessions.json'), JSON.stringify(sessions, null, 2));
  writeFileSync(join(SESSION_DIR, 'active-conversations.json'), JSON.stringify(active, null, 2));

  if (opts.nested !== false) {
    writeFileSync(
      join(SESSION_DIR, 'transcripts', botId, `bot-${botId}-private-111.jsonl`),
      '{"role":"user","content":"hi"}\n'
    );
  }
  if (opts.legacy) {
    writeFileSync(
      join(SESSION_DIR, 'transcripts', `bot-${botId}-group-999.jsonl`),
      '{"role":"user","content":"legacy"}\n'
    );
  }
}

describe('BotExportService', () => {
  beforeEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
    mkdirSync(TEST_DIR, { recursive: true });
    // Write minimal config files for persistBots
    writeFileSync(CONFIG_PATH, JSON.stringify({}, null, 2), 'utf-8');
    writeFileSync(BOTS_PATH, JSON.stringify([], null, 2), 'utf-8');
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  describe('exportBot', () => {
    it('exports a bot with soul files as tar.gz buffer', async () => {
      const bot = makeBot();
      const config = makeConfig([bot]);
      const soulDir = join(SOUL_DIR, 'test-bot');
      mkdirSync(join(soulDir, 'memory'), { recursive: true });
      writeFileSync(join(soulDir, 'IDENTITY.md'), 'name: Test Bot\n');
      writeFileSync(join(soulDir, 'SOUL.md'), '# Soul\nFriendly');
      writeFileSync(join(soulDir, 'MEMORY.md'), '<!-- last-consolidated: 2026-01-01 -->\n# Memory');
      writeFileSync(join(soulDir, 'memory', 'legacy.md'), '# Legacy');

      const logger = createMockLogger();
      const service = new BotExportService(config, CONFIG_PATH, logger);

      const buffer = await service.exportBot('test-bot');
      expect(buffer).toBeInstanceOf(Buffer);
      expect(buffer.length).toBeGreaterThan(0);

      const archive = extract(buffer);
      expect(archive.has('manifest.json')).toBe(true);
      expect(archive.has('config.json')).toBe(true);
      expect(archive.has('soul/IDENTITY.md')).toBe(true);
      expect(archive.has('soul/SOUL.md')).toBe(true);
      expect(archive.has('soul/MEMORY.md')).toBe(true);
      expect(archive.has('soul/memory/legacy.md')).toBe(true);

      const manifest = archive.json('manifest.json');
      expect(manifest.version).toBe(1);
      expect(manifest.botId).toBe('test-bot');
      expect(manifest.botName).toBe('Test Bot');
      expect(manifest.includes.soul).toBe(true);

      // Verify config is sanitized (no token)
      const exportedConfig = archive.json('config.json');
      expect(exportedConfig.token).toBe('');
      expect(exportedConfig.id).toBe('test-bot');
    });

    it('excludes .versions/ directory from soul export', async () => {
      const bot = makeBot();
      const config = makeConfig([bot]);
      const soulDir = join(SOUL_DIR, 'test-bot');
      mkdirSync(join(soulDir, '.versions'), { recursive: true });
      mkdirSync(join(soulDir, 'memory'), { recursive: true });
      writeFileSync(join(soulDir, 'IDENTITY.md'), 'name: Test Bot\n');
      writeFileSync(join(soulDir, '.versions', 'IDENTITY.md.bak'), 'old');

      const logger = createMockLogger();
      const service = new BotExportService(config, CONFIG_PATH, logger);

      const buffer = await service.exportBot('test-bot');

      const archive = extract(buffer);
      expect(archive.paths().some((path) => path.includes('.versions'))).toBe(false);
    });

    it('throws for non-existent bot', async () => {
      const config = makeConfig([]);
      const logger = createMockLogger();
      const service = new BotExportService(config, CONFIG_PATH, logger);

      expect(service.exportBot('nonexistent')).rejects.toThrow('Bot not found');
    });

    it('exports core_memory as JSONL when available', async () => {
      const bot = makeBot();
      const config = makeConfig([bot]);
      const soulDir = join(SOUL_DIR, 'test-bot');
      mkdirSync(join(soulDir, 'memory'), { recursive: true });
      writeFileSync(join(soulDir, 'IDENTITY.md'), 'name: Test Bot\n');

      const entries = [
        { category: 'identity', key: 'name', value: 'Test Bot', importance: 8 },
        { category: 'goals', key: 'primary', value: 'Help users', importance: 9 },
      ];
      const coreMemory = createMockCoreMemory(entries);
      const logger = createMockLogger();
      const service = new BotExportService(config, CONFIG_PATH, logger, () => coreMemory);

      const buffer = await service.exportBot('test-bot');
      const archive = extract(buffer);
      expect(archive.has('core_memory.jsonl')).toBe(true);
      const lines = archive.text('core_memory.jsonl').trim().split('\n');
      expect(lines).toHaveLength(2);
      expect(JSON.parse(lines[0]).key).toBe('name');
      expect(JSON.parse(lines[1]).key).toBe('primary');
    });

    it('includes productions by default and excludes them when opted out', async () => {
      const bot = makeBot();
      const config = makeConfig([bot]);
      const soulDir = join(SOUL_DIR, 'test-bot');
      mkdirSync(join(soulDir, 'memory'), { recursive: true });
      writeFileSync(join(soulDir, 'IDENTITY.md'), 'name: Test Bot\n');

      const prodDir = join(PROD_DIR, 'test-bot');
      mkdirSync(prodDir, { recursive: true });
      writeFileSync(join(prodDir, 'file1.md'), '# Production 1');

      const logger = createMockLogger();
      const service = new BotExportService(config, CONFIG_PATH, logger);

      expect(extract(await service.exportBot('test-bot')).has('productions/file1.md')).toBe(true);
      expect(
        extract(await service.exportBot('test-bot', { productions: false })).has(
          'productions/file1.md'
        )
      ).toBe(false);
    });

    it('warns when soul dir is missing', async () => {
      const bot = makeBot();
      const config = makeConfig([bot]);
      // Don't create soul dir

      const logger = createMockLogger();
      const service = new BotExportService(config, CONFIG_PATH, logger);

      const buffer = await service.exportBot('test-bot');
      expect(buffer.length).toBeGreaterThan(0);
      expect(logger.warn).toHaveBeenCalled();
    });
  });

  describe('importBot', () => {
    async function createExportBuffer(
      botConfig?: Partial<BotConfig>,
      soulFiles?: Record<string, string>,
      extras?: { coreMemory?: any[]; productions?: Record<string, string> }
    ): Promise<Buffer> {
      const bot = makeBot(botConfig);
      const config = makeConfig([bot]);
      const soulDir = join(SOUL_DIR, bot.id);
      mkdirSync(join(soulDir, 'memory'), { recursive: true });
      writeFileSync(join(soulDir, 'IDENTITY.md'), soulFiles?.['IDENTITY.md'] ?? 'name: Test Bot\n');
      if (soulFiles?.['SOUL.md']) writeFileSync(join(soulDir, 'SOUL.md'), soulFiles['SOUL.md']);
      if (soulFiles?.['MEMORY.md'])
        writeFileSync(join(soulDir, 'MEMORY.md'), soulFiles['MEMORY.md']);

      if (extras?.productions) {
        const prodDir = join(PROD_DIR, bot.id);
        mkdirSync(prodDir, { recursive: true });
        for (const [name, content] of Object.entries(extras.productions)) {
          writeFileSync(join(prodDir, name), content);
        }
      }

      const logger = createMockLogger();
      const coreMemory = extras?.coreMemory ? createMockCoreMemory(extras.coreMemory) : undefined;
      const service = new BotExportService(
        config,
        CONFIG_PATH,
        logger,
        coreMemory ? () => coreMemory : undefined
      );

      return service.exportBot(bot.id, {
        productions: !!extras?.productions,
      });
    }

    it('imports a bot from an export archive', async () => {
      const exportBuffer = await createExportBuffer(
        { id: 'source-bot', name: 'Source Bot' },
        { 'IDENTITY.md': 'name: Source Bot\n', 'SOUL.md': '# Soul\nFriendly' }
      );

      // Clean up and create fresh state for import
      rmSync(TEST_DIR, { recursive: true, force: true });
      mkdirSync(TEST_DIR, { recursive: true });
      writeFileSync(CONFIG_PATH, JSON.stringify({}, null, 2), 'utf-8');
      writeFileSync(BOTS_PATH, JSON.stringify([], null, 2), 'utf-8');

      const importConfig = makeConfig([]);
      const logger = createMockLogger();
      const service = new BotExportService(importConfig, CONFIG_PATH, logger);

      const result = await service.importBot(exportBuffer, {
        newBotId: 'imported-bot',
        newBotName: 'Imported Bot',
      });

      expect(result.botId).toBe('imported-bot');
      expect(result.botName).toBe('Imported Bot');
      expect(result.created).toBe(true);
      expect(result.warnings).toHaveLength(0);

      // Verify soul files were copied
      const importedSoulDir = join(SOUL_DIR, 'imported-bot');
      expect(existsSync(join(importedSoulDir, 'IDENTITY.md'))).toBe(true);
      expect(existsSync(join(importedSoulDir, 'SOUL.md'))).toBe(true);

      // Verify bot config was persisted
      const bots = JSON.parse(readFileSync(BOTS_PATH, 'utf-8'));
      expect(bots).toHaveLength(1);
      expect(bots[0].id).toBe('imported-bot');
      expect(bots[0].name).toBe('Imported Bot');
      expect(bots[0].token).toBe('');
      expect(bots[0].enabled).toBe(false);
    });

    it('uses original botId/name when no overrides given', async () => {
      const exportBuffer = await createExportBuffer({
        id: 'original-bot',
        name: 'Original Bot',
      });

      rmSync(TEST_DIR, { recursive: true, force: true });
      mkdirSync(TEST_DIR, { recursive: true });
      writeFileSync(CONFIG_PATH, JSON.stringify({}, null, 2), 'utf-8');
      writeFileSync(BOTS_PATH, JSON.stringify([], null, 2), 'utf-8');

      const importConfig = makeConfig([]);
      const logger = createMockLogger();
      const service = new BotExportService(importConfig, CONFIG_PATH, logger);

      const result = await service.importBot(exportBuffer);

      expect(result.botId).toBe('original-bot');
      expect(result.botName).toBe('Original Bot');
    });

    it('throws ConflictError when bot already exists', async () => {
      const exportBuffer = await createExportBuffer({ id: 'existing-bot' });

      rmSync(TEST_DIR, { recursive: true, force: true });
      mkdirSync(TEST_DIR, { recursive: true });
      writeFileSync(CONFIG_PATH, JSON.stringify({}, null, 2), 'utf-8');
      writeFileSync(BOTS_PATH, JSON.stringify([], null, 2), 'utf-8');

      const existingBot = makeBot({ id: 'existing-bot' });
      const importConfig = makeConfig([existingBot]);
      const logger = createMockLogger();
      const service = new BotExportService(importConfig, CONFIG_PATH, logger);

      expect(service.importBot(exportBuffer)).rejects.toThrow(ConflictError);
    });

    it('allows overwrite when flag is set', async () => {
      const exportBuffer = await createExportBuffer(
        { id: 'overwrite-bot', name: 'Original' },
        { 'IDENTITY.md': 'name: New Version\n' }
      );

      rmSync(TEST_DIR, { recursive: true, force: true });
      mkdirSync(TEST_DIR, { recursive: true });
      writeFileSync(CONFIG_PATH, JSON.stringify({}, null, 2), 'utf-8');
      writeFileSync(BOTS_PATH, JSON.stringify([], null, 2), 'utf-8');

      const existingBot = makeBot({
        id: 'overwrite-bot',
        name: 'Old Version',
        token: 'keep-this-token',
      });
      const importConfig = makeConfig([existingBot]);
      const logger = createMockLogger();
      const service = new BotExportService(importConfig, CONFIG_PATH, logger);

      const result = await service.importBot(exportBuffer, { overwrite: true });

      expect(result.botId).toBe('overwrite-bot');
      expect(result.warnings.length).toBeGreaterThan(0);

      // Verify token is preserved
      const bots = JSON.parse(readFileSync(BOTS_PATH, 'utf-8'));
      expect(bots[0].token).toBe('keep-this-token');
    });

    it('imports core memory entries', async () => {
      const coreEntries = [{ category: 'identity', key: 'name', value: 'Test Bot', importance: 8 }];
      const exportBuffer = await createExportBuffer(
        { id: 'mem-bot' },
        { 'IDENTITY.md': 'name: Mem Bot\n' },
        { coreMemory: coreEntries }
      );

      rmSync(TEST_DIR, { recursive: true, force: true });
      mkdirSync(TEST_DIR, { recursive: true });
      writeFileSync(CONFIG_PATH, JSON.stringify({}, null, 2), 'utf-8');
      writeFileSync(BOTS_PATH, JSON.stringify([], null, 2), 'utf-8');

      const coreMemory = createMockCoreMemory();
      const importConfig = makeConfig([]);
      const logger = createMockLogger();
      const service = new BotExportService(importConfig, CONFIG_PATH, logger, () => coreMemory);

      await service.importBot(exportBuffer, { newBotId: 'imported-mem' });

      expect(coreMemory.set).toHaveBeenCalledTimes(1);
    });

    it('drops a relative soulDir override that points away from the restored files', async () => {
      // Build the archive by hand: the export path resolves soulDir to an
      // absolute path, which the sanitizer already strips.
      const manifest = {
        version: 1,
        botId: 'ovr',
        botName: 'Override Bot',
        exportDate: new Date().toISOString(),
        includes: {
          soul: true,
          coreMemory: false,
          productions: false,
          conversations: false,
          karma: false,
        },
      };
      const exportBuffer = packTarGz([
        { path: 'manifest.json', data: Buffer.from(JSON.stringify(manifest)) },
        {
          path: 'config.json',
          data: Buffer.from(
            JSON.stringify({
              id: 'ovr',
              name: 'Override Bot',
              token: '',
              enabled: false,
              skills: [],
              soulDir: './config/soul/Improve my life',
              workDir: './work/ovr',
            })
          ),
        },
        { path: 'soul/IDENTITY.md', data: Buffer.from('name: Override Bot\n') },
      ]);

      const importConfig = makeConfig([]);
      const service = new BotExportService(importConfig, CONFIG_PATH, createMockLogger());
      const result = await service.importBot(exportBuffer);

      expect(result.warnings.some((w) => w.includes('Soul directory override'))).toBe(true);
      expect(result.warnings.some((w) => w.includes('Work directory override'))).toBe(true);

      const bots = JSON.parse(readFileSync(BOTS_PATH, 'utf-8'));
      expect(bots[0].soulDir).toBeUndefined();
      expect(bots[0].workDir).toBeUndefined();
      expect(existsSync(join(SOUL_DIR, 'ovr', 'IDENTITY.md'))).toBe(true);
    });

    it('throws on invalid archive (missing manifest)', async () => {
      const buffer = packTarGz([
        { path: 'random.txt', data: Buffer.from('not a bot export', 'utf-8') },
      ]);

      const config = makeConfig([]);
      const logger = createMockLogger();
      const service = new BotExportService(config, CONFIG_PATH, logger);

      expect(service.importBot(buffer)).rejects.toThrow('missing manifest.json');
    });

    it('restores productions when included in archive', async () => {
      const exportBuffer = await createExportBuffer(
        { id: 'prod-bot' },
        { 'IDENTITY.md': 'name: Prod Bot\n' },
        { productions: { 'article.md': '# Article' } }
      );

      rmSync(TEST_DIR, { recursive: true, force: true });
      mkdirSync(TEST_DIR, { recursive: true });
      writeFileSync(CONFIG_PATH, JSON.stringify({}, null, 2), 'utf-8');
      writeFileSync(BOTS_PATH, JSON.stringify([], null, 2), 'utf-8');

      const importConfig = makeConfig([]);
      const logger = createMockLogger();
      const service = new BotExportService(importConfig, CONFIG_PATH, logger);

      await service.importBot(exportBuffer, { newBotId: 'imported-prod' });

      const prodDir = join(PROD_DIR, 'imported-prod');
      expect(existsSync(join(prodDir, 'article.md'))).toBe(true);
      expect(readFileSync(join(prodDir, 'article.md'), 'utf-8')).toBe('# Article');
    });

    it('calls onSoulFilesImported callback after copying soul files', async () => {
      const exportBuffer = await createExportBuffer(
        { id: 'reindex-bot' },
        { 'IDENTITY.md': 'name: Reindex Bot\n', 'SOUL.md': '# Soul\nTest' }
      );

      rmSync(TEST_DIR, { recursive: true, force: true });
      mkdirSync(TEST_DIR, { recursive: true });
      writeFileSync(CONFIG_PATH, JSON.stringify({}, null, 2), 'utf-8');
      writeFileSync(BOTS_PATH, JSON.stringify([], null, 2), 'utf-8');

      const importConfig = makeConfig([]);
      const logger = createMockLogger();
      const onSoulFilesImported = mock(async () => {});
      const service = new BotExportService(
        importConfig,
        CONFIG_PATH,
        logger,
        undefined,
        onSoulFilesImported
      );

      await service.importBot(exportBuffer, { newBotId: 'imported-reindex' });

      expect(onSoulFilesImported).toHaveBeenCalledTimes(1);
    });

    it('imports core memory via SQLite fallback when no MemoryManager available', async () => {
      const coreEntries = [
        {
          category: 'relationships',
          key: 'pri',
          value: 'Priscila, pareja de Diego',
          importance: 9,
        },
        { category: 'identity', key: 'name', value: 'Test Bot', importance: 8 },
      ];
      const exportBuffer = await createExportBuffer(
        { id: 'fallback-bot' },
        { 'IDENTITY.md': 'name: Fallback Bot\n' },
        { coreMemory: coreEntries }
      );

      rmSync(TEST_DIR, { recursive: true, force: true });
      mkdirSync(TEST_DIR, { recursive: true });
      writeFileSync(CONFIG_PATH, JSON.stringify({}, null, 2), 'utf-8');
      writeFileSync(BOTS_PATH, JSON.stringify([], null, 2), 'utf-8');

      const dbPath = join(TEST_DIR, 'data', 'memory.db');
      const importConfig = makeConfig([]);
      (importConfig.soul as any).search = { dbPath };
      const logger = createMockLogger();
      // No getCoreMemory callback — forces SQLite fallback
      const service = new BotExportService(importConfig, CONFIG_PATH, logger);

      await service.importBot(exportBuffer, { newBotId: 'imported-fallback' });

      // Verify entries landed in SQLite
      const db = new Database(dbPath, { readonly: true });
      const rows = db
        .prepare('SELECT category, key, value, importance FROM core_memory WHERE bot_id = ?')
        .all('imported-fallback') as any[];
      // close(true) is required on Windows: a deferred close keeps the SQLite
      // file locked and the afterEach cleanup then fails with EBUSY.
      db.close(true);

      expect(rows).toHaveLength(2);
      const pri = rows.find((r: any) => r.key === 'pri');
      expect(pri).toBeDefined();
      expect(pri.value).toBe('Priscila, pareja de Diego');
      expect(pri.importance).toBe(9);
    });
  });

  describe('export manifest accuracy', () => {
    it('sets coreMemory: true when entries are exported', async () => {
      const bot = makeBot();
      const config = makeConfig([bot]);
      const soulDir = join(SOUL_DIR, 'test-bot');
      mkdirSync(join(soulDir, 'memory'), { recursive: true });
      writeFileSync(join(soulDir, 'IDENTITY.md'), 'name: Test Bot\n');

      const entries = [{ category: 'identity', key: 'name', value: 'Bot', importance: 8 }];
      const coreMemory = createMockCoreMemory(entries);
      const logger = createMockLogger();
      const service = new BotExportService(config, CONFIG_PATH, logger, () => coreMemory);

      const buffer = await service.exportBot('test-bot');
      expect(extract(buffer).json('manifest.json').includes.coreMemory).toBe(true);
    });

    it('sets coreMemory: false when no entries exist', async () => {
      const bot = makeBot();
      const config = makeConfig([bot]);
      const soulDir = join(SOUL_DIR, 'test-bot');
      mkdirSync(join(soulDir, 'memory'), { recursive: true });
      writeFileSync(join(soulDir, 'IDENTITY.md'), 'name: Test Bot\n');

      const coreMemory = createMockCoreMemory([]);
      const logger = createMockLogger();
      const service = new BotExportService(config, CONFIG_PATH, logger, () => coreMemory);

      const buffer = await service.exportBot('test-bot');
      expect(extract(buffer).json('manifest.json').includes.coreMemory).toBe(false);
    });

    it('sets coreMemory: false when no CoreMemoryManager provided', async () => {
      const bot = makeBot();
      const config = makeConfig([bot]);
      const soulDir = join(SOUL_DIR, 'test-bot');
      mkdirSync(join(soulDir, 'memory'), { recursive: true });
      writeFileSync(join(soulDir, 'IDENTITY.md'), 'name: Test Bot\n');

      const logger = createMockLogger();
      const service = new BotExportService(config, CONFIG_PATH, logger);

      const buffer = await service.exportBot('test-bot');
      expect(extract(buffer).json('manifest.json').includes.coreMemory).toBe(false);
    });
  });

  describe('Telegram sessions', () => {
    it('includes this bot\'s sessions by default and excludes them when opted out', async () => {
      const bot = makeBot();
      const config = makeConfig([bot]);
      writeSoul('test-bot');
      plantSessions('test-bot', { extraBot: 'other-bot', legacy: true });

      const service = new BotExportService(config, CONFIG_PATH, createMockLogger());

      const included = extract(await service.exportBot('test-bot'));
      expect(included.json('manifest.json').includes.sessions).toBe(true);
      expect(included.has('sessions/sessions.json')).toBe(true);
      expect(included.has('sessions/active-conversations.json')).toBe(true);
      expect(included.has('sessions/transcripts/bot-test-bot-private-111.jsonl')).toBe(true);
      expect(included.has('sessions/transcripts/bot-test-bot-group-999.jsonl')).toBe(true);

      const slicedSessions = included.json('sessions/sessions.json');
      expect(slicedSessions['bot:test-bot:private:111']).toBeDefined();
      expect(slicedSessions['bot:other-bot:private:222']).toBeUndefined();

      const slicedActive = included.json('sessions/active-conversations.json');
      expect(slicedActive['test-bot:-100:111']).toBeDefined();
      expect(slicedActive['other-bot:-100:222']).toBeUndefined();

      expect(included.has('sessions/transcripts/bot-other-bot-private-222.jsonl')).toBe(false);
      expect(included.has('sessions/transcripts/bot-other-bot-group-888.jsonl')).toBe(false);
      expect(
        included.paths().some((path) => path.startsWith('sessions/transcripts/other-bot/'))
      ).toBe(false);

      const excluded = extract(await service.exportBot('test-bot', { sessions: false }));
      expect(excluded.json('manifest.json').includes.sessions).toBe(false);
      expect(excluded.paths().some((path) => path.startsWith('sessions/'))).toBe(false);
    });

    it('collects both nested and legacy-flat transcripts into sessions/transcripts/', async () => {
      const bot = makeBot();
      const config = makeConfig([bot]);
      writeSoul('test-bot');
      plantSessions('test-bot', { nested: true, legacy: true });

      const service = new BotExportService(config, CONFIG_PATH, createMockLogger());
      const archive = extract(await service.exportBot('test-bot'));

      expect(archive.has('sessions/transcripts/bot-test-bot-private-111.jsonl')).toBe(true);
      expect(archive.has('sessions/transcripts/bot-test-bot-group-999.jsonl')).toBe(true);
      expect(archive.has('sessions/transcripts/test-bot/bot-test-bot-private-111.jsonl')).toBe(
        false
      );
    });

    it('merges imported sessions.json without clobbering another bot\'s keys', async () => {
      const source = makeBot({ id: 'source-bot' });
      writeSoul('source-bot');
      plantSessions('source-bot');
      const exportBuffer = await new BotExportService(
        makeConfig([source]),
        CONFIG_PATH,
        createMockLogger()
      ).exportBot('source-bot');

      rmSync(TEST_DIR, { recursive: true, force: true });
      mkdirSync(TEST_DIR, { recursive: true });
      writeFileSync(CONFIG_PATH, JSON.stringify({}, null, 2), 'utf-8');
      writeFileSync(BOTS_PATH, JSON.stringify([], null, 2), 'utf-8');
      plantSessions('other-bot');

      const importConfig = makeConfig([]);
      await new BotExportService(importConfig, CONFIG_PATH, createMockLogger()).importBot(
        exportBuffer,
        { newBotId: 'imported-bot' }
      );

      const merged = JSON.parse(readFileSync(join(SESSION_DIR, 'sessions.json'), 'utf-8'));
      expect(merged['bot:other-bot:private:111']).toBeDefined();
      expect(merged['bot:imported-bot:private:111']).toBeDefined();
      expect(merged['bot:source-bot:private:111']).toBeUndefined();

      const active = JSON.parse(
        readFileSync(join(SESSION_DIR, 'active-conversations.json'), 'utf-8')
      );
      expect(active['other-bot:-100:111']).toBeDefined();
      expect(active['imported-bot:-100:111']).toBeDefined();
    });

    it('overwrite replaces this bot\'s sessions and leaves others intact', async () => {
      const bot = makeBot({ id: 'overwrite-bot' });
      writeSoul('overwrite-bot');
      plantSessions('overwrite-bot');
      const exportBuffer = await new BotExportService(
        makeConfig([bot]),
        CONFIG_PATH,
        createMockLogger()
      ).exportBot('overwrite-bot');

      rmSync(TEST_DIR, { recursive: true, force: true });
      mkdirSync(TEST_DIR, { recursive: true });
      writeFileSync(CONFIG_PATH, JSON.stringify({}, null, 2), 'utf-8');
      writeFileSync(BOTS_PATH, JSON.stringify([], null, 2), 'utf-8');

      mkdirSync(join(SESSION_DIR, 'transcripts', 'overwrite-bot'), { recursive: true });
      writeFileSync(
        join(SESSION_DIR, 'sessions.json'),
        JSON.stringify({
          'bot:overwrite-bot:private:999': {
            key: 'bot:overwrite-bot:private:999',
            messageCount: 99,
          },
          'bot:other-bot:private:222': { key: 'bot:other-bot:private:222', messageCount: 1 },
        })
      );
      writeFileSync(
        join(SESSION_DIR, 'active-conversations.json'),
        JSON.stringify({
          'overwrite-bot:-100:999': 1,
          'other-bot:-100:222': 2,
        })
      );
      writeFileSync(
        join(SESSION_DIR, 'transcripts', 'overwrite-bot', 'bot-overwrite-bot-private-999.jsonl'),
        '{"role":"user","content":"stale"}\n'
      );
      writeFileSync(
        join(SESSION_DIR, 'transcripts', 'bot-overwrite-bot-group-888.jsonl'),
        '{"role":"user","content":"stale-legacy"}\n'
      );

      const existing = makeBot({ id: 'overwrite-bot', token: 'keep-token' });
      await new BotExportService(
        makeConfig([existing]),
        CONFIG_PATH,
        createMockLogger()
      ).importBot(exportBuffer, { overwrite: true });

      const merged = JSON.parse(readFileSync(join(SESSION_DIR, 'sessions.json'), 'utf-8'));
      expect(merged['bot:overwrite-bot:private:111']).toBeDefined();
      expect(merged['bot:overwrite-bot:private:999']).toBeUndefined();
      expect(merged['bot:other-bot:private:222']).toBeDefined();

      const active = JSON.parse(
        readFileSync(join(SESSION_DIR, 'active-conversations.json'), 'utf-8')
      );
      expect(active['overwrite-bot:-100:111']).toBeDefined();
      expect(active['overwrite-bot:-100:999']).toBeUndefined();
      expect(active['other-bot:-100:222']).toBeDefined();

      expect(
        existsSync(
          join(SESSION_DIR, 'transcripts', 'overwrite-bot', 'bot-overwrite-bot-private-111.jsonl')
        )
      ).toBe(true);
      expect(
        existsSync(
          join(SESSION_DIR, 'transcripts', 'overwrite-bot', 'bot-overwrite-bot-private-999.jsonl')
        )
      ).toBe(false);
      expect(existsSync(join(SESSION_DIR, 'transcripts', 'bot-overwrite-bot-group-888.jsonl'))).toBe(
        false
      );
    });

    it('rewrites session keys, active-conversation keys, and transcript filenames for newBotId', async () => {
      const source = makeBot({ id: 'old-id' });
      writeSoul('old-id');
      plantSessions('old-id', { legacy: true });
      const exportBuffer = await new BotExportService(
        makeConfig([source]),
        CONFIG_PATH,
        createMockLogger()
      ).exportBot('old-id');

      rmSync(TEST_DIR, { recursive: true, force: true });
      mkdirSync(TEST_DIR, { recursive: true });
      writeFileSync(CONFIG_PATH, JSON.stringify({}, null, 2), 'utf-8');
      writeFileSync(BOTS_PATH, JSON.stringify([], null, 2), 'utf-8');

      await new BotExportService(makeConfig([]), CONFIG_PATH, createMockLogger()).importBot(
        exportBuffer,
        { newBotId: 'new-id' }
      );

      const merged = JSON.parse(readFileSync(join(SESSION_DIR, 'sessions.json'), 'utf-8'));
      expect(merged['bot:new-id:private:111']).toBeDefined();
      expect(merged['bot:new-id:private:111'].key).toBe('bot:new-id:private:111');
      expect(merged['bot:old-id:private:111']).toBeUndefined();

      const active = JSON.parse(
        readFileSync(join(SESSION_DIR, 'active-conversations.json'), 'utf-8')
      );
      expect(active['new-id:-100:111']).toBeDefined();
      expect(active['old-id:-100:111']).toBeUndefined();

      expect(
        existsSync(join(SESSION_DIR, 'transcripts', 'new-id', 'bot-new-id-private-111.jsonl'))
      ).toBe(true);
      expect(
        existsSync(join(SESSION_DIR, 'transcripts', 'new-id', 'bot-new-id-group-999.jsonl'))
      ).toBe(true);
      expect(
        existsSync(join(SESSION_DIR, 'transcripts', 'new-id', 'bot-old-id-private-111.jsonl'))
      ).toBe(false);
    });
  });

  describe('soul path fallback', () => {
    it('exports soul files from the legacy soul.dir path when soulDir is unset', async () => {
      const bot = makeBot({ id: 'legacy-soul', soulDir: undefined });
      const config = makeConfig([bot]);
      const legacySoul = join(SOUL_DIR, 'legacy-soul');
      mkdirSync(legacySoul, { recursive: true });
      writeFileSync(join(legacySoul, 'IDENTITY.md'), 'name: Legacy Soul\n');
      writeFileSync(join(legacySoul, 'SOUL.md'), '# From legacy path\n');

      const tenantSoul = join(DATA_DIR, '__admin__', 'bots', 'legacy-soul', 'soul');
      expect(existsSync(tenantSoul)).toBe(false);

      const service = new BotExportService(config, CONFIG_PATH, createMockLogger());
      const archive = extract(await service.exportBot('legacy-soul'));

      expect(archive.has('soul/IDENTITY.md')).toBe(true);
      expect(archive.has('soul/SOUL.md')).toBe(true);
      expect(archive.text('soul/IDENTITY.md')).toContain('Legacy Soul');
    });
  });
});
