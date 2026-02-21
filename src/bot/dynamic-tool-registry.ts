import type { Logger } from '../logger';
import type { Tool } from '../tools/types';
import { DynamicToolStore, type DynamicToolMeta } from '../tools/dynamic-tool-store';
import { loadDynamicTool } from '../tools/dynamic-tool-loader';
import type { BotContext } from './types';

/**
 * Runtime registry for dynamic tools.
 * On init, loads all approved tools from disk.
 * Supports hot-loading on approval and removal on rejection.
 */
export class DynamicToolRegistry {
  private loadedTools: Map<string, Tool> = new Map();

  constructor(
    private ctx: BotContext,
    private store: DynamicToolStore,
    private logger: Logger,
  ) {}

  /**
   * Scan store for approved tools and load them into ctx.tools[].
   */
  initialize(): void {
    const allMetas = this.store.list();
    const approved = allMetas.filter((m) => m.status === 'approved');

    for (const meta of approved) {
      this.loadTool(meta);
    }

    if (approved.length > 0) {
      this.logger.info(
        { count: approved.length, names: approved.map((m) => m.name) },
        'Dynamic tools loaded',
      );
    }
  }

  /**
   * Hot-load a tool after approval. Adds to ctx.tools[] and ctx.toolDefinitions[].
   */
  approve(id: string): DynamicToolMeta | null {
    const meta = this.store.updateStatus(id, 'approved');
    if (!meta) return null;

    // Remove existing version if any
    this.removeTool(id);

    this.loadTool(meta);
    this.logger.info({ toolId: id, name: meta.name }, 'Dynamic tool approved and loaded');
    return meta;
  }

  /**
   * Reject a tool. Removes from runtime if previously loaded.
   */
  reject(id: string, note?: string): DynamicToolMeta | null {
    const meta = this.store.updateStatus(id, 'rejected', note);
    if (!meta) return null;

    this.removeTool(id);
    this.logger.info({ toolId: id, name: meta.name }, 'Dynamic tool rejected');
    return meta;
  }

  /**
   * Get dynamic tools available to a specific bot (filters by scope).
   */
  getToolsForBot(botId: string): Tool[] {
    const result: Tool[] = [];
    for (const [id, tool] of this.loadedTools) {
      const entry = this.store.get(id);
      if (!entry) continue;
      if (entry.meta.scope === 'all' || entry.meta.scope === botId || entry.meta.createdBy === botId) {
        result.push(tool);
      }
    }
    return result;
  }

  /**
   * Get the set of dynamic tool names a bot should NOT see (based on scope).
   * A tool is excluded if its scope is not 'all', not the bot's own ID,
   * and the bot didn't create it.
   */
  getExcludedNamesForBot(botId: string): Set<string> {
    const excluded = new Set<string>();
    for (const [id, tool] of this.loadedTools) {
      const entry = this.store.get(id);
      if (!entry) continue;
      const { scope, createdBy } = entry.meta;
      if (scope !== 'all' && scope !== botId && createdBy !== botId) {
        excluded.add(tool.definition.function.name);
      }
    }
    return excluded;
  }

  /**
   * Get definitions for a specific bot.
   */
  getDefinitionsForBot(botId: string): import('../tools/types').ToolDefinition[] {
    return this.getToolsForBot(botId).map((t) => t.definition);
  }

  private loadTool(meta: DynamicToolMeta): void {
    const entry = this.store.get(meta.id);
    if (!entry) return;

    try {
      const storePath = (this.ctx.config as any).dynamicTools?.storePath ?? './data/tools';
      const tool = loadDynamicTool(meta, entry.source, storePath);
      this.loadedTools.set(meta.id, tool);

      // Add to ctx shared arrays
      this.ctx.tools.push(tool);
      this.ctx.toolDefinitions.push(tool.definition);
    } catch (err) {
      this.logger.error(
        { toolId: meta.id, error: err instanceof Error ? err.message : String(err) },
        'Failed to load dynamic tool',
      );
    }
  }

  private removeTool(id: string): void {
    const existing = this.loadedTools.get(id);
    if (!existing) return;

    const name = existing.definition.function.name;

    // Remove from ctx.tools[]
    const toolIdx = this.ctx.tools.findIndex((t) => t.definition.function.name === name);
    if (toolIdx >= 0) this.ctx.tools.splice(toolIdx, 1);

    // Remove from ctx.toolDefinitions[]
    const defIdx = this.ctx.toolDefinitions.findIndex((d) => d.function.name === name);
    if (defIdx >= 0) this.ctx.toolDefinitions.splice(defIdx, 1);

    this.loadedTools.delete(id);
  }
}
