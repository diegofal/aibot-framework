import type { Skill, SkillContext } from '../../core/types';

interface Note {
  id: string;
  content: string;
  tags: string[];
  source: string;
  createdAt: string;
}

interface NotesData {
  notes: Note[];
  lastId: number;
}

const DATA_KEY = 'quick_notes';

function generateId(): string {
  return `note_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

function getNotes(ctx: SkillContext): NotesData {
  const data = ctx.data.get<NotesData>(DATA_KEY);
  return data || { notes: [], lastId: 0 };
}

function saveNotes(ctx: SkillContext, data: NotesData): void {
  ctx.data.set(DATA_KEY, data);
}

export const handlers: Record<
  string,
  (args: Record<string, unknown>, context: SkillContext) => Promise<unknown>
> = {
  async quick_notes_save(args: Record<string, unknown>, ctx: SkillContext): Promise<unknown> {
    const content = String(args.content || '');
    const tags = Array.isArray(args.tags) ? args.tags.map(String) : [];
    const source = String(args.source || 'telegram');

    if (!content.trim()) {
      return { success: false, message: 'Note content cannot be empty' };
    }

    const data = getNotes(ctx);
    const note: Note = {
      id: generateId(),
      content: content.trim(),
      tags,
      source,
      createdAt: new Date().toISOString(),
    };

    data.notes.unshift(note);
    data.lastId++;
    saveNotes(ctx, data);

    ctx.logger.info({ noteId: note.id }, 'Quick note saved');

    return {
      success: true,
      note: {
        id: note.id,
        content: note.content.slice(0, 100) + (note.content.length > 100 ? '...' : ''),
        tags: note.tags,
        createdAt: note.createdAt,
      },
    };
  },

  async quick_notes_list(args: Record<string, unknown>, ctx: SkillContext): Promise<unknown> {
    const limit = Math.min(Math.max(Number(args.limit) || 10, 1), 20);
    const tagFilter = args.tag ? String(args.tag) : null;

    const data = getNotes(ctx);
    let notes = data.notes;

    if (tagFilter) {
      notes = notes.filter((n) => n.tags.includes(tagFilter));
    }

    const result = notes.slice(0, limit);

    return {
      success: true,
      count: result.length,
      total: data.notes.length,
      notes: result.map((n) => ({
        id: n.id,
        content: n.content.slice(0, 150) + (n.content.length > 150 ? '...' : ''),
        tags: n.tags,
        createdAt: n.createdAt,
      })),
    };
  },

  async quick_notes_search(args: Record<string, unknown>, ctx: SkillContext): Promise<unknown> {
    const query = String(args.query || '').toLowerCase();
    const limit = Math.min(Math.max(Number(args.limit) || 10, 1), 10);

    if (!query.trim()) {
      return { success: false, message: 'Search query cannot be empty' };
    }

    const data = getNotes(ctx);
    const results = data.notes
      .filter((n) => n.content.toLowerCase().includes(query))
      .slice(0, limit);

    return {
      success: true,
      query,
      count: results.length,
      notes: results.map((n) => ({
        id: n.id,
        content: n.content.slice(0, 150) + (n.content.length > 150 ? '...' : ''),
        tags: n.tags,
        createdAt: n.createdAt,
      })),
    };
  },

  async quick_notes_delete(args: Record<string, unknown>, ctx: SkillContext): Promise<unknown> {
    const id = String(args.id || '');

    if (!id) {
      return { success: false, message: 'Note ID is required' };
    }

    const data = getNotes(ctx);
    const index = data.notes.findIndex((n) => n.id === id);

    if (index === -1) {
      return { success: false, message: `Note not found: ${id}` };
    }

    const deleted = data.notes.splice(index, 1)[0];
    saveNotes(ctx, data);

    ctx.logger.info({ noteId: id }, 'Quick note deleted');

    return {
      success: true,
      deleted: {
        id: deleted.id,
        content: deleted.content.slice(0, 100) + (deleted.content.length > 100 ? '...' : ''),
      },
    };
  },
};

const skill: Skill = {
  id: 'quick-notes',
  name: 'Quick Notes',
  version: '1.0.0',
  description: 'Fast idea capture via Telegram. Save notes with tags, search, and quick retrieval.',

  async onLoad(ctx: SkillContext) {
    ctx.logger.info('Quick-notes skill loaded');
  },

  async onUnload() {},

  commands: {
    note: {
      description: 'Quick note commands: save <text>, list [tag], search <query>, delete <id>',
      async handler(args: string[], ctx: SkillContext) {
        const subcommand = args[0]?.toLowerCase();
        const rest = args.slice(1).join(' ').trim();

        // /note save <text> or just /note <text>
        if (!subcommand || subcommand === 'save') {
          const content = subcommand === 'save' ? rest : args.join(' ');
          if (!content) {
            return '📝 Usage: /note <text> or /note save <text>';
          }

          // Extract tags: words starting with #
          const tags: string[] = [];
          const cleanContent = content
            .replace(/#(\w+)/g, (match, tag) => {
              tags.push(tag);
              return '';
            })
            .trim();

          const result = (await handlers.quick_notes_save(
            { content: cleanContent, tags },
            ctx
          )) as { success: boolean; note?: { id: string }; message?: string };

          if (result.success) {
            const tagStr = tags.length > 0 ? ` Tags: ${tags.map((t) => `#${t}`).join(' ')}` : '';
            return `✅ Note saved.${tagStr}\nID: \`${result.note?.id}\``;
          }
          return `❌ Failed: ${result.message}`;
        }

        // /note list [tag]
        if (subcommand === 'list' || subcommand === 'ls') {
          const tag = rest || undefined;
          const result = (await handlers.quick_notes_list({ limit: 10, tag }, ctx)) as {
            success: boolean;
            notes: Array<{ id: string; content: string; tags: string[]; createdAt: string }>;
            total: number;
          };

          if (!result.success || result.notes.length === 0) {
            return tag
              ? `📝 No notes found with tag "${tag}".`
              : '📝 No notes yet. Use /note <text> to save one.';
          }

          const header = tag ? `📝 Notes tagged "${tag}"` : '📝 Recent notes';
          const lines = result.notes.map((n) => {
            const tagStr = n.tags.length > 0 ? ` ${n.tags.map((t) => `#${t}`).join(' ')}` : '';
            const date = new Date(n.createdAt).toLocaleDateString('en-US', {
              month: 'short',
              day: 'numeric',
            });
            return `• ${n.content.slice(0, 80)}${n.content.length > 80 ? '...' : ''}${tagStr}\n  \`${n.id}\` · ${date}`;
          });

          return `${header} (${result.notes.length}/${result.total}):\n\n${lines.join('\n\n')}`;
        }

        // /note search <query>
        if (subcommand === 'search' || subcommand === 'find') {
          if (!rest) {
            return '🔍 Usage: /note search <query>';
          }

          const result = (await handlers.quick_notes_search({ query: rest, limit: 10 }, ctx)) as {
            success: boolean;
            notes: Array<{ id: string; content: string; tags: string[]; createdAt: string }>;
            count: number;
          };

          if (!result.success || result.count === 0) {
            return `🔍 No notes found for "${rest}".`;
          }

          const lines = result.notes.map((n) => {
            const tagStr = n.tags.length > 0 ? ` ${n.tags.map((t) => `#${t}`).join(' ')}` : '';
            const date = new Date(n.createdAt).toLocaleDateString('en-US', {
              month: 'short',
              day: 'numeric',
            });
            return `• ${n.content.slice(0, 80)}${n.content.length > 80 ? '...' : ''}${tagStr}\n  \`${n.id}\` · ${date}`;
          });

          return `🔍 Found ${result.count} note(s) for "${rest}":\n\n${lines.join('\n\n')}`;
        }

        // /note delete <id>
        if (subcommand === 'delete' || subcommand === 'del' || subcommand === 'rm') {
          if (!rest) {
            return '🗑️ Usage: /note delete <id>';
          }

          const result = (await handlers.quick_notes_delete({ id: rest }, ctx)) as {
            success: boolean;
            deleted?: { id: string };
            message?: string;
          };

          if (result.success) {
            return `🗑️ Deleted: ${result.deleted?.id}`;
          }
          return `❌ ${result.message}`;
        }

        // /note tags - list all tags
        if (subcommand === 'tags') {
          const data = getNotes(ctx);
          const allTags = new Set<string>();
          data.notes.forEach((n) => n.tags.forEach((t) => allTags.add(t)));

          if (allTags.size === 0) {
            return '🏷️ No tags yet. Add tags with #hashtag in your notes.';
          }

          const tagCounts: Record<string, number> = {};
          data.notes.forEach((n) => {
            n.tags.forEach((t) => {
              tagCounts[t] = (tagCounts[t] || 0) + 1;
            });
          });

          const sorted = Object.entries(tagCounts).sort((a, b) => b[1] - a[1]);
          const lines = sorted.map(([tag, count]) => `• #${tag} (${count})`);

          return `🏷️ Tags (${allTags.size}):\n\n${lines.join('\n')}`;
        }

        return `📝 Quick Notes

Commands:
• /note <text> — Save a quick note
• /note list — Show recent notes
• /note list <tag> — Filter by tag
• /note search <query> — Search notes
• /note tags — List all tags
• /note delete <id> — Delete a note

Tip: Add #hashtags anywhere in your note.`;
      },
    },
  },
};

export default skill;
