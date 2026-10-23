/**
 * Birth: the first time the watcher wakes up it reads the fleet it was born
 * into, stage by stage, and turns it into neurons (no LLM, no tokens). Stages
 * and their log text: docs/plans/watcher-consciousness-plan.md, "Birth".
 * Progress goes to `birth.json` after every stage, so a restart resumes at the
 * stage that did not finish. A failing stage is a log row, never an exception.
 *
 * Privacy: memory is read from `MEMORY.md` and the top-level `memory/*.md`
 * files only. `memory/users/**` (people's private memory) and
 * `memory/archive/**` are never opened: the directory listing keeps files only.
 * Everything read from operator-owned material — contacts (people), GOALS.md
 * and tasks (goals), KNOWLEDGE.json (cycles the operator steers) and memory
 * (facts and their category topics) — is marked `meta.operatorSourced`, so
 * `fleet_memory_search` shows it only to the operator. Only the bots
 * themselves (fleet entities) are not.
 */
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { CuriosityStore } from '../bot/curiosity/store';
import { readGoalEvents } from '../bot/goal-events';
import type { ChannelStatus } from '../bot/telegram-errors';
import type { ContactEntry, UserDirectory } from '../bot/user-directory';
import type { Config } from '../config';
import { readTasksSnapshot } from '../goals/task-store';
import type { Logger } from '../logger';
import { SoulLoader, parseIdentityField, parseIdentityName } from '../soul';
import { resolveBotPaths, resolveStatsDirs } from '../stats/paths';
import { type AgentCycleRecord, readAgentCycles } from '../stats/readers/agent-cycles';
import { parseGoals } from '../tools/goals';
import type { Graph } from './graph';
import { normaliseToBall, pca3, placeWithoutEmbedding } from './layout';
import type { WatcherLog } from './log';
import {
  narrateBorn,
  narrateGoals,
  narrateHistory,
  narrateLateLink,
  narrateLearned,
  narrateLinkFailed,
  narrateLinkStopped,
  narrateLinking,
  narrateMetBot,
  narrateMetPerson,
  narrateNoEmbeddings,
  narrateRemembered,
  narrateResync,
  narrateStageFailed,
  narrateUnreadable,
  narrateWake,
} from './narration';
import { birthFile } from './paths';
import {
  BIRTH_STAGES,
  type BirthRecord,
  type BirthStage,
  type Confidence,
  type LinkStatus,
  type Neuron,
  type NeuronKind,
  OPERATOR_SOURCED,
  type Vec3,
  WATCHER_DEFAULTS,
} from './types';

const DAY_MS = 86_400_000;
const EMBED_BATCH = 32;
/**
 * Budget of the one embed before a backfill. The first call may load the
 * model (a cold Ollama load takes 6–10 s on CPU, and it unloads again after
 * `keep_alive`), so a late answer within this is an embedder that is up. A
 * connection error (ECONNREFUSED, ENOTFOUND) rejects at once and never waits
 * for it.
 */
export const EMBED_PROBE_TIMEOUT_MS = 60_000;
const RELATED_PER_NEURON = 5;
const TEXT_MAX = 300;

export interface BirthDeps {
  config: Config;
  graph: Graph;
  log: WatcherLog;
  /** The watcher dir (`birth.json` lives here). */
  dir: string;
  now: () => number;
  logger: Logger;
  channelState?: (botId: string) => ChannelStatus | undefined;
  userDirectory?: Pick<UserDirectory, 'list'>;
  /** Embedding of one text (OllamaClient.embed); absent → no `related` edges. */
  embed?: (text: string) => Promise<number[]>;
  /** Cycle-log rows of a bot; defaults to `<data>/agent-cycles`. */
  readCycles?: (botId: string, sinceMs: number, nowMs: number) => AgentCycleRecord[];
  /**
   * True once this run was cancelled (its own stop signal; never reset). Checked
   * between stages, link batches and around every embedding: a cancelled run writes nothing more.
   */
  isCancelled?: () => boolean;
}

type Mode = 'birth' | 'resync';

interface StageCtx extends BirthDeps {
  mode: Mode;
  record: BirthRecord;
  /** New neurons per kind in this run (resync reports them). */
  created: Partial<Record<NeuronKind, number>>;
}

// ── birth.json ──────────────────────────────────────────────────────────

export function readBirthRecord(dir: string): BirthRecord | null {
  try {
    const path = birthFile(dir);
    if (!existsSync(path)) return null;
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as BirthRecord;
    if (!parsed || !Array.isArray(parsed.done) || typeof parsed.startedAt !== 'string') return null;
    return {
      ...parsed,
      unreadable: Array.isArray(parsed.unreadable) ? parsed.unreadable : [],
      counts: parsed.counts ?? {},
    };
  } catch {
    return null;
  }
}

function writeBirthRecord(deps: BirthDeps, record: BirthRecord): void {
  try {
    mkdirSync(deps.dir, { recursive: true });
    const path = birthFile(deps.dir);
    const tmp = `${path}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(record, null, 2), 'utf-8');
    renameSync(tmp, path);
  } catch (err) {
    deps.logger.warn({ err }, 'Watcher birth: failed to write birth.json');
  }
}

// ── entry points ────────────────────────────────────────────────────────

/** Synchronous first stage: the wake row and a fresh `birth.json`. */
export function beginBirth(deps: BirthDeps): BirthRecord {
  const record: BirthRecord = {
    stage: 'wake',
    done: [],
    startedAt: new Date(deps.now()).toISOString(),
    counts: {},
    unreadable: [],
    linkStatus: 'pending',
  };
  const bots = deps.config.bots ?? [];
  deps.log.say(
    'birth',
    'birth:wake',
    narrateWake({
      bots: bots.length,
      tenants: tenantCount(deps.config),
      backends: backendsOf(deps.config),
    })
  );
  record.done.push('wake');
  record.stage = 'fleet';
  writeBirthRecord(deps, record);
  return record;
}

/** Every stage not yet in `record.done`, in order. Never throws. */
export async function continueBirth(deps: BirthDeps, record: BirthRecord): Promise<BirthRecord> {
  const ctx: StageCtx = { ...deps, mode: 'birth', record, created: {} };
  for (const stage of BIRTH_STAGES) {
    if (record.done.includes(stage)) continue;
    if (deps.isCancelled?.()) return record;
    record.stage = stage;
    try {
      await STAGES[stage](ctx);
    } catch (err) {
      if (deps.isCancelled?.()) return record;
      deps.log.say('birth', 'birth:failed', narrateStageFailed(stage, err));
      deps.logger.warn({ err, stage }, 'Watcher birth: stage failed');
    }
    // A stage cut short by a stop is not marked done: the next start runs it again
    // (stages skip what already exists, so a rerun only adds what is missing).
    if (deps.isCancelled?.()) return record;
    record.done.push(stage);
    writeBirthRecord(deps, record);
  }
  return record;
}

/** After a sleep: what is new among bots, contacts and goals, placed in the ball. */
export async function runResync(
  deps: BirthDeps
): Promise<{ bots: number; goals: number; people: number }> {
  const record: BirthRecord = {
    stage: 'fleet',
    done: [],
    startedAt: new Date(deps.now()).toISOString(),
    counts: {},
    unreadable: [],
  };
  const ctx: StageCtx = { ...deps, mode: 'resync', record, created: {} };
  const before = new Set(deps.graph.list().map((n) => n.id));
  for (const stage of ['fleet', 'people', 'goals'] as const) {
    if (deps.isCancelled?.()) return { bots: 0, goals: 0, people: 0 };
    try {
      await STAGES[stage](ctx);
    } catch (err) {
      deps.log.say('birth', 'resync:failed', narrateStageFailed(stage, err));
    }
  }
  if (deps.isCancelled?.()) return { bots: 0, goals: 0, people: 0 };
  const fresh = deps.graph.list().filter((n) => !before.has(n.id));
  placeNew(deps.graph, fresh);
  const result = {
    bots: ctx.created.entity ?? 0,
    goals: ctx.created.goal ?? 0,
    people: ctx.created.person ?? 0,
  };
  deps.log.say('birth', 'resync', narrateResync(result), {
    ...(fresh.length ? { neuronIds: fresh.map((n) => n.id) } : {}),
  });
  return result;
}

/** PCA of the embeddings into the ball; the rest at their neighbours' centroid or on a shell. */
export function relayout(graph: Graph): void {
  const live = graph.list();
  const embedded = live.filter((n) => graph.getEmbedding(n.id));
  const positions = new Map<string, Vec3>();
  if (embedded.length > 0) {
    const projected = normaliseToBall(
      pca3(embedded.map((n) => graph.getEmbedding(n.id) as number[]))
    );
    embedded.forEach((n, i) => positions.set(n.id, projected[i]));
  }
  placeAll(
    graph,
    live.filter((n) => !positions.has(n.id)),
    positions
  );
  graph.setPositions(positions);
}

// ── stages ──────────────────────────────────────────────────────────────

const STAGES: Record<BirthStage, (ctx: StageCtx) => Promise<void> | void> = {
  wake: () => {},
  fleet: stageFleet,
  people: stagePeople,
  goals: stageGoals,
  knowledge: stageKnowledge,
  memory: stageMemory,
  history: stageHistory,
  link: stageLink,
  done: stageDone,
};

function stageFleet(ctx: StageCtx): void {
  for (const bot of ctx.config.bots ?? []) {
    const key = `bot:${bot.id}`;
    if (ctx.graph.findByKey(key)) continue;
    const soulDir = soulDirOf(ctx.config, bot);
    const loader = loaderFor(ctx, soulDir);
    // Same block rule as the relay's `readIdentityName`, so both agree on the name.
    const identityRaw = loader.readIdentity();
    const name = parseIdentityName(identityRaw) ?? bot.name ?? bot.id;
    const vibe = parseIdentityField(identityRaw, 'vibe');
    const purpose =
      bot.description || vibe || firstCoreDrive(loader.readMotivations()) || undefined;
    const channel = describeChannel(ctx.channelState?.(bot.id), bot.enabled !== false);
    const activeGoals = parseGoals(loader.readGoals()).active.length;
    const traits = readTraits(ctx.config, bot.id);
    const n = add(ctx, {
      kind: 'entity',
      text: purpose ? `${name}: ${clip(purpose)}` : name,
      support: { bots: [bot.id] },
      createdBy: `bot:${bot.id}`,
      confidence: 'high',
      meta: {
        key,
        botId: bot.id,
        name,
        channel,
        stage: `${ctx.mode}:fleet`,
        ...(purpose ? { purpose: clip(purpose) } : {}),
        ...(traits ? { traits } : {}),
      },
    });
    ctx.log.say(
      'birth',
      `${ctx.mode}:fleet`,
      narrateMetBot({ name, purpose: purpose ? clip(purpose) : undefined, channel, activeGoals }),
      {
        neuronIds: [n.id],
      }
    );
  }
}

interface PersonDraft {
  key: string;
  name: string;
  operator: boolean;
  channels: string[];
  addresses: Set<string>;
  bots: string[];
}

function stagePeople(ctx: StageCtx): void {
  if (!ctx.userDirectory) {
    if (ctx.mode === 'birth')
      ctx.log.say('birth', 'birth:people', 'No contact directory to read. Meeting nobody yet.');
    return;
  }
  const drafts: PersonDraft[] = [];
  for (const bot of ctx.config.bots ?? []) {
    for (const contact of ctx.userDirectory.list(bot.id)) mergeContact(drafts, contact, bot.id);
  }
  const op = ctx.config.operator;
  for (const d of drafts) {
    if (!d.operator) continue;
    if (op?.telegramChatId !== undefined && !d.channels.includes('telegram'))
      d.channels.push('telegram');
    if (op?.email && !d.channels.includes('email')) d.channels.push('email');
  }
  drafts.sort((a, b) => Number(b.operator) - Number(a.operator));

  for (const d of drafts) {
    let person = ctx.graph.findByKey(d.key);
    const isNew = !person;
    if (!person) {
      person = add(ctx, {
        kind: 'person',
        text: clip(d.name),
        support: { bots: d.bots },
        createdBy: `bot:${d.bots[0]}`,
        confidence: 'high',
        meta: {
          key: d.key,
          channels: d.channels.join(' + '),
          stage: `${ctx.mode}:people`,
          [OPERATOR_SOURCED]: 'true',
          ...(d.operator ? { role: 'operator' } : {}),
        },
      });
    }
    const edgeIds: string[] = [];
    for (const botId of d.bots) {
      const bot = ctx.graph.findByKey(`bot:${botId}`);
      if (!bot) continue;
      const before = ctx.graph.edgeCount();
      const e = ctx.graph.addEdge({
        from: bot.id,
        to: person.id,
        rel: 'knows',
        weight: 1,
        createdBy: `bot:${botId}`,
      });
      if (ctx.graph.edgeCount() > before) edgeIds.push(e.id);
    }
    if (!isNew && ctx.mode === 'resync') continue;
    ctx.log.say(
      'birth',
      `${ctx.mode}:people`,
      narrateMetPerson({
        name: d.name,
        operator: d.operator,
        channels: d.channels,
        bots: d.bots.length,
      }),
      { neuronIds: [person.id], ...(edgeIds.length ? { edgeIds } : {}) }
    );
  }
}

function mergeContact(drafts: PersonDraft[], contact: ContactEntry, botId: string): void {
  const operator = contact.metadata?.role === 'operator';
  const addresses = (contact.channels ?? []).map((c) => `${c.kind}:${c.address}`);
  const existing = operator
    ? drafts.find((d) => d.operator)
    : drafts.find((d) => !d.operator && addresses.some((a) => d.addresses.has(a)));
  const kinds = [...new Set((contact.channels ?? []).map((c) => String(c.kind)))];
  if (existing) {
    for (const a of addresses) existing.addresses.add(a);
    for (const k of kinds) if (!existing.channels.includes(k)) existing.channels.push(k);
    if (!existing.bots.includes(botId)) existing.bots.push(botId);
    return;
  }
  drafts.push({
    key: operator ? 'person:operator' : `person:${hash(addresses[0] ?? `${botId}:${contact.id}`)}`,
    name: contact.displayName || contact.id,
    operator,
    channels: kinds,
    addresses: new Set(addresses),
    bots: [botId],
  });
}

function stageGoals(ctx: StageCtx): void {
  for (const bot of ctx.config.bots ?? []) {
    const soulDir = soulDirOf(ctx.config, bot);
    const loader = loaderFor(ctx, soulDir);
    const { active, completed } = parseGoals(loader.readGoals());
    if (active.length + completed.length === 0) continue;
    const tasks = checkJson(ctx, bot.id, soulDir, 'TASKS.json')
      ? readTasksSnapshot(soulDir).tasks
      : [];
    const owner = ctx.graph.findByKey(`bot:${bot.id}`);
    const ids: string[] = [];
    let newActive = 0;
    let openTasks = 0;
    for (const g of [...active, ...completed]) {
      const done = completed.includes(g);
      const key = `goal:${bot.id}:${g.id ?? hash(g.text)}`;
      if (ctx.graph.findByKey(key)) continue;
      const open = g.id ? tasks.filter((t) => t.goalId === g.id && t.lane !== 'done') : [];
      const n = add(ctx, {
        kind: 'goal',
        text: clip(g.headline || g.text),
        support: { bots: [bot.id] },
        createdBy: `bot:${bot.id}`,
        meta: {
          key,
          status: done ? 'done' : g.status,
          priority: g.priority,
          openTasks: String(open.length),
          stage: `${ctx.mode}:goals`,
          [OPERATOR_SOURCED]: 'true',
          ...(g.id ? { goalId: g.id } : {}),
          ...(g.kind ? { kind: g.kind } : {}),
          ...(g.source ? { source: g.source } : {}),
          ...(open.length
            ? {
                tasks: open
                  .map((t) => t.text)
                  .join('\n')
                  .slice(0, 1000),
              }
            : {}),
        },
      });
      if (owner)
        ctx.graph.addEdge({
          from: n.id,
          to: owner.id,
          rel: 'owned_by',
          weight: 1,
          createdBy: `bot:${bot.id}`,
        });
      ids.push(n.id);
      if (!done) {
        newActive++;
        openTasks += open.length;
      }
    }
    if (ids.length === 0) continue;
    ctx.log.say(
      'birth',
      `${ctx.mode}:goals`,
      narrateGoals({ bot: botName(ctx, bot.id), goals: newActive, openTasks }),
      {
        neuronIds: ids,
      }
    );
  }
}

function stageKnowledge(ctx: StageCtx): void {
  for (const bot of ctx.config.bots ?? []) {
    const soulDir = soulDirOf(ctx.config, bot);
    if (!existsSync(join(soulDir, 'KNOWLEDGE.json'))) continue;
    if (!checkJson(ctx, bot.id, soulDir, 'KNOWLEDGE.json')) continue;
    const map = new CuriosityStore(soulDir).loadMap();
    const name = botName(ctx, bot.id);
    const owner = ctx.graph.findByKey(`bot:${bot.id}`);
    const by = `bot:${bot.id}` as const;
    const learn = (
      key: string,
      kind: NeuronKind,
      text: string,
      opts: {
        confidence?: Confidence;
        about?: Neuron;
        meta?: Record<string, string>;
        cycles?: string[];
      } = {}
    ): Neuron | undefined => {
      if (!text.trim() || ctx.graph.findByKey(key)) return ctx.graph.findByKey(key);
      const n = add(ctx, {
        kind,
        text: clip(text),
        support: {
          bots: [bot.id],
          paths: ['KNOWLEDGE.json'],
          ...(opts.cycles?.length ? { cycles: opts.cycles } : {}),
        },
        createdBy: by,
        ...(opts.confidence ? { confidence: opts.confidence } : {}),
        meta: { key, stage: 'birth:knowledge', [OPERATOR_SOURCED]: 'true', ...(opts.meta ?? {}) },
      });
      const edgeIds: string[] = [];
      const target = opts.about ?? owner;
      if (target) {
        edgeIds.push(
          ctx.graph.addEdge({
            from: n.id,
            to: target.id,
            rel: opts.about ? 'about' : 'owned_by',
            weight: 1,
            createdBy: by,
          }).id
        );
      }
      ctx.log.say(
        'birth',
        'birth:knowledge',
        narrateLearned({ bot: name, text: clip(text), kind, confidence: opts.confidence }),
        {
          neuronIds: [n.id],
          edgeIds,
        }
      );
      return n;
    };
    for (const topic of map.topics ?? []) {
      const tn = learn(`topic:${bot.id}:${topic.id}`, 'topic', topic.name, {
        meta: { depth: String(topic.depth ?? 0) },
      });
      for (const f of topic.findings ?? []) {
        learn(`fact:${bot.id}:${f.id}`, 'fact', f.claim, {
          confidence: f.confidence,
          about: tn,
          meta: f.evidence ? { evidence: clip(f.evidence) } : {},
        });
      }
      for (const s of topic.surprises ?? [])
        learn(`surprise:${bot.id}:${s.id}`, 'surprise', s.text, { about: tn });
      for (const q of topic.openQuestions ?? [])
        learn(`question:${bot.id}:${topic.id}:${hash(q)}`, 'question', q, { about: tn });
    }
    for (const item of map.frontier ?? []) {
      if (item.status !== 'open' && item.status !== 'exploring') continue;
      const from = item.fromTopic
        ? ctx.graph.findByKey(`topic:${bot.id}:${item.fromTopic}`)
        : undefined;
      learn(`frontier:${bot.id}:${item.id}`, 'question', item.question, {
        about: from,
        meta: {
          frontier: item.status,
          ...(item.whyInteresting ? { whyInteresting: clip(item.whyInteresting) } : {}),
        },
        cycles: item.createdBy?.cycleId ? [item.createdBy.cycleId] : [],
      });
    }
  }
}

const DAILY_LINE = /^\s*-\s*\[\d{1,2}:\d{2}\]\s+(.+)$/;

/** Operational traces a bot's daily log carries next to real facts. */
const BOOKKEEPING_MARKS: RegExp[] = [
  /\bask_human\s+[0-9a-f]{6,}\b/i,
  // "enviado/enviada" only in a bookkeeping shape (a tool name or an id next
  // to it, or a question/message sent to the operator), never the bare word:
  // "el informe fue enviado al cliente" is a fact.
  /\b(?:ask_\w+|send_\w+|[0-9a-f]{6,})\s+enviad[ao]s?\b/i,
  /\benviad[ao]s?\s*\(?\s*id\s*[:#]?\s*[0-9a-f]{6,}/i,
  /\b(?:pregunta|mensaje|recordatorio|notificaci[oó]n|aviso)e?s?\s+enviad[ao]s?\s+al\s+operador\b/i,
  /\[agent-loop\]/i,
  /\[error\]/i,
  // a leading tag that names an error or the agent loop: "[tool-error] …"
  /^\[[^\]]*(?:agent-loop|error)[^\]]*\]/i,
  /\bcron-[\w-]+/i,
  /\bsend_proactive/i,
  /\btask_progress\b/i,
];
const URL_RE = /<?https?:\/\/\S+>?/gi;
const ID_RE = /\b[tg]-[0-9a-f]{6,8}\b/gi;

/**
 * A daily-log line that is bookkeeping, not a fact: an `ask_human <id>` /
 * "<tool|id> enviada" / "mensaje enviado al operador" trace, an
 * `[agent-loop]` / `[error]` (or `[…error…]`-tagged) row, a `cron-…` run, a
 * `send_proactive` / `task_progress` call, or a line that is only task/goal
 * ids or only URLs. Birth's memory stage skips these. Pure.
 */
export function isBookkeepingLine(text: string): boolean {
  const t = (text ?? '').trim();
  if (!t) return true;
  if (BOOKKEEPING_MARKS.some((re) => re.test(t))) return true;
  const rest = t.replace(URL_RE, ' ').replace(ID_RE, ' ');
  return !/\p{L}{2,}/u.test(rest);
}

const BULLET = /^\s*[-*]\s+(.+)$/;

function stageMemory(ctx: StageCtx): void {
  for (const bot of ctx.config.bots ?? []) {
    const soulDir = soulDirOf(ctx.config, bot);
    const facts: Array<{ text: string; source: string; category?: string }> = [];
    const memoryMd = join(soulDir, 'MEMORY.md');
    const memory = readText(ctx, bot.id, memoryMd, 'MEMORY.md');
    if (memory) {
      let category: string | undefined;
      for (const line of memory.split('\n')) {
        const heading = /^##+\s+(.+)$/.exec(line.trim());
        if (heading) {
          category = heading[1].trim();
          continue;
        }
        const m = BULLET.exec(line);
        if (m)
          facts.push({
            text: stripTime(m[1]),
            source: 'MEMORY.md',
            ...(category ? { category } : {}),
          });
      }
    }
    // Top-level daily logs only: memory/users/** and memory/archive/** are directories and never opened.
    for (const file of listMemoryFiles(join(soulDir, 'memory'))) {
      const content = readText(ctx, bot.id, join(soulDir, 'memory', file), `memory/${file}`);
      if (!content) continue;
      for (const line of content.split('\n')) {
        const m = DAILY_LINE.exec(line);
        if (!m) continue;
        if (isBookkeepingLine(m[1])) continue;
        const tagged = /^\[([^\]]+)\]\s+(.+)$/.exec(m[1].trim());
        facts.push({
          text: (tagged ? tagged[2] : m[1]).trim(),
          source: `memory/${file}`,
          ...(tagged ? { category: tagged[1] } : {}),
        });
      }
    }
    const name = botName(ctx, bot.id);
    const owner = ctx.graph.findByKey(`bot:${bot.id}`);
    const by = `bot:${bot.id}` as const;
    for (const f of facts) {
      if (!f.text) continue;
      const key = `memory:${bot.id}:${hash(f.text.toLowerCase())}`;
      if (ctx.graph.findByKey(key)) continue;
      const n = add(ctx, {
        kind: 'fact',
        text: clip(f.text),
        support: { bots: [bot.id], paths: [f.source] },
        createdBy: by,
        meta: {
          key,
          source: f.source,
          stage: 'birth:memory',
          [OPERATOR_SOURCED]: 'true',
          ...(f.category ? { category: f.category } : {}),
        },
      });
      const neuronIds = [n.id];
      const edgeIds: string[] = [];
      if (f.category) {
        const tkey = `topic:${bot.id}:mem:${f.category.toLowerCase()}`;
        let topic = ctx.graph.findByKey(tkey);
        if (!topic) {
          topic = add(ctx, {
            kind: 'topic',
            text: clip(f.category),
            support: { bots: [bot.id], paths: [f.source] },
            createdBy: by,
            meta: { key: tkey, stage: 'birth:memory', [OPERATOR_SOURCED]: 'true' },
          });
          neuronIds.push(topic.id);
          if (owner)
            edgeIds.push(
              ctx.graph.addEdge({
                from: topic.id,
                to: owner.id,
                rel: 'owned_by',
                weight: 1,
                createdBy: by,
              }).id
            );
        }
        edgeIds.push(
          ctx.graph.addEdge({ from: n.id, to: topic.id, rel: 'about', weight: 1, createdBy: by }).id
        );
      } else if (owner) {
        edgeIds.push(
          ctx.graph.addEdge({ from: n.id, to: owner.id, rel: 'owned_by', weight: 1, createdBy: by })
            .id
        );
      }
      ctx.log.say('birth', 'birth:memory', narrateRemembered({ bot: name, text: clip(f.text) }), {
        neuronIds,
        edgeIds,
      });
    }
  }
}

function stageHistory(ctx: StageCtx): void {
  const days = ctx.config.watcher?.birth?.historyDays ?? WATCHER_DEFAULTS.birth.historyDays;
  const nowMs = ctx.now();
  const sinceMs = nowMs - days * DAY_MS;
  const read =
    ctx.readCycles ??
    ((botId: string, since: number, now: number) =>
      readAgentCycles(resolveStatsDirs(ctx.config).agentCycles, botId, since, now));
  let cycles = 0;
  let worked = 0;
  let never = 0;
  const touched: string[] = [];
  for (const bot of ctx.config.bots ?? []) {
    const rows = read(bot.id, sinceMs, nowMs);
    cycles += rows.length;
    const perGoal = new Map<string, { count: number; last: number }>();
    for (const row of rows) {
      if (!row.goalId) continue;
      const at = Date.parse(row.endedAt ?? row.startedAt);
      const cur = perGoal.get(row.goalId) ?? { count: 0, last: 0 };
      perGoal.set(row.goalId, {
        count: cur.count + 1,
        last: Math.max(cur.last, Number.isFinite(at) ? at : 0),
      });
    }
    const soulDir = soulDirOf(ctx.config, bot);
    for (const e of readGoalEvents(soulDir)) {
      const at = Date.parse(e.ts);
      if (!e.goalId || !Number.isFinite(at) || at < sinceMs) continue;
      const cur = perGoal.get(e.goalId) ?? { count: 0, last: 0 };
      perGoal.set(e.goalId, { count: cur.count, last: Math.max(cur.last, at) });
    }
    for (const n of ctx.graph.list()) {
      if (n.kind !== 'goal' || !n.meta?.key?.startsWith(`goal:${bot.id}:`)) continue;
      const hit = n.meta.goalId ? perGoal.get(n.meta.goalId) : undefined;
      if (hit && hit.count > 0) worked++;
      else if (n.meta.status !== 'done') never++;
      if (hit && (hit.count > 0 || hit.last > 0)) {
        ctx.graph.setActivation(n.id, hit.count, new Date(hit.last || nowMs).toISOString());
        touched.push(n.id);
      }
    }
    if (existsSync(join(soulDir, 'KNOWLEDGE.json'))) {
      for (const topic of new CuriosityStore(soulDir).loadMap().topics ?? []) {
        const n = ctx.graph.findByKey(`topic:${bot.id}:${topic.id}`);
        const at = Date.parse(topic.lastTouched);
        if (!n || !Number.isFinite(at) || at < sinceMs) continue;
        ctx.graph.setActivation(n.id, topic.cycles ?? 0, new Date(at).toISOString());
        touched.push(n.id);
      }
    }
  }
  ctx.log.say(
    'birth',
    'birth:history',
    narrateHistory({ days, cycles, goalsWorked: worked, goalsNever: never }),
    {
      ...(touched.length ? { neuronIds: touched } : {}),
    }
  );
}

async function stageLink(ctx: StageCtx): Promise<void> {
  const finish = (status: LinkStatus) => {
    ctx.record.linkStatus = status;
    relayout(ctx.graph);
  };
  const model = (ctx.config.soul as { search?: { embeddingModel?: string } } | undefined)?.search
    ?.embeddingModel;
  if (!ctx.embed) {
    ctx.log.say(
      'birth',
      'birth:link',
      narrateNoEmbeddings(model ? 'no embedding backend' : 'no embedding model configured')
    );
    return finish('no-embeddings');
  }
  const res = await linkUnembedded(ctx, {
    onBatch: (batch, edgeIds) =>
      ctx.log.say(
        'birth',
        'birth:link',
        narrateLinking({ neurons: ctx.graph.embeddedIds().length, edges: ctx.graph.edgeCount() }),
        { neuronIds: batch.map((n) => n.id), ...(edgeIds.length ? { edgeIds } : {}) }
      ),
  });
  if (res.cancelled) return;
  if (res.failure && res.status === 'no-embeddings') {
    ctx.log.say('birth', 'birth:link', narrateNoEmbeddings(res.failure));
  } else if (res.failure) {
    ctx.log.say(
      'birth',
      'birth:link',
      narrateLinkStopped({ embedded: res.embedded, total: res.pending, failure: res.failure })
    );
  }
  finish(res.status);
}

export interface LinkResult {
  /**
   * `ok` once any live neuron has a vector and the call ended without an
   * embedding error; `partial` when the graph has vectors but the call stopped
   * at one; `no-embeddings` when no live neuron has a vector.
   */
  status: LinkStatus;
  /** Neurons embedded by this call. */
  embedded: number;
  /** Live neurons without a vector when the call started. */
  pending: number;
  /** `related` edges this call added. */
  edges: number;
  /**
   * The first real embedding error of the call (also when some neurons were
   * embedded before it): a batch where every embed failed ends the call.
   */
  failure?: string;
  cancelled?: boolean;
  /** `linkMissing` already recomputed the layout (callers must not relayout again). */
  relaidOut?: boolean;
}

/**
 * Embed every live neuron that has no vector yet, in batches, and link each
 * one to its nearest neighbours with `related` edges. Used by birth's link
 * stage and by daily maintenance (`linkMissing`). Never relayouts and never
 * logs by itself: `onBatch` is called after each batch that embedded.
 */
export async function linkUnembedded(
  deps: BirthDeps,
  opts: { onBatch?: (batch: Neuron[], edgeIds: string[]) => void } = {}
): Promise<LinkResult> {
  const graph = deps.graph;
  const embed = deps.embed;
  const pending = graph.list().filter((n) => !n.archivedAt && !graph.getEmbedding(n.id));
  const result: LinkResult = {
    status: 'no-embeddings',
    embedded: 0,
    edges: 0,
    pending: pending.length,
  };
  const done = () => {
    result.status =
      graph.embeddedIds().length === 0 ? 'no-embeddings' : result.failure ? 'partial' : 'ok';
    return result;
  };
  if (!embed) return done();
  const threshold =
    deps.config.watcher?.graph?.relatedThreshold ?? WATCHER_DEFAULTS.graph.relatedThreshold;
  const concurrency = Math.max(
    1,
    (deps.config.soul as { search?: { concurrency?: number } } | undefined)?.search?.concurrency ??
      3
  );
  for (let i = 0; i < pending.length; i += EMBED_BATCH) {
    if (deps.isCancelled?.()) return { ...result, cancelled: true };
    const batch = pending.slice(i, i + EMBED_BATCH);
    let failure: unknown;
    let batchEmbedded = 0;
    let queue = batch;
    while (queue.length > 0) {
      const heldBack: Neuron[] = [];
      await mapLimit(queue, concurrency, async (n) => {
        // A cancelled run neither starts another embedding nor stores one that
        // settled after the stop: its writes belong to no live run.
        if (deps.isCancelled?.()) return;
        // An embedder that failed and has embedded nothing in this batch yet
        // looks down: hold the rest back instead of queueing it behind its
        // connect timeout, until the embeds in flight settle.
        if (failure && batchEmbedded === 0) {
          heldBack.push(n);
          return;
        }
        try {
          const vec = await embed(`${n.kind}: ${n.text}`);
          if (deps.isCancelled?.()) return;
          if (Array.isArray(vec) && vec.length > 0) {
            graph.setEmbedding(n.id, vec);
            result.embedded++;
            batchEmbedded++;
          }
        } catch (err) {
          failure ??= err;
        }
      });
      // Settled with zero successes: the embedder is down. Otherwise an embed
      // in flight succeeded after the early error: the held-back ones run too.
      if (batchEmbedded === 0 || deps.isCancelled?.()) break;
      queue = heldBack;
    }
    if (deps.isCancelled?.()) return { ...result, cancelled: true };
    if (failure) result.failure ??= failure instanceof Error ? failure.message : String(failure);
    // Every embed of the batch failed: stop here (whatever vectors the graph
    // already had); the next maintenance tries again.
    if (failure && batchEmbedded === 0) return done();
    const edgeIds: string[] = [];
    for (const n of batch) {
      const vec = graph.getEmbedding(n.id);
      if (!vec) continue;
      const hits = graph.findSimilarEmbedding(vec, threshold).filter((h) => h.neuron.id !== n.id);
      for (const h of hits.slice(0, RELATED_PER_NEURON)) {
        const before = graph.edgeCount();
        const e = graph.addEdge({
          from: n.id,
          to: h.neuron.id,
          rel: 'related',
          weight: Math.round(h.score * 1000) / 1000,
          createdBy: 'watcher',
        });
        if (graph.edgeCount() > before) edgeIds.push(e.id);
      }
    }
    result.edges += edgeIds.length;
    opts.onBatch?.(batch, edgeIds);
  }
  return done();
}

/**
 * Daily maintenance (and once at start): a graph born `no-embeddings`, or
 * neurons added since without a vector, get embedded and linked once an
 * embedder works. Undefined (and no row) when there is no embedder or every
 * live neuron already has a vector; otherwise one `maintain:link` row, a
 * relayout when something was embedded, and `birth.json` updated to `ok`.
 */
export async function linkMissing(
  deps: BirthDeps,
  opts: { probeTimeoutMs?: number } = {}
): Promise<LinkResult | undefined> {
  const embed = deps.embed;
  if (!embed) return undefined;
  const pending = deps.graph
    .list()
    .filter((n) => !n.archivedAt && !deps.graph.getEmbedding(n.id)).length;
  if (pending === 0) return undefined;
  // One embed with a short timeout first: an embedder that is down costs one
  // call, not a connect timeout per neuron.
  const probeFailure = await probeEmbedder(embed, opts.probeTimeoutMs ?? EMBED_PROBE_TIMEOUT_MS);
  if (deps.isCancelled?.()) {
    return { status: 'no-embeddings', embedded: 0, edges: 0, pending, cancelled: true };
  }
  const res: LinkResult = probeFailure
    ? {
        status: deps.graph.embeddedIds().length > 0 ? 'partial' : 'no-embeddings',
        embedded: 0,
        edges: 0,
        pending,
        failure: probeFailure,
      }
    : await linkUnembedded(deps);
  if (res.cancelled) return res;
  if (res.failure) {
    deps.logger.warn(
      { err: res.failure, embedded: res.embedded, pending },
      'Watcher: embedding the neurons without a vector failed'
    );
  }
  res.relaidOut = res.embedded > 0;
  if (res.embedded > 0) {
    relayout(deps.graph);
    deps.log.say(
      'birth',
      'maintain:link',
      narrateLateLink({
        embedded: res.embedded,
        edges: res.edges,
        ...(res.failure ? { failure: res.failure } : {}),
      })
    );
  } else {
    // Nothing was embedded, so nothing moved: say why, never "placing by kind".
    deps.log.say(
      'birth',
      'maintain:link',
      narrateLinkFailed({ pending, reason: res.failure ?? 'the embedder returned no vectors' })
    );
  }
  // `ok` once a run ends without an error; `partial` when it embedded some and
  // stopped (the next start or maintenance continues). A run that embedded
  // nothing leaves the recorded status as it was.
  const record = readBirthRecord(deps.dir);
  const next: LinkStatus | undefined =
    res.status === 'ok'
      ? 'ok'
      : res.status === 'partial' && res.embedded > 0
        ? 'partial'
        : undefined;
  if (record && next && record.linkStatus !== next) {
    writeBirthRecord(deps, { ...record, linkStatus: next });
  }
  return res;
}

/** Undefined when one embed answered with a vector within `timeoutMs`; otherwise why not. Never throws. */
async function probeEmbedder(
  embed: NonNullable<BirthDeps['embed']>,
  timeoutMs: number
): Promise<string | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<string>((resolve) => {
    timer = setTimeout(
      () => resolve(`the embedder did not answer within ${timeoutMs} ms`),
      timeoutMs
    );
  });
  try {
    return await Promise.race([
      Promise.resolve()
        .then(() => embed('probe'))
        .then(
          (vec) =>
            Array.isArray(vec) && vec.length > 0 ? undefined : 'the embedder returned no vectors',
          (err: unknown) => (err instanceof Error ? err.message : String(err))
        ),
      timeout,
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function stageDone(ctx: StageCtx): void {
  const counts = ctx.graph.counts();
  ctx.record.counts = { ...counts, edges: ctx.graph.edgeCount() };
  ctx.record.finishedAt = new Date(ctx.now()).toISOString();
  ctx.log.say(
    'birth',
    'birth:done',
    narrateBorn({
      counts,
      durationMs: Math.max(0, ctx.now() - Date.parse(ctx.record.startedAt)),
      unreadable: ctx.record.unreadable,
    })
  );
}

// ── helpers ─────────────────────────────────────────────────────────────

function add(ctx: StageCtx, input: Parameters<Graph['addNeuron']>[0]): Neuron {
  const n = ctx.graph.addNeuron(input);
  ctx.created[n.kind] = (ctx.created[n.kind] ?? 0) + 1;
  return n;
}

function soulDirOf(config: Config, bot: Config['bots'][number]): string {
  return resolveBotPaths(config, bot).soulDir;
}

function loaderFor(ctx: StageCtx, soulDir: string): SoulLoader {
  return new SoulLoader({ ...(ctx.config.soul ?? {}), dir: soulDir } as never, ctx.logger);
}

function botName(ctx: StageCtx, botId: string): string {
  return (
    ctx.graph.findByKey(`bot:${botId}`)?.meta?.name ??
    ctx.config.bots.find((b) => b.id === botId)?.name ??
    botId
  );
}

function tenantCount(config: Config): number {
  if (!config.multiTenant?.enabled) return 1;
  return new Set((config.bots ?? []).map((b) => b.tenantId ?? '__admin__')).size || 1;
}

function backendsOf(config: Config): string[] {
  const set = new Set<string>();
  for (const bot of config.bots ?? []) set.add(resolveBotPaths(config, bot).backend);
  return [...set].sort();
}

function describeChannel(status: ChannelStatus | undefined, enabled: boolean): string {
  const base = !status
    ? 'channel unknown'
    : status.kind === 'headless'
      ? 'dashboard only'
      : `telegram ${status.state}`;
  return enabled ? base : `${base}, disabled`;
}

function firstCoreDrive(raw: string | null): string | undefined {
  if (!raw) return undefined;
  let inDrives = false;
  for (const line of raw.split('\n')) {
    if (/^##\s+/.test(line)) {
      inDrives = /core drives|impulsos centrales/i.test(line);
      continue;
    }
    const m = inDrives ? BULLET.exec(line) : null;
    if (m) return m[1].trim();
  }
  return undefined;
}

function readTraits(config: Config, botId: string): string | undefined {
  try {
    const data = (config.paths as { data?: string } | undefined)?.data ?? './data';
    const path = join(data, 'tenants', '__admin__', 'bots', botId, 'TRAITS.json');
    if (!existsSync(path)) return undefined;
    const current = (
      JSON.parse(readFileSync(path, 'utf-8')) as { current?: Record<string, number> }
    ).current;
    if (!current) return undefined;
    return Object.entries(current)
      .filter(([, v]) => typeof v === 'number')
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([k, v]) => `${k} ${v.toFixed(2)}`)
      .join(', ');
  } catch {
    return undefined;
  }
}

/** A JSON file that exists but does not parse is reported (row + `unreadable`) and its stage skips it. */
function checkJson(ctx: StageCtx, botId: string, soulDir: string, file: string): boolean {
  const path = join(soulDir, file);
  if (!existsSync(path)) return true;
  try {
    JSON.parse(readFileSync(path, 'utf-8'));
    return true;
  } catch (err) {
    reportUnreadable(
      ctx,
      `${botId}/${file}`,
      err instanceof SyntaxError ? 'invalid JSON' : errText(err)
    );
    return false;
  }
}

function readText(ctx: StageCtx, botId: string, path: string, label: string): string | null {
  if (!existsSync(path)) return null;
  try {
    return readFileSync(path, 'utf-8');
  } catch (err) {
    reportUnreadable(ctx, `${botId}/${label}`, errText(err));
    return null;
  }
}

function reportUnreadable(ctx: StageCtx, what: string, reason: string): void {
  if (!ctx.record.unreadable.includes(what)) ctx.record.unreadable.push(what);
  ctx.log.say('birth', `${ctx.mode}:unreadable`, narrateUnreadable(what, reason));
}

function listMemoryFiles(dir: string): string[] {
  try {
    if (!existsSync(dir)) return [];
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith('.md'))
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

function stripTime(text: string): string {
  return text.replace(/^\[\d{1,2}:\d{2}\]\s*/, '').trim();
}

function clip(text: string): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > TEXT_MAX ? `${t.slice(0, TEXT_MAX - 1)}…` : t;
}

function hash(text: string): string {
  return createHash('sha1').update(text).digest('hex').slice(0, 12);
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function mapLimit<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>
): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      await fn(items[i]);
    }
  });
  await Promise.all(workers);
}

function placeNew(graph: Graph, fresh: Neuron[]): void {
  if (fresh.length === 0) return;
  const positions = new Map<string, Vec3>();
  placeAll(graph, fresh, positions);
  graph.setPositions(positions);
}

/** Neighbour centroid when any neighbour is placed (already or in this pass), else the shell. */
function placeAll(graph: Graph, neurons: Neuron[], positions: Map<string, Vec3>): void {
  const placedOf = (id: string): Vec3[] =>
    graph
      .neighbours(id)
      .map(
        ({ neuron }) =>
          positions.get(neuron.id) ??
          (neurons.some((x) => x.id === neuron.id) ? undefined : neuron.pos)
      )
      .filter((p): p is Vec3 => Array.isArray(p));
  let remaining = neurons.filter((n) => !positions.has(n.id));
  for (let pass = 0; pass < 3 && remaining.length > 0; pass++) {
    const still: Neuron[] = [];
    for (const n of remaining) {
      const near = placedOf(n.id);
      if (near.length > 0) positions.set(n.id, placeWithoutEmbedding(n, near));
      else still.push(n);
    }
    if (still.length === remaining.length) break;
    remaining = still;
  }
  for (const n of remaining)
    if (!positions.has(n.id)) positions.set(n.id, placeWithoutEmbedding(n, []));
}
