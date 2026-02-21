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
  get(category: string, key: string): Promise<CoreMemoryEntry | null>;

  /** Set (insert or update) an entry */
  set(category: string, key: string, value: string, importance?: number): Promise<void>;

  /** Delete an entry */
  delete(category: string, key: string): Promise<boolean>;

  /** Search entries by query string (matches key or value) */
  search(query: string, category?: string, limit?: number): Promise<CoreMemoryEntry[]>;

  /** List entries, optionally filtered by category and minimum importance */
  list(category?: string, minImportance?: number): Promise<CoreMemoryEntry[]>;

  /** Render formatted core memory block for system prompt injection */
  renderForSystemPrompt(maxChars?: number): string;
}

type CoreMemoryRow = {
  id: number;
  category: string;
  key: string;
  value: string;
  importance: number;
  created_at: string;
  updated_at: string;
};

const VALID_CATEGORIES = new Set([
  'identity',      // Who the bot is (name, description, values, style)
  'relationships', // Data about specific users
  'preferences',   // Bot's own preferences
  'goals',         // Long-term objectives
  'constraints',   // Self-imposed limits
]);

export function createCoreMemoryManager(db: Database, logger: Logger): CoreMemoryManager {
  // Prepared statements (created lazily)
  let stmtGet: ReturnType<Database['prepare']> | null = null;
  let stmtInsert: ReturnType<Database['prepare']> | null = null;
  let stmtUpdate: ReturnType<Database['prepare']> | null = null;
  let stmtDelete: ReturnType<Database['prepare']> | null = null;
  let stmtSearch: ReturnType<Database['prepare']> | null = null;
  let stmtList: ReturnType<Database['prepare']> | null = null;
  let stmtListByCategory: ReturnType<Database['prepare']> | null = null;
  let stmtListByImportance: ReturnType<Database['prepare']> | null = null;
  let stmtListByCategoryAndImportance: ReturnType<Database['prepare']> | null = null;

  function getStmt(sql: string): ReturnType<Database['prepare']> {
    return db.prepare(sql);
  }

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

    for (const item of items.slice(0, 5)) { // max 5 items per category
      const line = `- ${item.key}: ${item.value}\n`;
      if (content.length + line.length > maxChars) {
        break;
      }
      content += line;
    }

    return content;
  }

  return {
    async get(category: string, key: string): Promise<CoreMemoryEntry | null> {
      if (!stmtGet) {
        stmtGet = getStmt(
          'SELECT id, category, key, value, importance, created_at, updated_at FROM core_memory WHERE category = ? AND key = ?'
        );
      }
      const row = stmtGet.get(category, key) as CoreMemoryRow | undefined;
      return row ? rowToEntry(row) : null;
    },

    async set(category: string, key: string, value: string, importance = 5): Promise<void> {
      if (!VALID_CATEGORIES.has(category)) {
        logger.warn({ category, valid: [...VALID_CATEGORIES] }, 'Invalid core memory category');
        throw new Error(`Invalid category: ${category}. Must be one of: ${[...VALID_CATEGORIES].join(', ')}`);
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

      const existing = await this.get(category, key);

      if (existing) {
        if (!stmtUpdate) {
          stmtUpdate = getStmt(
            'UPDATE core_memory SET value = ?, importance = ?, updated_at = datetime("now") WHERE id = ?'
          );
        }
        stmtUpdate.run(value, importance, existing.id);
        logger.debug({ category, key, importance }, 'Core memory updated');
      } else {
        if (!stmtInsert) {
          stmtInsert = getStmt(
            'INSERT INTO core_memory (category, key, value, importance) VALUES (?, ?, ?, ?)'
          );
        }
        stmtInsert.run(category, key, value, importance);
        logger.debug({ category, key, importance }, 'Core memory created');
      }
    },

    async delete(category: string, key: string): Promise<boolean> {
      if (!stmtDelete) {
        stmtDelete = getStmt('DELETE FROM core_memory WHERE category = ? AND key = ?');
      }
      const result = stmtDelete.run(category, key);
      const deleted = result.changes > 0;
      if (deleted) {
        logger.debug({ category, key }, 'Core memory deleted');
      }
      return deleted;
    },

    async search(query: string, category?: string, limit = 10): Promise<CoreMemoryEntry[]> {
      const pattern = `%${query.replace(/[%_]/g, '\\$&')}%`;

      if (category) {
        if (!stmtListByCategory) {
          stmtListByCategory = getStmt(
            'SELECT id, category, key, value, importance, created_at, updated_at FROM core_memory ' +
            'WHERE category = ? AND (key LIKE ? OR value LIKE ?) ' +
            'ORDER BY importance DESC, updated_at DESC LIMIT ?'
          );
        }
        const rows = stmtListByCategory.all(category, pattern, pattern, limit) as CoreMemoryRow[];
        return rows.map(rowToEntry);
      }

      if (!stmtSearch) {
        stmtSearch = getStmt(
          'SELECT id, category, key, value, importance, created_at, updated_at FROM core_memory ' +
          'WHERE key LIKE ? OR value LIKE ? ' +
          'ORDER BY importance DESC, updated_at DESC LIMIT ?'
        );
      }
      const rows = stmtSearch.all(pattern, pattern, limit) as CoreMemoryRow[];
      return rows.map(rowToEntry);
    },

    async list(category?: string, minImportance?: number): Promise<CoreMemoryEntry[]> {
      let rows: CoreMemoryRow[];

      if (category && minImportance !== undefined) {
        if (!stmtListByCategoryAndImportance) {
          stmtListByCategoryAndImportance = getStmt(
            'SELECT id, category, key, value, importance, created_at, updated_at FROM core_memory ' +
            'WHERE category = ? AND importance >= ? ' +
            'ORDER BY importance DESC, updated_at DESC'
          );
        }
        rows = stmtListByCategoryAndImportance.all(category, minImportance) as CoreMemoryRow[];
      } else if (category) {
        if (!stmtListByCategory) {
          stmtListByCategory = getStmt(
            'SELECT id, category, key, value, importance, created_at, updated_at FROM core_memory ' +
            'WHERE category = ? ORDER BY importance DESC, updated_at DESC'
          );
        }
        rows = stmtListByCategory.all(category) as CoreMemoryRow[];
      } else if (minImportance !== undefined) {
        if (!stmtListByImportance) {
          stmtListByImportance = getStmt(
            'SELECT id, category, key, value, importance, created_at, updated_at FROM core_memory ' +
            'WHERE importance >= ? ORDER BY importance DESC, updated_at DESC'
          );
        }
        rows = stmtListByImportance.all(minImportance) as CoreMemoryRow[];
      } else {
        if (!stmtList) {
          stmtList = getStmt(
            'SELECT id, category, key, value, importance, created_at, updated_at FROM core_memory ' +
            'ORDER BY importance DESC, updated_at DESC'
          );
        }
        rows = stmtList.all() as CoreMemoryRow[];
      }

      return rows.map(rowToEntry);
    },

    renderForSystemPrompt(maxChars = 800): string {
      try {
        // Get entries ordered by importance, limit to fit maxChars
        // Note: This is synchronous for system prompt building, so we use a synchronous query
        const stmt = db.prepare(
          'SELECT id, category, key, value, importance, created_at, updated_at FROM core_memory ' +
          'WHERE importance >= 5 ORDER BY importance DESC, updated_at DESC LIMIT 20'
        );
        const rows = stmt.all() as CoreMemoryRow[];
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
          const section = header + content + '\n';
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
