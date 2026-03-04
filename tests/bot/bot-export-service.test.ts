import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BotExportService, ConflictError } from '../../src/bot/bot-export-service';
import type { BotConfig, Config } from '../../src/config';

const TEST_DIR = join(import.meta.dir, '..', '..', '.test-export-service');
const SOUL_DIR = join(TEST_DIR, 'soul');
const PROD_DIR = join(TEST_DIR, 'productions');
const CONV_DIR = join(TEST_DIR, 'conversations');
const KARMA_DIR = join(TEST_DIR, 'karma');
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
  return {
    id: 'test-bot',
    name: 'Test Bot',
    token: 'secret-token-12345678',
    enabled: true,
    skills: ['skill1', 'skill2'],
    ...overrides,
  };
}

function makeConfig(bots: BotConfig[] = [makeBot()]): Config {
  return {
    bots,
    soul: { dir: SOUL_DIR } as any,
    productions: { baseDir: PROD_DIR, enabled: true } as any,
    conversations: { baseDir: CONV_DIR } as any,
    karma: { baseDir: KARMA_DIR, enabled: true } as any,
    ollama: { models: { primary: 'test-model' } } as any,
    conversation: {} as any,
    agentLoop: {} as any,
    paths: { data: join(TEST_DIR, 'data') } as any,
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

      // Verify it's a valid tar.gz by extracting
      const verifyDir = join(TEST_DIR, 'verify');
      mkdirSync(verifyDir, { recursive: true });
      writeFileSync(join(TEST_DIR, 'test.tar.gz'), buffer);
      const proc = Bun.spawn(['tar', '-xzf', join(TEST_DIR, 'test.tar.gz'), '-C', verifyDir], {
        stdout: 'pipe',
        stderr: 'pipe',
      });
      await proc.exited;

      expect(existsSync(join(verifyDir, 'manifest.json'))).toBe(true);
      expect(existsSync(join(verifyDir, 'config.json'))).toBe(true);
      expect(existsSync(join(verifyDir, 'soul', 'IDENTITY.md'))).toBe(true);
      expect(existsSync(join(verifyDir, 'soul', 'SOUL.md'))).toBe(true);
      expect(existsSync(join(verifyDir, 'soul', 'MEMORY.md'))).toBe(true);
      expect(existsSync(join(verifyDir, 'soul', 'memory', 'legacy.md'))).toBe(true);

      // Verify manifest
      const manifest = JSON.parse(readFileSync(join(verifyDir, 'manifest.json'), 'utf-8'));
      expect(manifest.version).toBe(1);
      expect(manifest.botId).toBe('test-bot');
      expect(manifest.botName).toBe('Test Bot');
      expect(manifest.includes.soul).toBe(true);

      // Verify config is sanitized (no token)
      const exportedConfig = JSON.parse(readFileSync(join(verifyDir, 'config.json'), 'utf-8'));
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

      const verifyDir = join(TEST_DIR, 'verify');
      mkdirSync(verifyDir, { recursive: true });
      writeFileSync(join(TEST_DIR, 'test.tar.gz'), buffer);
      const proc = Bun.spawn(['tar', '-xzf', join(TEST_DIR, 'test.tar.gz'), '-C', verifyDir], {
        stdout: 'pipe',
        stderr: 'pipe',
      });
      await proc.exited;

      expect(existsSync(join(verifyDir, 'soul', '.versions'))).toBe(false);
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

      const verifyDir = join(TEST_DIR, 'verify');
      mkdirSync(verifyDir, { recursive: true });
      writeFileSync(join(TEST_DIR, 'test.tar.gz'), buffer);
      const proc = Bun.spawn(['tar', '-xzf', join(TEST_DIR, 'test.tar.gz'), '-C', verifyDir], {
        stdout: 'pipe',
        stderr: 'pipe',
      });
      await proc.exited;

      expect(existsSync(join(verifyDir, 'core_memory.jsonl'))).toBe(true);
      const lines = readFileSync(join(verifyDir, 'core_memory.jsonl'), 'utf-8').trim().split('\n');
      expect(lines).toHaveLength(2);
      expect(JSON.parse(lines[0]).key).toBe('name');
      expect(JSON.parse(lines[1]).key).toBe('primary');
    });

    it('includes productions when opted in', async () => {
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

      const buffer = await service.exportBot('test-bot', { productions: true });

      const verifyDir = join(TEST_DIR, 'verify');
      mkdirSync(verifyDir, { recursive: true });
      writeFileSync(join(TEST_DIR, 'test.tar.gz'), buffer);
      const proc = Bun.spawn(['tar', '-xzf', join(TEST_DIR, 'test.tar.gz'), '-C', verifyDir], {
        stdout: 'pipe',
        stderr: 'pipe',
      });
      await proc.exited;

      expect(existsSync(join(verifyDir, 'productions', 'file1.md'))).toBe(true);
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

    it('throws on invalid archive (missing manifest)', async () => {
      // Create a tar.gz with no manifest
      const stagingDir = join(TEST_DIR, 'bad-archive');
      mkdirSync(stagingDir, { recursive: true });
      writeFileSync(join(stagingDir, 'random.txt'), 'not a bot export');

      const archivePath = join(TEST_DIR, 'bad.tar.gz');
      const proc = Bun.spawn(['tar', '-czf', archivePath, '-C', stagingDir, '.'], {
        stdout: 'pipe',
        stderr: 'pipe',
      });
      await proc.exited;
      const buffer = readFileSync(archivePath) as Buffer;

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
      db.close();

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
      const verifyDir = join(TEST_DIR, 'verify');
      mkdirSync(verifyDir, { recursive: true });
      writeFileSync(join(TEST_DIR, 'test.tar.gz'), buffer);
      const proc = Bun.spawn(['tar', '-xzf', join(TEST_DIR, 'test.tar.gz'), '-C', verifyDir], {
        stdout: 'pipe',
        stderr: 'pipe',
      });
      await proc.exited;

      const manifest = JSON.parse(readFileSync(join(verifyDir, 'manifest.json'), 'utf-8'));
      expect(manifest.includes.coreMemory).toBe(true);
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
      const verifyDir = join(TEST_DIR, 'verify');
      mkdirSync(verifyDir, { recursive: true });
      writeFileSync(join(TEST_DIR, 'test.tar.gz'), buffer);
      const proc = Bun.spawn(['tar', '-xzf', join(TEST_DIR, 'test.tar.gz'), '-C', verifyDir], {
        stdout: 'pipe',
        stderr: 'pipe',
      });
      await proc.exited;

      const manifest = JSON.parse(readFileSync(join(verifyDir, 'manifest.json'), 'utf-8'));
      expect(manifest.includes.coreMemory).toBe(false);
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
      const verifyDir = join(TEST_DIR, 'verify');
      mkdirSync(verifyDir, { recursive: true });
      writeFileSync(join(TEST_DIR, 'test.tar.gz'), buffer);
      const proc = Bun.spawn(['tar', '-xzf', join(TEST_DIR, 'test.tar.gz'), '-C', verifyDir], {
        stdout: 'pipe',
        stderr: 'pipe',
      });
      await proc.exited;

      const manifest = JSON.parse(readFileSync(join(verifyDir, 'manifest.json'), 'utf-8'));
      expect(manifest.includes.coreMemory).toBe(false);
    });
  });
});
