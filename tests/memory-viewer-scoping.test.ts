import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { Logger } from '../src/logger';
import { type CoreMemoryManager, createCoreMemoryManager } from '../src/memory/core-memory';
import {
  MEMORY_VIEWER_ARG,
  isPathVisibleTo,
  memoryScope,
  memoryViewerFromArgs,
} from '../src/memory/viewer';
import { createCoreMemoryTools } from '../src/tools/core-memory';
import { createRecallMemoryTool } from '../src/tools/recall-memory';

const noopLogger: Logger = {
  info: () => {},
  warn: () => {},
  debug: () => {},
  error: () => {},
  child: () => noopLogger,
};

const BOT = 'default';
const PRI = '1531050540';
const DIEGO = '796164002';

describe('isPathVisibleTo', () => {
  test('bot-wide files are visible to everyone, including the shared viewer', () => {
    for (const viewer of [PRI, DIEGO, null]) {
      expect(isPathVisibleTo('default/MEMORY.md', BOT, viewer)).toBe(true);
      expect(isPathVisibleTo('default/memory/2026-10-06.md', BOT, viewer)).toBe(true);
    }
  });

  test("a person's own folder and private transcript are theirs only", () => {
    expect(isPathVisibleTo(`default/memory/users/${PRI}/2026-10-05.md`, BOT, PRI)).toBe(true);
    expect(isPathVisibleTo(`default/memory/users/${PRI}/2026-10-05.md`, BOT, DIEGO)).toBe(false);
    expect(isPathVisibleTo(`default/memory/users/${PRI}/2026-10-05.md`, BOT, null)).toBe(false);
    expect(isPathVisibleTo(`sessions/bot-default-private-${PRI}`, BOT, PRI)).toBe(true);
    expect(isPathVisibleTo(`sessions/bot-default-private-${PRI}`, BOT, DIEGO)).toBe(false);
    expect(isPathVisibleTo(`sessions/bot-default-private-${PRI}`, BOT, null)).toBe(false);
  });

  test('an id that only shares a prefix is someone else', () => {
    expect(isPathVisibleTo('sessions/bot-default-private-15310505401', BOT, PRI)).toBe(false);
    expect(isPathVisibleTo('default/memory/users/15310505401/x.md', BOT, PRI)).toBe(false);
  });

  test('group transcripts stay visible (shared context of that group)', () => {
    expect(isPathVisibleTo('sessions/bot-default-group--100123', BOT, DIEGO)).toBe(true);
  });
});

describe('memoryViewerFromArgs / memoryScope', () => {
  test('a person, the shared viewer, or legacy', () => {
    expect(memoryViewerFromArgs({ [MEMORY_VIEWER_ARG]: PRI })).toBe(PRI);
    expect(memoryViewerFromArgs({ [MEMORY_VIEWER_ARG]: null })).toBeNull();
    expect(memoryViewerFromArgs({})).toBeUndefined();
  });

  test('the viewer wins over the isolation userId; absent viewer keeps the old behaviour', () => {
    expect(memoryScope(PRI, undefined)).toBe(PRI);
    expect(memoryScope(null, 'x')).toBeNull();
    expect(memoryScope(undefined, 'x')).toBe('x');
    expect(memoryScope(undefined, undefined)).toBeUndefined();
  });
});

describe('core memory seen through a viewer', () => {
  let db: Database;
  let core: CoreMemoryManager;

  beforeEach(async () => {
    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE core_memory (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        bot_id TEXT NOT NULL DEFAULT 'default',
        user_id TEXT,
        category TEXT NOT NULL,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        importance INTEGER NOT NULL DEFAULT 5,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(bot_id, user_id, category, key)
      );
    `);
    core = createCoreMemoryManager(db, noopLogger);
    await core.set(
      'goals',
      'pri_private_worry',
      'Pri worries about something private',
      9,
      BOT,
      PRI
    );
    await core.set('relationships', 'family', 'Emma and Renata are Diego daughters', 10, BOT);
  });

  afterEach(() => db.close());

  test("Diego's prompt never shows Pri's private fact; Pri's does", () => {
    const forDiego = core.renderForSystemPrompt(800, BOT, memoryScope(DIEGO, undefined));
    expect(forDiego).toContain('Emma and Renata');
    expect(forDiego).not.toContain('private');
    const forPri = core.renderForSystemPrompt(800, BOT, memoryScope(PRI, undefined));
    expect(forPri).toContain('private');
  });

  test('the shared viewer (agent loop) sees only shared facts', () => {
    const forLoop = core.renderForSystemPrompt(800, BOT, memoryScope(null, undefined));
    expect(forLoop).toContain('Emma and Renata');
    expect(forLoop).not.toContain('private');
  });

  test('core_memory_search and recall_memory respect the viewer', async () => {
    const search = createCoreMemoryTools(core).find(
      (t) => t.definition.function.name === 'core_memory_search'
    )!;
    const asDiego = await search.execute({
      query: 'worries',
      _botId: BOT,
      [MEMORY_VIEWER_ARG]: DIEGO,
    });
    expect(asDiego.content).not.toContain('private');
    const asPri = await search.execute({ query: 'worries', _botId: BOT, [MEMORY_VIEWER_ARG]: PRI });
    expect(asPri.content).toContain('private');

    const recall = createRecallMemoryTool(core);
    const recallDiego = await recall.execute({
      topic: 'worries private',
      _botId: BOT,
      [MEMORY_VIEWER_ARG]: DIEGO,
    });
    expect(recallDiego.content).not.toContain('Pri worries');
  });

  test('core_memory_append in a chat stores the fact for that person', async () => {
    const append = createCoreMemoryTools(core).find(
      (t) => t.definition.function.name === 'core_memory_append'
    )!;
    await append.execute({
      category: 'preferences',
      key: 'diego_coffee',
      value: 'Diego drinks coffee black',
      _botId: BOT,
      [MEMORY_VIEWER_ARG]: DIEGO,
    });
    const row = db.query("SELECT user_id FROM core_memory WHERE key = 'diego_coffee'").get() as {
      user_id: string;
    };
    expect(row.user_id).toBe(DIEGO);
  });
});
