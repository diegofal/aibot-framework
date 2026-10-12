/**
 * Agent Home API.
 *
 *   GET /api/agents/presence       fleet map id -> presence + karma + last output (cached 3 s)
 *   GET /api/agents/:id/home       everything the agent's home page needs (cached 15 s)
 *   GET /api/agents/:id/presence   posture + first-person "now" line (never cached)
 *   POST /api/agents/:id/goals     operator adds a goal to GOALS.md (`source: operator`)
 *   PATCH /api/agents/:id/goals    operator moves a goal on the board ({ goal, status }); `tasks` is retired (400)
 *   POST /api/agents/:id/goals/:goalId/tasks           add a task ({ text, lane?, expectedRev? })
 *   POST /api/agents/:id/goals/:goalId/tasks/reorder   order a goal's tasks ({ ids, expectedRev? })
 *   PATCH /api/agents/:id/tasks/:taskId                move / rename / note ({ lane?, text?, note?, expectedRev? })
 *   DELETE /api/agents/:id/tasks/:taskId               remove a task (`?rev=` or { expectedRev })
 *     Task ops go through the task store (src/goals/task-store.ts); every response
 *     carries `rev`, a stale `expectedRev` is 409 { error, rev }.
 *   GET /api/agents/:id/goals/detail?id=&title=&days=   one goal's history (cached 15 s)
 *   GET /api/agents/:id/cycles/:cycleId   one agent-loop cycle, the "Open cycle" sheet (cached 15 s)
 *   GET /api/agents/:id/memory-history?limit=   memory/soul edits (`soul-events.jsonl`), newest first, each with its why (not cached)
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
import { type SoulEvent, readSoulEvents } from '../../bot/soul-events';
import type { Config } from '../../config';
import { localDateStr } from '../../date-utils';
import { closeGoalTasks } from '../../goals/goal-closure';
import { TASK_LANES, type TaskLane, type TaskOp, TaskStore } from '../../goals/task-store';
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
import { buildCycleDetail } from '../../stats/cycle-detail';
import { buildGoalDetail } from '../../stats/goal-detail-aggregator';
import { resolveBotPaths } from '../../stats/paths';
import type { PresenceTracker } from '../../stats/presence-tracker';
import { readAgentCycles } from '../../stats/readers/agent-cycles';
import { toTaskView } from '../../stats/readers/soul';
import { getTenantId, isBotAccessible, scopeBots } from '../../tenant/tenant-scoping';
import {
  BOARD_STATUSES,
  type BoardStatus,
  type GoalEdits,
  appendGoal,
  editGoal,
  parseGoals,
  removeGoal,
  resolveGoalRef,
  setGoalStatus,
} from '../../tools/goals';
import { soulEventToWhy } from '../../why/builders/soul-event';
import { CycleIndex } from '../../why/cycle-index';
import type { Why } from '../../why/types';
import type { WorkerPoolApi } from '../../workers/types';

/** Reason stamped on goal events the operator makes from the dashboard. */
const OPERATOR_GOAL_REASON = 'You, from the dashboard';
export const GOAL_TITLE_MAX = 200;
export const MEMORY_HISTORY_DEFAULT_LIMIT = 50;
export const MEMORY_HISTORY_MAX_LIMIT = 200;

export interface MemoryHistoryResponse {
  botId: string;
  /** Newest first. */
  events: Array<SoulEvent & { why: Why }>;
  /** Rows in the log, before `limit`. */
  total: number;
}
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

export const GOAL_HEADLINE_MAX = 100;
/** The full goal text the agent reads; agents already write briefs of ~500 chars. */
export const GOAL_BRIEF_MAX = 1000;

/** `PATCH /goals { tasks }` is retired: tasks change one op at a time. */
export const TASKS_RETIRED_MESSAGE =
  'tasks are no longer sent as a list: use POST /api/agents/:id/goals/:goalId/tasks, PATCH or DELETE /api/agents/:id/tasks/:taskId, and POST /api/agents/:id/goals/:goalId/tasks/reorder';

/** Validate a drawer edit; a string is the 400 message. */
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
  if (b.headline !== undefined) {
    const raw = typeof b.headline === 'string' ? b.headline.trim() : '';
    if (/[\r\n]/.test(raw)) return 'headline must be a single line';
    const headline = raw.replace(/\s+/g, ' ');
    if (headline.length > GOAL_HEADLINE_MAX)
      return `headline is longer than ${GOAL_HEADLINE_MAX} characters`;
    out.headline = headline;
  }
  if (b.brief !== undefined) {
    const brief = typeof b.brief === 'string' ? b.brief.replace(/\s*[\r\n]+\s*/g, ' ').trim() : '';
    if (!brief) return 'brief cannot be empty';
    if (brief.length > GOAL_BRIEF_MAX) return `brief is longer than ${GOAL_BRIEF_MAX} characters`;
    out.text = brief;
  }
  if (b.tasks !== undefined) return TASKS_RETIRED_MESSAGE;
  if (Object.keys(out).length === 0)
    return 'nothing to change: send status, title, brief, headline, notes or priority';
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
  /** The task worker pool, when wired: a goal the operator closes stops its runs (C21). */
  workerPool?: () => Pick<WorkerPoolApi, 'list' | 'stop'> | null | undefined;
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

  /** A goal the operator completed or removed: stop its runs, release its claims. Never throws. */
  const closeGoal = (botId: string, soulDir: string, goalId: string | undefined) => {
    if (!goalId) return;
    let pool: Pick<WorkerPoolApi, 'list' | 'stop'> | null | undefined;
    try {
      pool = deps.workerPool?.();
    } catch {
      pool = undefined;
    }
    const closed = closeGoalTasks({
      botId,
      goalIds: [goalId],
      store: taskStoreFor(soulDir),
      pool,
      onError: (err) => deps.logger.warn({ err, botId, goalId }, 'Closing goal tasks failed'),
    });
    if (closed.stopped.length + closed.released.length > 0)
      deps.logger.info({ botId, goalId, ...closed }, 'Operator closed a goal: workers stopped');
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

  app.get('/:id/cycles/:cycleId', (c) => {
    const bot = findBot(c);
    if (!bot) return c.json({ error: 'Bot not found' }, 404);
    const cycleId = c.req.param('cycleId');
    try {
      const body = ctx.cache.get(`cycle:${bot.id}:${cycleId}`, ttl, () =>
        buildCycleDetail(ctx, bot, cycleId)
      );
      if (!body) return c.json({ error: 'Cycle not found' }, 404);
      return c.json(body);
    } catch (err) {
      deps.logger.warn({ err, botId: bot.id, cycleId }, 'Cycle detail aggregation failed');
      return c.json({ error: 'Cycle detail aggregation failed' }, 500);
    }
  });

  app.get('/:id/memory-history', (c) => {
    const bot = findBot(c);
    if (!bot) return c.json({ error: 'Bot not found' }, 404);
    const asked = Number(c.req.query('limit'));
    const limit =
      Number.isFinite(asked) && asked > 0
        ? Math.min(Math.floor(asked), MEMORY_HISTORY_MAX_LIMIT)
        : MEMORY_HISTORY_DEFAULT_LIMIT;
    try {
      const all = readSoulEvents(resolveBotPaths(deps.config, bot).soulDir);
      const rows = all.slice(-limit).reverse();
      const withCycle = rows.filter((e) => e.cycleId);
      const index = CycleIndex.for(
        withCycle.length > 0
          ? (b, s, u) => readAgentCycles(ctx.dirs.agentCycles, b, s, u)
          : undefined,
        withCycle.map((e) => ({ botId: bot.id, at: e.ts }))
      );
      const events = rows.map((event) => {
        const cycle = event.cycleId ? index.byId(bot.id, event.cycleId) : undefined;
        return {
          ...event,
          why: soulEventToWhy({ botId: bot.id, event, ...(cycle ? { cycle } : {}) }),
        };
      });
      const body: MemoryHistoryResponse = { botId: bot.id, events, total: all.length };
      return c.json(body);
    } catch (err) {
      deps.logger.warn({ err, botId: bot.id }, 'Memory history failed');
      return c.json({ error: 'Memory history failed' }, 500);
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
        reason: OPERATOR_GOAL_REASON,
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

    const soulDir = resolveBotPaths(deps.config, bot).soulDir;
    const goalsPath = join(soulDir, 'GOALS.md');
    let closingGoalId: string | undefined;
    const write = (content: string) =>
      writeGoalsFile(goalsPath, content, {
        actor: 'operator',
        reason: OPERATOR_GOAL_REASON,
        backup: (p) => backupSoulFile(p, deps.logger),
      });
    const read = () => (existsSync(goalsPath) ? readFileSync(goalsPath, 'utf-8') : null);

    if (b.tasks !== undefined) return c.json({ error: TASKS_RETIRED_MESSAGE }, 400);
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
      if (status === 'done') closingGoalId = target?.id;
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
    closeGoal(bot.id, soulDir, closingGoalId);
    ctx.cache.invalidate();
    deps.logger.info({ botId: bot.id, ...summary }, 'Operator updated goal');
    return c.json(summary);
  });

  // ── Task ops (the task store, TASKS.json). Every response carries the store `rev`. ──

  const taskStoreFor = (soulDir: string) =>
    new TaskStore(soulDir, {
      backup: (p) => backupSoulFile(p, deps.logger),
      onError: (err) => deps.logger.warn({ err }, 'Task store: warning'),
    });

  /** `{ status, body }` for a failed apply. */
  const taskFailure = (r: { reason: string; message: string; rev: number }) => {
    const status =
      r.reason === 'conflict' || r.reason === 'claimed'
        ? 409
        : r.reason === 'not-found'
          ? 404
          : 400;
    return {
      status: status as 400 | 404 | 409,
      body: { error: r.message, reason: r.reason, rev: r.rev },
    };
  };

  /**
   * The id of the goal `ref` names (an id, or a title for a goal written before
   * ids). A goal without an id gets one first, as its own write (no events).
   */
  const goalIdFor = (soulDir: string, ref: string): string | null => {
    const goalsPath = join(soulDir, 'GOALS.md');
    if (!existsSync(goalsPath)) return null;
    const read = () => readFileSync(goalsPath, 'utf-8');
    const find = (content: string) => {
      const { active, completed } = parseGoals(content);
      const all = [...active, ...completed];
      return all.find((g) => g.id === ref) ?? resolveGoalRef(ref, all);
    };
    const goal = find(read());
    if (!goal) return null;
    if (goal.id) return goal.id;
    const written = writeGoalsFile(goalsPath, read(), {
      actor: 'operator',
      reason: OPERATOR_GOAL_REASON,
      backup: (p) => backupSoulFile(p, deps.logger),
    });
    const fresh = [...parseGoals(written).active, ...parseGoals(written).completed].find(
      (g) => g.text === goal.text
    );
    return fresh?.id ?? null;
  };

  const readBody = async (c: import('hono').Context) =>
    ((await c.req.json().catch(() => null)) ?? {}) as Record<string, unknown>;

  /** `expectedRev` from a body (number) or `?rev=`; undefined when absent, null when malformed. */
  const expectedRevOf = (c: import('hono').Context, b: Record<string, unknown>) => {
    const raw = b.expectedRev ?? c.req.query('rev');
    if (raw === undefined || raw === '') return undefined;
    const n = Number(raw);
    return Number.isInteger(n) && n >= 0 ? n : null;
  };

  app.post('/:id/goals/:goalId/tasks/reorder', async (c) => {
    const bot = findBot(c);
    if (!bot) return c.json({ error: 'Bot not found' }, 404);
    const b = await readBody(c);
    const expectedRev = expectedRevOf(c, b);
    if (expectedRev === null)
      return c.json({ error: 'expectedRev must be a revision number' }, 400);
    if (!Array.isArray(b.ids) || !b.ids.every((x) => typeof x === 'string'))
      return c.json({ error: 'ids must be an array of task ids' }, 400);
    const { soulDir } = resolveBotPaths(deps.config, bot);
    const store = taskStoreFor(soulDir);
    const goalId = goalIdFor(soulDir, c.req.param('goalId'));
    if (!goalId) return c.json({ error: 'Goal not found', rev: store.read().rev }, 404);
    const r = store.apply([{ op: 'reorder', goalId, ids: b.ids as string[] }], {
      actor: 'operator',
      expectedRev,
    });
    if (!r.ok) {
      const f = taskFailure(r);
      return c.json(f.body, f.status);
    }
    ctx.cache.invalidate();
    return c.json({ rev: r.rev });
  });

  app.post('/:id/goals/:goalId/tasks', async (c) => {
    const bot = findBot(c);
    if (!bot) return c.json({ error: 'Bot not found' }, 404);
    const b = await readBody(c);
    const expectedRev = expectedRevOf(c, b);
    if (expectedRev === null)
      return c.json({ error: 'expectedRev must be a revision number' }, 400);
    if (typeof b.text !== 'string') return c.json({ error: 'text is required' }, 400);
    if (/[\r\n]/.test(b.text)) return c.json({ error: 'a task must be a single line' }, 400);
    const lane = b.lane === undefined ? undefined : String(b.lane);
    if (lane !== undefined && !(TASK_LANES as readonly string[]).includes(lane))
      return c.json({ error: `lane must be one of ${TASK_LANES.join(', ')}` }, 400);
    const { soulDir } = resolveBotPaths(deps.config, bot);
    const store = taskStoreFor(soulDir);
    const goalId = goalIdFor(soulDir, c.req.param('goalId'));
    if (!goalId) return c.json({ error: 'Goal not found', rev: store.read().rev }, 404);
    const r = store.apply(
      [{ op: 'add', goalId, text: b.text, ...(lane ? { lane: lane as TaskLane } : {}) }],
      { actor: 'operator', expectedRev }
    );
    if (!r.ok) {
      const f = taskFailure(r);
      return c.json(f.body, f.status);
    }
    ctx.cache.invalidate();
    const res = r.results[0];
    const task = store.get(res.id);
    deps.logger.info({ botId: bot.id, goalId, taskId: res.id }, 'Operator added a task');
    return c.json(
      {
        task: task ? toTaskView(task) : null,
        rev: r.rev,
        ...(res.existing ? { existing: true } : {}),
      },
      res.existing ? 200 : 201
    );
  });

  app.patch('/:id/tasks/:taskId', async (c) => {
    const bot = findBot(c);
    if (!bot) return c.json({ error: 'Bot not found' }, 404);
    const b = await readBody(c);
    const expectedRev = expectedRevOf(c, b);
    if (expectedRev === null)
      return c.json({ error: 'expectedRev must be a revision number' }, 400);
    const id = c.req.param('taskId');
    const ops: TaskOp[] = [];
    if (b.text !== undefined) {
      if (typeof b.text !== 'string') return c.json({ error: 'text must be a string' }, 400);
      if (/[\r\n]/.test(b.text)) return c.json({ error: 'a task must be a single line' }, 400);
      ops.push({ op: 'edit', id, text: b.text });
    }
    if (b.note !== undefined) {
      if (typeof b.note !== 'string') return c.json({ error: 'note must be a string' }, 400);
      ops.push({ op: 'note', id, text: b.note });
    }
    if (b.lane !== undefined) {
      const lane = String(b.lane);
      if (!(TASK_LANES as readonly string[]).includes(lane))
        return c.json({ error: `lane must be one of ${TASK_LANES.join(', ')}` }, 400);
      ops.push({ op: 'move', id, lane: lane as TaskLane });
    }
    if (ops.length === 0)
      return c.json({ error: 'nothing to change: send lane, text or note' }, 400);
    const store = taskStoreFor(resolveBotPaths(deps.config, bot).soulDir);
    const r = store.apply(ops, { actor: 'operator', expectedRev });
    if (!r.ok) {
      const f = taskFailure(r);
      return c.json(f.body, f.status);
    }
    ctx.cache.invalidate();
    const released = r.results.find((x) => x.releasedClaim)?.releasedClaim;
    const task = store.get(id);
    deps.logger.info(
      { botId: bot.id, taskId: id, ops: ops.map((o) => o.op) },
      'Operator changed a task'
    );
    return c.json({
      task: task ? toTaskView(task) : null,
      rev: r.rev,
      ...(released ? { releasedClaim: released } : {}),
    });
  });

  app.delete('/:id/tasks/:taskId', async (c) => {
    const bot = findBot(c);
    if (!bot) return c.json({ error: 'Bot not found' }, 404);
    const b = await readBody(c);
    const expectedRev = expectedRevOf(c, b);
    if (expectedRev === null)
      return c.json({ error: 'expectedRev must be a revision number' }, 400);
    const id = c.req.param('taskId');
    const store = taskStoreFor(resolveBotPaths(deps.config, bot).soulDir);
    const r = store.apply([{ op: 'remove', id }], { actor: 'operator', expectedRev });
    if (!r.ok) {
      const f = taskFailure(r);
      return c.json(f.body, f.status);
    }
    ctx.cache.invalidate();
    const released = r.results[0]?.releasedClaim;
    deps.logger.info({ botId: bot.id, taskId: id }, 'Operator removed a task');
    return c.json({ removed: id, rev: r.rev, ...(released ? { releasedClaim: released } : {}) });
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
    const soulDir = resolveBotPaths(deps.config, bot).soulDir;
    const goalsPath = join(soulDir, 'GOALS.md');
    const current = existsSync(goalsPath) ? readFileSync(goalsPath, 'utf-8') : null;
    const parsed = parseGoals(current);
    const removedId = resolveGoalRef(ref, [...parsed.active, ...parsed.completed])?.id;
    const next = removeGoal(current, ref);
    if (next === null) return c.json({ error: 'Goal not found' }, 404);
    try {
      writeGoalsFile(goalsPath, next, {
        actor: 'operator',
        reason: OPERATOR_GOAL_REASON,
        backup: (p) => backupSoulFile(p, deps.logger),
      });
    } catch (err) {
      deps.logger.warn({ err, botId: bot.id }, 'Removing goal failed');
      return c.json({ error: 'Could not write GOALS.md' }, 500);
    }
    closeGoal(bot.id, soulDir, removedId);
    ctx.cache.invalidate();
    deps.logger.info({ botId: bot.id, goal: ref }, 'Operator removed goal');
    return c.json({ removed: ref });
  });
  return app;
}
