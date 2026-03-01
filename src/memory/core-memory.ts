import type { Database } from 'bun:sqlite';
import type { Logger } from '../logger';

export interface CoreMemoryEntry {
  id: number;
  category: string;
  key: string;
  value: string;
  importance: number;
  createdAt: string;
  updatedAt: string;
}

export interface CoreMemoryManager {
  /** Get a single entry by category and key */
  get(category: string, key: string, botId: string): Promise<CoreMemoryEntry | null>;

  /** Set (insert or update) an entry */
  set(
    category: string,
    key: string,
    value: string,
    importance: number,
    botId: string
  ): Promise<void>;

  /** Delete an entry */
  delete(category: string, key: string, botId: string): Promise<boolean>;

  /** Search entries by query string (matches key or value) */
  search(
    query: string,
    category: string | undefined,
    limit: number,
    botId: string
  ): Promise<CoreMemoryEntry[]>;

  /** List entries, optionally filtered by category and minimum importance */
  list(
    category: string | undefined,
    minImportance: number | undefined,
    botId: string
  ): Promise<CoreMemoryEntry[]>;

  /** Render formatted core memory block for system prompt injection */
  renderForSystemPrompt(maxChars: number, botId: string): string;
}

type CoreMemoryRow = {
  id: number;
  bot_id: string;
  category: string;
  key: string;
  value: string;
  importance: number;
  created_at: string;
  updated_at: string;
};

const VALID_CATEGORIES = new Set([
  'identity', // Who the bot is (name, description, values, style)
  'relationships', // Data about specific users
  'preferences', // Bot's own preferences
  'goals', // Long-term objectives
  'constraints', // Self-imposed limits
  'general', // General-purpose facts that don't fit other categories
]);

export function createCoreMemoryManager(db: Database, logger: Logger): CoreMemoryManager {
  const SELECT_COLS = 'id, bot_id, category, key, value, importance, created_at, updated_at';

  function rowToEntry(row: CoreMemoryRow): CoreMemoryEntry {
    return {
      id: row.id,
      category: row.category,
      key: row.key,
      value: row.value,
      importance: row.importance,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  // Helper function to format category (defined outside return to avoid this-binding issues)
  function formatCategory(items: CoreMemoryEntry[], maxChars: number): string {
    let content = '';

    for (const item of items.slice(0, 5)) {
      // max 5 items per category
      const line = `- ${item.key}: ${item.value}\n`;
      if (content.length + line.length > maxChars) {
        break;
      }
      content += line;
    }

    return content;
  }

  return {
    async get(category: string, key: string, botId: string): Promise<CoreMemoryEntry | null> {
      const row = db
        .prepare(
          `SELECT ${SELECT_COLS} FROM core_memory WHERE bot_id = ? AND category = ? AND key = ?`
        )
        .get(botId, category, key) as CoreMemoryRow | undefined;
      return row ? rowToEntry(row) : null;
    },

    async set(
      category: string,
      key: string,
      value: string,
      importance = 5,
      botId: string
    ): Promise<void> {
      if (!VALID_CATEGORIES.has(category)) {
        logger.warn({ category, valid: [...VALID_CATEGORIES] }, 'Invalid core memory category');
        throw new Error(
          `Invalid category: ${category}. Must be one of: ${[...VALID_CATEGORIES].join(', ')}`
        );
      }
      if (key.length > 100) {
        throw new Error('Key too long (max 100 characters)');
      }
      if (value.length > 2000) {
        throw new Error('Value too long (max 2000 characters)');
      }
      if (importance < 1 || importance > 10) {
        throw new Error('Importance must be between 1 and 10');
      }

      const existing = await this.get(category, key, botId);

      if (existing) {
        db.prepare(
          'UPDATE core_memory SET value = ?, importance = ?, updated_at = datetime("now") WHERE id = ?'
        ).run(value, importance, existing.id);
        logger.debug({ category, key, importance, botId }, 'Core memory updated');
      } else {
        db.prepare(
          'INSERT INTO core_memory (bot_id, category, key, value, importance) VALUES (?, ?, ?, ?, ?)'
        ).run(botId, category, key, value, importance);
        logger.debug({ category, key, importance, botId }, 'Core memory created');
      }
    },

    async delete(category: string, key: string, botId: string): Promise<boolean> {
      const result = db
        .prepare('DELETE FROM core_memory WHERE bot_id = ? AND category = ? AND key = ?')
        .run(botId, category, key);
      const deleted = result.changes > 0;
      if (deleted) {
        logger.debug({ category, key, botId }, 'Core memory deleted');
      }
      return deleted;
    },

    async search(
      query: string,
      category: string | undefined,
      limit = 10,
      botId: string
    ): Promise<CoreMemoryEntry[]> {
      const pattern = `%${query.replace(/[%_]/g, '\\$&')}%`;

      if (category) {
        const rows = db
          .prepare(
            `SELECT ${SELECT_COLS} FROM core_memory ` +
              'WHERE bot_id = ? AND category = ? AND (key LIKE ? OR value LIKE ?) ' +
              'ORDER BY importance DESC, updated_at DESC LIMIT ?'
          )
          .all(botId, category, pattern, pattern, limit) as CoreMemoryRow[];
        return rows.map(rowToEntry);
      }

      const rows = db
        .prepare(
          `SELECT ${SELECT_COLS} FROM core_memory ` +
            'WHERE bot_id = ? AND (key LIKE ? OR value LIKE ?) ' +
            'ORDER BY importance DESC, updated_at DESC LIMIT ?'
        )
        .all(botId, pattern, pattern, limit) as CoreMemoryRow[];
      return rows.map(rowToEntry);
    },

    async list(
      category: string | undefined,
      minImportance: number | undefined,
      botId: string
    ): Promise<CoreMemoryEntry[]> {
      let rows: CoreMemoryRow[];

      if (category && minImportance !== undefined) {
        rows = db
          .prepare(
            `SELECT ${SELECT_COLS} FROM core_memory ` +
              'WHERE bot_id = ? AND category = ? AND importance >= ? ' +
              'ORDER BY importance DESC, updated_at DESC'
          )
          .all(botId, category, minImportance) as CoreMemoryRow[];
      } else if (category) {
        rows = db
          .prepare(
            `SELECT ${SELECT_COLS} FROM core_memory ` +
              'WHERE bot_id = ? AND category = ? ORDER BY importance DESC, updated_at DESC'
          )
          .all(botId, category) as CoreMemoryRow[];
      } else if (minImportance !== undefined) {
        rows = db
          .prepare(
            `SELECT ${SELECT_COLS} FROM core_memory ` +
              'WHERE bot_id = ? AND importance >= ? ORDER BY importance DESC, updated_at DESC'
          )
          .all(botId, minImportance) as CoreMemoryRow[];
      } else {
        rows = db
          .prepare(
            `SELECT ${SELECT_COLS} FROM core_memory ` +
              'WHERE bot_id = ? ORDER BY importance DESC, updated_at DESC'
          )
          .all(botId) as CoreMemoryRow[];
      }

      return rows.map(rowToEntry);
    },

    renderForSystemPrompt(maxChars = 800, botId: string): string {
      try {
        const rows = db
          .prepare(
            `SELECT ${SELECT_COLS} FROM core_memory ` +
              'WHERE bot_id = ? AND importance >= 5 ORDER BY importance DESC, updated_at DESC LIMIT 20'
          )
          .all(botId) as CoreMemoryRow[];
        const entries = rows.map(rowToEntry);

        if (entries.length === 0) {
          return '';
        }

        let output = '\n\n## Core Memory\n\n';
        let remaining = maxChars - output.length;

        const byCategory = new Map<string, CoreMemoryEntry[]>();
        for (const entry of entries) {
          const list = byCategory.get(entry.category) ?? [];
          list.push(entry);
          byCategory.set(entry.category, list);
        }

        for (const [category, items] of byCategory) {
          const header = `**${category.charAt(0).toUpperCase() + category.slice(1)}**:\n`;
          const content = formatCategory(items, remaining - header.length - 2);
          if (!content) continue;
          const section = `${header + content}\n`;
          if (section.length <= remaining) {
            output += section;
            remaining -= section.length;
          } else {
            break;
          }
        }

        return output;
      } catch (err) {
        logger.warn({ err }, 'Failed to render core memory for system prompt');
        return '';
      }
    },
  };
}
