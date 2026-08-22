/**
 * Shared on-disk fixture for the stats aggregator and route tests: a data
 * directory populated with three bots' worth of every store the readers know
 * about, plus a Config pointing at it.
 *
 *   b1 — enabled, ollama, valid token, busy (llm calls, tools, asks, goals…)
 *   b2 — disabled, claude-cli, empty token, no data at all
 *   b3 — enabled, tenant "t2", valid token but Telegram rejected it (401)
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BotConfig, Config } from '../../src/config';
import { createTempDir } from '../helpers/temp-dir';

export const H = 3_600_000;
export const DAY = 86_400_000;

export interface StatsFixture {
  dir: string;
  now: number;
  config: Config;
  bots: { b1: BotConfig; b2: BotConfig; b3: BotConfig };
  soulDir: (botId: string) => string;
}

export const VALID_TOKEN = '123456789:AAbbCCddEEffGGhhIIjjKKllMMnnOOppQQrr';

function jsonl(path: string, rows: unknown[]) {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`);
}

function json(path: string, value: unknown) {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2));
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function day(ms: number): string {
  return iso(ms).slice(0, 10);
}

export function makeBot(overrides: Partial<BotConfig> = {}): BotConfig {
  return {
    id: 'b1',
    name: 'Bot One',
    token: VALID_TOKEN,
    enabled: true,
    skills: [],
    ...overrides,
  } as BotConfig;
}

export function makeConfig(dir: string, bots: BotConfig[]): Config {
  return {
    bots,
    paths: { data: dir, logs: join(dir, 'logs'), skills: './src/skills' },
    logging: { level: 'info', file: join(dir, 'logs', 'aibot.log') },
    soul: { dir: join(dir, 'legacy-soul') },
    productions: { enabled: true, baseDir: join(dir, 'productions') },
    conversations: { baseDir: join(dir, 'conversations') },
    karma: { enabled: true, baseDir: join(dir, 'karma'), initialScore: 50, decayDays: 30 },
    session: { enabled: true, dataDir: join(dir, 'sessions') },
    cron: { storePath: join(dir, 'cron') },
    multiTenant: { enabled: false, dataDir: join(dir, 'tenants') },
    ollama: { models: { primary: 'qwen', fallbacks: [] } },
    claudeCli: { model: 'claude-sonnet' },
    conversation: {},
    agentLoop: { enabled: true, every: '6h' },
  } as unknown as Config;
}

export function createStatsFixture(): StatsFixture {
  const dir = createTempDir('stats-fixture');
  const now = Date.now();
  const b1 = makeBot({ id: 'b1', name: 'Bot One' });
  const b2 = makeBot({
    id: 'b2',
    name: 'Bot Two',
    token: '',
    enabled: false,
    llmBackend: 'claude-cli',
  });
  const b3 = makeBot({ id: 'b3', name: 'Bot Three', tenantId: 't2' });
  const config = makeConfig(dir, [b1, b2, b3]);
  const soulDir = (botId: string) => join(dir, 'tenants', '__admin__', 'bots', botId, 'soul');

  // ── LLM query log (b1) ──
  jsonl(join(dir, 'llm-query-log', 'b1', `${day(now)}.jsonl`), [
    {
      timestamp: iso(now - 3 * H),
      botId: 'b1',
      caller: 'planner',
      model: 'qwen',
      backend: 'ollama',
      durationMs: 1000,
      success: true,
      promptTokens: 100,
      completionTokens: 10,
    },
    {
      timestamp: iso(now - 2 * H),
      botId: 'b1',
      caller: 'executor',
      model: 'qwen',
      backend: 'ollama',
      durationMs: 2000,
      success: false,
      error: 'HTTP 429 Too Many Requests',
    },
    {
      timestamp: iso(now - 1 * H),
      botId: 'b1',
      caller: 'executor',
      model: 'qwen',
      backend: 'ollama',
      durationMs: 3000,
      success: true,
      promptTokens: 200,
      completionTokens: 20,
    },
  ]);

  // ── Tool audit (b1) ──
  const tool = (over: Record<string, unknown>) => ({
    timestamp: iso(now - H),
    botId: 'b1',
    chatId: 0,
    toolName: 'file_write',
    args: {},
    success: true,
    result: 'ok',
    durationMs: 3,
    retryAttempts: 0,
    ...over,
  });
  jsonl(join(dir, 'tool-audit', 'b1', `${day(now)}.jsonl`), [
    tool({}),
    tool({}),
    tool({ toolName: 'ask_human' }),
    tool({ toolName: 'collaborate', args: { targetBotId: 'b2' }, success: false }),
    tool({ toolName: 'send_message' }),
    tool({ toolName: 'mesh_publish' }),
  ]);

  // ── Outcomes / karma / schedules ──
  jsonl(join(dir, 'outcome-ledger', 'b1', 'outcomes.jsonl'), [
    { id: 'o1', botId: 'b1', timestamp: now - 2 * H, type: 'CONTENT', status: 'produced' },
    { id: 'o2', botId: 'b1', timestamp: now - 26 * H, type: 'CONTENT', status: 'stale' },
  ]);
  jsonl(join(dir, 'karma', 'b1', 'events.jsonl'), [
    {
      id: 'k1',
      botId: 'b1',
      timestamp: iso(now - H),
      delta: 3,
      reason: 'good',
      source: 'production',
    },
  ]);
  json(join(dir, 'agent-scheduler', 'schedules.json'), {
    b1: {
      nextRunAt: now + 5 * H,
      lastRunAt: now - H,
      nextCheckIn: '6h',
      consecutiveIdleCycles: 0,
      recentActions: [
        { cycle: 1, timestamp: now - H, tools: ['file_write'], planSummary: 'wrote digest' },
      ],
      lastLoggedSummary: 'Wrote the weekly digest',
      retryCount: 0,
      lastErrorMessage: null,
      cyclesSinceAskHuman: 1,
    },
    b3: {
      nextRunAt: now + H,
      lastRunAt: now - 2 * H,
      nextCheckIn: '6h',
      consecutiveIdleCycles: 7,
      recentActions: [],
      lastLoggedSummary: null,
      retryCount: 4,
      lastErrorMessage: 'planner exploded',
      cyclesSinceAskHuman: 9,
    },
  });

  // ── Conversations (inbox asks, b1) ──
  const askCreated = now - 6 * H;
  jsonl(join(dir, 'conversations', 'b1', 'conversations.jsonl'), [
    {
      id: 'c1',
      botId: 'b1',
      type: 'inbox',
      title: 'Which topic?',
      createdAt: iso(askCreated),
      updatedAt: iso(askCreated + 5 * 60_000),
      messageCount: 2,
      askHumanQuestionId: 'q1',
      inboxStatus: 'answered',
    },
    {
      id: 'c2',
      botId: 'b1',
      type: 'inbox',
      title: 'Short?',
      createdAt: iso(now - H),
      updatedAt: iso(now - H),
      messageCount: 1,
      askHumanQuestionId: 'q2',
      inboxStatus: 'pending',
    },
  ]);
  jsonl(join(dir, 'conversations', 'b1', 'messages', 'c1.jsonl'), [
    { id: 'm1', role: 'bot', content: 'q'.repeat(400), createdAt: iso(askCreated) },
    { id: 'm2', role: 'human', content: 'crypto', createdAt: iso(askCreated + 5 * 60_000) },
  ]);
  jsonl(join(dir, 'conversations', 'b1', 'messages', 'c2.jsonl'), [
    { id: 'm3', role: 'bot', content: 'short?', createdAt: iso(now - H) },
  ]);

  // ── Sessions / cron / mesh ──
  json(join(dir, 'sessions', 'sessions.json'), {
    'bot:b1:private:42': {
      key: 'bot:b1:private:42',
      createdAt: iso(now - 3 * DAY),
      lastActivityAt: iso(now - 2 * DAY),
      messageCount: 6,
      compactionCount: 0,
    },
  });
  json(join(dir, 'cron', 'jobs.json'), {
    version: 1,
    jobs: [
      {
        id: 'j1',
        name: 'digest',
        enabled: true,
        createdAtMs: 0,
        updatedAtMs: 0,
        schedule: { kind: 'cron', expr: '0 9 * * *' },
        payload: { kind: 'instruction', text: 'x', chatId: 1, botId: 'b1' },
        state: { lastStatus: 'ok', lastRunAtMs: now - DAY, consecutiveErrors: 0 },
      },
    ],
  });
  jsonl(join(dir, 'shared', 'knowledge-mesh.jsonl'), [
    {
      id: 'i1',
      sourceBotId: 'b1',
      topic: 't',
      insight: 'x',
      confidence: 0.8,
      timestamp: now - H,
      validatedBy: [],
      contradictedBy: [],
    },
  ]);

  // ── Logs ──
  const line = (over: Record<string, unknown>) =>
    JSON.stringify({ level: 30, time: now - H, pid: 1, hostname: 'h', ...over });
  mkdirSync(join(dir, 'logs'), { recursive: true });
  writeFileSync(
    join(dir, 'logs', 'aibot.log'),
    `${[
      line({ msg: 'Starting AIBot Framework v1.0.0', time: now - 10 * H }),
      line({
        botId: 'b1',
        durationMs: 4000,
        priority: 'high',
        isIdle: false,
        msg: 'Agent loop completed for bot',
      }),
      line({
        botId: 'b1',
        durationMs: 2000,
        priority: 'none',
        isIdle: true,
        msg: 'Agent loop completed for bot',
      }),
      line({
        level: 40,
        botId: 'b1',
        warnings: ['off-goal'],
        msg: 'Agent loop: post-execution alignment check found issues',
      }),
      line({ level: 40, botId: 'b1', round: 3, msg: 'Tool loop detector: breaking' }),
      line({
        level: 40,
        botId: 'b3',
        err: { message: '401: Unauthorized' },
        msg: 'Telegram start failed — falling back to headless mode. Token rejected (401 Unauthorized).',
      }),
      line({
        level: 40,
        botId: 'b1',
        summary: { critical: 1, warn: 0, info: 2 },
        msg: 'Security audit: CRITICAL issues found',
      }),
      line({
        level: 40,
        model: 'qwen',
        err: { message: 'HTTP 429 Too Many Requests' },
        msg: 'Primary model failed, trying fallbacks',
      }),
      line({ level: 50, sourceBotId: 'b1', targetBotId: 'b3', msg: 'collaborate send failed' }),
    ].join('\n')}\n`
  );

  // ── Soul (b1) ──
  const soul = soulDir('b1');
  mkdirSync(join(soul, 'memory'), { recursive: true });
  writeFileSync(
    join(soul, 'GOALS.md'),
    '## Active Goals\n\n- [ ] **Weekly digest**\n  - status: in_progress\n  - priority: high\n- [ ] Research topic\n  - status: pending\n\n## Completed\n\n- [x] Setup\n  - completed: 2026-08-01\n'
  );
  writeFileSync(join(soul, 'SOUL.md'), 'I am bot one.\n');
  writeFileSync(join(soul, 'IDENTITY.md'), 'name: Bot One\n');
  writeFileSync(join(soul, 'MEMORY.md'), 'remember this\n');
  writeFileSync(join(soul, 'MOTIVATIONS.md'), '## Reflection log\n- date: 2026-08-15\n');
  writeFileSync(join(soul, '.last-health-check'), String(now - DAY));
  writeFileSync(join(soul, 'memory', '2000-01-01.md'), 'ancient');
  json(join(soul, 'TRAITS.json'), {
    current: { curiosity: 0.7, caution: 0.5 },
    history: [
      { timestamp: now - 2 * DAY, source: 'strategist', traits: { curiosity: 0.5, caution: 0.5 } },
      { timestamp: now - DAY, source: 'adaptive', traits: { curiosity: 0.7, caution: 0.5 } },
    ],
  });
  jsonl(join(soul, 'feedback.jsonl'), [
    { id: 'f1', botId: 'b1', content: 'nice', createdAt: iso(now - 3 * DAY), status: 'applied' },
  ]);

  // ── Productions (b1) ──
  jsonl(join(dir, 'productions', 'b1', 'changelog.jsonl'), [
    {
      id: 'p1',
      timestamp: iso(now - 5 * DAY),
      botId: 'b1',
      tool: 'file_write',
      path: 'old.md',
      action: 'create',
      size: 10,
      evaluation: { status: 'approved', rating: 4 },
    },
    {
      id: 'p2',
      timestamp: iso(now - DAY),
      botId: 'b1',
      tool: 'file_write',
      path: 'digest.md',
      action: 'create',
      size: 20,
    },
    {
      id: 'p3',
      timestamp: iso(now - 12 * H),
      botId: 'b1',
      tool: 'archive',
      path: 'archived/old.md',
      action: 'archive',
      size: 10,
      archivedFrom: 'old.md',
    },
  ]);

  return { dir, now, config, bots: { b1, b2, b3 }, soulDir };
}
