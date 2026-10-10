/**
 * Agent Home API.
 *
 *   GET /api/agents/presence       fleet map id -> presence + karma + last output (cached 3 s)
 *   GET /api/agents/:id/home       everything the agent's home page needs (cached 15 s)
 *   GET /api/agents/:id/presence   posture + first-person "now" line (never cached)
 *   POST /api/agents/:id/goals     operator adds a goal to GOALS.md (`source: operator`)
 *   PATCH /api/agents/:id/goals    operator moves a goal on the board ({ goal, status })
 *   GET /api/agents/:id/goals/detail?id=&title=&days=   one goal's history (cached 15 s)
 *
 * Reads are tenant-scoped like /api/stats and never throw on missing data. The
 * writes go to the Active section through the goals tool's
 * parser/serializer, backs the file up first, and drops the cache.
 * Mounted BEFORE the CRUD agents routes in server.ts: their `GET /:id` would
 * otherwise answer `/presence` with "Agent not found". `/:id/home` and
 * `/:id/presence` do not collide with `/:id`.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Hono } from 'hono';
import { writeGoalsFile } from '../../bot/goal-events';
import type { Config } from '../../config';
import { localDateStr } from '../../date-utils';
import type { Logger } from '../../logger';
import { backupSoulFile } from '../../soul';
import {
  type AgentHomeDeps,
  FLEET_PRESENCE_TTL_MS,
  HOME_CACHE_TTL_MS,
  type HomeKarmaSource,
  buildAgentHome,
  buildFleetPresence,
  buildPresence,
} from '../../stats/agent-home-aggregator';
import { type StatsBotManager, createStatsContext } from '../../stats/context';
import { buildGoalDetail } from '../../stats/goal-detail-aggregator';
import { resolveBotPaths } from '../../stats/paths';
import type { PresenceTracker } from '../../stats/presence-tracker';
import { getTenantId, isBotAccessible, scopeBots } from '../../tenant/tenant-scoping';
import {
  BOARD_STATUSES,
  type BoardStatus,
  type GoalEdits,
  type GoalTask,
  appendGoal,
  editGoal,
  parseGoals,
  removeGoal,
  resolveGoalRef,
  setGoalStatus,
} from '../../tools/goals';

export const GOAL_TITLE_MAX = 200;
export const GOAL_NOTES_MAX = 600;
const GOAL_PRIORITIES = ['low', 'medium', 'high'] as const;

type GoalInput = { title: string; notes?: string; priority: string };

/** Validate the operator's goal; a string is the 400 message. */
export function parseGoalInput(body: unknown): GoalInput | string {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const title = typeof b.title === 'string' ? b.title.trim() : '';
  if (!title) return 'title is required';
  if (/[\r\n]/.test(title)) return 'title must be a single line';
  if (title.length > GOAL_TITLE_MAX) return `title is longer than ${GOAL_TITLE_MAX} characters`;
  const rawNotes = typeof b.notes === 'string' ? b.notes.replace(/\s*[\r\n]+\s*/g, ' ').trim() : '';
  if (rawNotes.length > GOAL_NOTES_MAX) return `notes are longer than ${GOAL_NOTES_MAX} characters`;
  const priority = b.priority === undefined || b.priority === '' ? 'medium' : String(b.priority);
  if (!(GOAL_PRIORITIES as readonly string[]).includes(priority))
    return `priority must be one of ${GOAL_PRIORITIES.join(', ')}`;
  return { title, notes: rawNotes || undefined, priority };
}

/** Validate a drawer edit; a string is the 400 message. */
/** Subtask limits: enough for a real checklist, small enough to stay readable in a prompt. */
export const GOAL_TASKS_MAX = 30;
export const GOAL_TASK_TEXT_MAX = 200;

/** `tasks` from a request body → a clean list, or an error message. */
export function parseGoalTasks(value: unknown): GoalTask[] | string {
  if (!Array.isArray(value)) return 'tasks must be an array of { text, done }';
  if (value.length > GOAL_TASKS_MAX) return `at most ${GOAL_TASKS_MAX} tasks per goal`;
  const out: GoalTask[] = [];
  for (const raw of value) {
    const t = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    const text = typeof t.text === 'string' ? t.text.trim() : '';
    if (!text) return 'a task cannot be empty';
    if (/[\r\n]/.test(text)) return 'a task must be a single line';
    if (text.length > GOAL_TASK_TEXT_MAX)
      return `a task is longer than ${GOAL_TASK_TEXT_MAX} characters`;
    if (typeof t.done !== 'boolean') return 'task done must be true or false';
    out.push({ text, done: t.done });
  }
  return out;
}

export function parseGoalEdits(body: unknown): GoalEdits | string {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const out: GoalEdits = {};
  if (b.title !== undefined) {
    const title = typeof b.title === 'string' ? b.title.trim() : '';
    if (!title) return 'title cannot be empty';
    if (/[\r\n]/.test(title)) return 'title must be a single line';
    if (title.length > GOAL_TITLE_MAX) return `title is longer than ${GOAL_TITLE_MAX} characters`;
    out.text = title;
  }
  if (b.notes !== undefined) {
    const notes = typeof b.notes === 'string' ? b.notes.replace(/\s*[\r\n]+\s*/g, ' ').trim() : '';
    if (notes.length > GOAL_NOTES_MAX) return `notes are longer than ${GOAL_NOTES_MAX} characters`;
    out.notes = notes;
  }
  if (b.priority !== undefined) {
    const priority = String(b.priority);
    if (!(GOAL_PRIORITIES as readonly string[]).includes(priority))
      return `priority must be one of ${GOAL_PRIORITIES.join(', ')}`;
    out.priority = priority;
  }
  if (b.tasks !== undefined) {
    const tasks = parseGoalTasks(b.tasks);
    if (typeof tasks === 'string') return tasks;
    out.tasks = tasks;
  }
  if (Object.keys(out).length === 0)
    return 'nothing to change: send status, title, notes, priority or tasks';
  return out;
}

export interface AgentHomeRouteDeps {
  config: Config;
  botManager: StatsBotManager & { isRunning?(botId: string): boolean };
  logger: Logger;
  karmaService?: HomeKarmaSource;
  presence?: PresenceTracker;
  pendingPermissions?: (botId: string) => number;
  /** Injectable clock (tests). */
  now?: () => number;
  cacheTtlMs?: number;
}

export function agentHomeRoutes(deps: AgentHomeRouteDeps) {
  const app = new Hono();
  const ctx = createStatsContext({
    config: deps.config,
    botManager: deps.botManager,
    now: deps.now,
  });
  const ttl = deps.cacheTtlMs ?? HOME_CACHE_TTL_MS;
  const homeDeps: AgentHomeDeps = {
    karma: deps.karmaService,
    presence: deps.presence ? (id) => deps.presence?.get(id) ?? undefined : undefined,
    isRunning: (id) => deps.botManager.isRunning?.(id) ?? false,
    pendingPermissions: deps.pendingPermissions,
  } as AgentHomeDeps;

  const findBot = (c: import('hono').Context) => {
    const id = c.req.param('id');
    const bot = deps.config.bots.find((b) => b.id === id);
    if (!bot || !isBotAccessible(bot, getTenantId(c))) return null;
    return bot;
  };

  // Literal path first: with a bot whose id is "presence" the fleet map still wins.
  app.get('/presence', (c) => {
    const tenantId = getTenantId(c);
    const bots = scopeBots(deps.config.bots, tenantId);
    try {
      const body = ctx.cache.get(`fleet-presence:${tenantId ?? '*'}`, FLEET_PRESENCE_TTL_MS, () =>
        buildFleetPresence(ctx, bots, homeDeps)
      );
      return c.json(body);
    } catch (err) {
      deps.logger.warn({ err }, 'Fleet presence aggregation failed');
      return c.json({ error: 'Fleet presence aggregation failed' }, 500);
    }
  });

  app.get('/:id/home', (c) => {
    const bot = findBot(c);
    if (!bot) return c.json({ error: 'Bot not found' }, 404);
    try {
      const body = ctx.cache.get(`home:${bot.id}`, ttl, () => buildAgentHome(ctx, bot, homeDeps));
      return c.json(body);
    } catch (err) {
      deps.logger.warn({ err, botId: bot.id }, 'Agent home aggregation failed');
      return c.json({ error: 'Agent home aggregation failed' }, 500);
    }
  });

  app.get('/:id/presence', (c) => {
    const bot = findBot(c);
    if (!bot) return c.json({ error: 'Bot not found' }, 404);
    try {
      return c.json(buildPresence(ctx, bot, homeDeps));
    } catch (err) {
      deps.logger.warn({ err, botId: bot.id }, 'Agent presence failed');
      return c.json({ error: 'Agent presence failed' }, 500);
    }
  });

  app.get('/:id/goals/detail', (c) => {
    const bot = findBot(c);
    if (!bot) return c.json({ error: 'Bot not found' }, 404);
    const id = c.req.query('id')?.trim() || null;
    const title = c.req.query('title')?.trim() || null;
    if (!id && !title) return c.json({ error: 'id or title is required' }, 400);
    const days = Number(c.req.query('days')) || undefined;
    try {
      const body = ctx.cache.get(
        `goal:${bot.id}:${id ?? ''}:${title ?? ''}:${days ?? ''}`,
        ttl,
        () => buildGoalDetail(ctx, bot, { id, title, days })
      );
      if (!body) return c.json({ error: 'Goal not found' }, 404);
      return c.json(body);
    } catch (err) {
      deps.logger.warn({ err, botId: bot.id }, 'Goal detail aggregation failed');
      return c.json({ error: 'Goal detail aggregation failed' }, 500);
    }
  });

  app.post('/:id/goals', async (c) => {
    const bot = findBot(c);
    if (!bot) return c.json({ error: 'Bot not found' }, 404);
    const input = parseGoalInput(await c.req.json().catch(() => null));
    if (typeof input === 'string') return c.json({ error: input }, 400);

    const { soulDir } = resolveBotPaths(deps.config, bot);
    if (!existsSync(soulDir)) return c.json({ error: 'Agent has no soul directory' }, 409);
    const goalsPath = join(soulDir, 'GOALS.md');
    const goal = {
      text: input.title,
      status: 'pending',
      priority: input.priority,
      notes: input.notes,
      source: 'operator',
      created: localDateStr(),
    };
    try {
      const current = existsSync(goalsPath) ? readFileSync(goalsPath, 'utf-8') : null;
      writeGoalsFile(goalsPath, appendGoal(current, goal), {
        actor: 'operator',
        backup: (p) => backupSoulFile(p, deps.logger),
      });
    } catch (err) {
      deps.logger.warn({ err, botId: bot.id }, 'Adding operator goal failed');
      return c.json({ error: 'Could not write GOALS.md' }, 500);
    }
    ctx.cache.invalidate();
    deps.logger.info({ botId: bot.id, goal: goal.text }, 'Operator goal added');
    return c.json({ goal }, 201);
  });

  /**
   * PATCH /:id/goals — `{ goal | id, status }` moves a goal on the board;
   * `{ goal | id, title?, notes?, priority? }` edits it (drawer). Both by the operator.
   */
  app.patch('/:id/goals', async (c) => {
    const bot = findBot(c);
    if (!bot) return c.json({ error: 'Bot not found' }, 404);
    const b = ((await c.req.json().catch(() => null)) ?? {}) as Record<string, unknown>;
    const ref =
      typeof b.id === 'string' && b.id.trim()
        ? b.id.trim()
        : typeof b.goal === 'string'
          ? b.goal.trim()
          : '';
    if (!ref) return c.json({ error: 'goal or id is required' }, 400);

    const goalsPath = join(resolveBotPaths(deps.config, bot).soulDir, 'GOALS.md');
    const write = (content: string) =>
      writeGoalsFile(goalsPath, content, {
        actor: 'operator',
        backup: (p) => backupSoulFile(p, deps.logger),
      });
    const read = () => (existsSync(goalsPath) ? readFileSync(goalsPath, 'utf-8') : null);

    let next: string | null;
    let summary: Record<string, unknown>;
    if (b.status !== undefined) {
      const status = String(b.status) as BoardStatus;
      if (!BOARD_STATUSES.includes(status))
        return c.json({ error: `status must be one of ${BOARD_STATUSES.join(', ')}` }, 400);
      const current = read();
      const target = resolveGoalRef(ref, [
        ...parseGoals(current).active,
        ...parseGoals(current).completed,
      ]);
      next = setGoalStatus(current, target?.text ?? ref, status);
      summary = { goal: target?.text ?? ref, status };
    } else {
      const edits = parseGoalEdits(b);
      if (typeof edits === 'string') return c.json({ error: edits }, 400);
      // A goal without an id gets one first (no event), so a rename stays one `title` event.
      const before = read();
      const all = [...parseGoals(before).active, ...parseGoals(before).completed];
      const target = all.find((g) => g.id === ref) ?? resolveGoalRef(ref, all);
      if (!target) return c.json({ error: 'Goal not found' }, 404);
      let current = before;
      let key = target.id ?? target.text;
      if (!target.id && before !== null) {
        try {
          current = write(before);
        } catch (err) {
          deps.logger.warn({ err, botId: bot.id }, 'Assigning goal ids failed');
          return c.json({ error: 'Could not write GOALS.md' }, 500);
        }
        const fresh = [...parseGoals(current).active, ...parseGoals(current).completed].find(
          (g) => g.text === target.text
        );
        key = fresh?.id ?? target.text;
      }
      next = editGoal(current, key, edits);
      summary = { goal: edits.text ?? target.text, ...edits };
    }
    if (next === null) return c.json({ error: 'Goal not found' }, 404);
    try {
      write(next);
    } catch (err) {
      deps.logger.warn({ err, botId: bot.id }, 'Updating goal failed');
      return c.json({ error: 'Could not write GOALS.md' }, 500);
    }
    ctx.cache.invalidate();
    deps.logger.info({ botId: bot.id, ...summary }, 'Operator updated goal');
    return c.json(summary);
  });

  /** DELETE /:id/goals — `{ id | goal }`: the operator removes a goal (logged as a `remove` event). */
  app.delete('/:id/goals', async (c) => {
    const bot = findBot(c);
    if (!bot) return c.json({ error: 'Bot not found' }, 404);
    const b = ((await c.req.json().catch(() => null)) ?? {}) as Record<string, unknown>;
    const ref =
      typeof b.id === 'string' && b.id.trim()
        ? b.id.trim()
        : typeof b.goal === 'string'
          ? b.goal.trim()
          : '';
    if (!ref) return c.json({ error: 'goal or id is required' }, 400);
    const goalsPath = join(resolveBotPaths(deps.config, bot).soulDir, 'GOALS.md');
    const current = existsSync(goalsPath) ? readFileSync(goalsPath, 'utf-8') : null;
    const next = removeGoal(current, ref);
    if (next === null) return c.json({ error: 'Goal not found' }, 404);
    try {
      writeGoalsFile(goalsPath, next, {
        actor: 'operator',
        backup: (p) => backupSoulFile(p, deps.logger),
      });
    } catch (err) {
      deps.logger.warn({ err, botId: bot.id }, 'Removing goal failed');
      return c.json({ error: 'Could not write GOALS.md' }, 500);
    }
    ctx.cache.invalidate();
    deps.logger.info({ botId: bot.id, goal: ref }, 'Operator removed goal');
    return c.json({ removed: ref });
  });
  return app;
}
