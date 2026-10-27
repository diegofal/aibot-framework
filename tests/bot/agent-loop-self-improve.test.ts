/**
 * The agent loop's self-improvement wiring (`docs/plans/self-improve-plan.md`,
 * bot loop): with `agentLoop.selfImprove.enabled`, the bot's lessons reach the
 * planner (periodic and continuous) and the executor prompt, and after the
 * cycle the runner writes a lesson for a repeated failure class, logging its
 * LLM call as `self-improve` under the cycle. Off: none of it.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentLoop } from '../../src/bot/agent-loop';
import { LessonStore } from '../../src/bot/self-improve/store';
import type { Lesson } from '../../src/bot/self-improve/types';
import { GlobalAgentLoopConfigSchema } from '../../src/config';

function mockLogger(): any {
  const l: any = {
    info: mock(() => {}),
    warn: mock(() => {}),
    error: mock(() => {}),
    debug: mock(() => {}),
  };
  l.child = () => l;
  return l;
}

const GOALS = `## Active Goals
- [ ] Map the Acme account
  - status: in_progress
  - priority: medium
  - id: g-bbbbbbbb
`;

const LESSON_TEXT = 'Get the exact path from read_production_log before file_read.';

let dataDir: string;
let soulDir: string;
beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'aibot-self-improve-loop-'));
  soulDir = join(dataDir, 'soul');
  mkdirSync(soulDir, { recursive: true });
  writeFileSync(join(soulDir, 'GOALS.md'), GOALS);
});
afterEach(() => rmSync(dataDir, { recursive: true, force: true }));

function seedLesson(): void {
  const now = new Date().toISOString();
  const lesson: Lesson = {
    id: 'l-aaaaaaaa',
    classKey: 'file_read:file-not-found',
    tool: 'file_read',
    errorClass: 'file-not-found',
    text: LESSON_TEXT,
    textSource: 'model',
    evidence: [],
    source: 'own',
    status: 'active',
    createdAt: now,
    updatedAt: now,
    baseline: { failures: 3, calls: 5, rate: 0.6, sinceMs: 0, untilMs: 0 },
  };
  new LessonStore(soulDir).write({ version: 1, lessons: [lesson], suppressed: [] });
}

/** Three failing file_read calls in the bot's tool audit, the last hour. */
function seedAuditFailures(): void {
  const dir = join(dataDir, 'tool-audit', 'bot1');
  mkdirSync(dir, { recursive: true });
  const now = Date.now();
  const lines = [1, 2, 3].map((i) => {
    const ts = new Date(now - i * 10 * 60_000).toISOString();
    return JSON.stringify({
      timestamp: ts,
      botId: 'bot1',
      chatId: 0,
      toolName: 'file_read',
      args: { path: 'longlist.md' },
      success: false,
      result: 'File not found: /app/productions/bot1/longlist.md',
      durationMs: 3,
      retryAttempts: 0,
    });
  });
  for (const [i, line] of lines.entries()) {
    const day = JSON.parse(line).timestamp.slice(0, 10);
    writeFileSync(join(dir, `${day}.jsonl`), `${line}\n`, { flag: i === 0 ? 'w' : 'a' });
  }
}

function makeLoop(opts: { enabled: boolean; mode?: string }) {
  const soulLoader = {
    getDir: () => soulDir,
    readIdentity: () => 'id',
    readSoul: () => 'soul',
    readMotivations: () => 'mot',
    readGoals: () => GOALS,
    readRecentDailyLogs: () => '',
    readDailyLogsSince: () => '',
    appendDailyMemory: () => {},
    writeGoals: () => {},
  };
  const plannerTexts: string[] = [];
  const executorTexts: string[] = [];
  const answer = JSON.stringify({
    reasoning: 'r',
    plan: ['Read the longlist'],
    priority: 'medium',
  });
  const llm: any = {
    backend: 'ollama',
    generate: mock((p: string, o: { system?: string }) => {
      plannerTexts.push(`${o?.system ?? ''}\n${p}`);
      return Promise.resolve({ text: answer });
    }),
    chat: mock((messages: Array<{ content: string }>) => {
      executorTexts.push(messages.map((m) => m.content).join('\n'));
      return Promise.resolve({ text: 'executed' });
    }),
    getBackendClient: () => llm,
  };
  const queryLog: any[] = [];
  const botConfig = {
    id: 'bot1',
    name: 'Bot 1',
    agentLoop: { mode: opts.mode ?? 'periodic', selfImprove: { enabled: opts.enabled } },
  };
  const ctx: any = {
    config: {
      agentLoop: GlobalAgentLoopConfigSchema.parse({ strategist: { enabled: false } }),
      conversation: { systemPrompt: '', temperature: 0.7, maxHistory: 10 },
      bots: [botConfig],
      paths: { data: dataDir },
      ollama: { models: { primary: 'm' } },
      claudeCli: { model: 'c' },
      karma: { enabled: false },
      productions: { baseDir: join(dataDir, 'productions') },
      soul: { dir: soulDir },
    },
    runningBots: new Set(['bot1']),
    logger: mockLogger(),
    tools: [],
    soulLoaders: new Map([['bot1', soulLoader]]),
    llmClients: new Map([['bot1', llm]]),
    agentFeedbackStore: { getPending: () => [] },
    askHumanStore: { consumeAnswersForBot: () => [], getPendingForBot: () => [] },
    askPermissionStore: {
      consumeDecisionsForBot: () => [],
      getPendingForBot: () => [],
      reportExecution: () => {},
    },
    llmQueryLog: { append: (e: any) => queryLog.push(e) },
    sessionManager: { listSessions: () => [] },
    getLLMClient: () => llm,
    getActiveModel: () => 'm',
    getBotLogger: () => mockLogger(),
    getSoulLoader: () => soulLoader,
    resolveBotId: (id: string) => id,
    activityStream: { publish: mock(() => {}) },
  };
  const loop = new AgentLoop(
    ctx,
    { build: () => 'system' } as any,
    { getDefinitionsForBot: () => [], getDefinitionsByCategories: () => [] } as any
  );
  (loop as any).scheduler.syncSchedules();
  return { loop, plannerTexts, executorTexts, queryLog };
}

function cycleRow(): any {
  const dir = join(dataDir, 'agent-cycles', 'bot1');
  const [file] = readdirSync(dir);
  return JSON.parse(readFileSync(join(dir, file), 'utf-8').split('\n')[0]);
}

const SECTION = '## Lessons from your own mistakes';

describe('agent loop: self-improvement', () => {
  for (const mode of ['periodic', 'continuous']) {
    test(`${mode}: on, the lessons reach the planner and the executor`, async () => {
      seedLesson();
      const { loop, plannerTexts, executorTexts } = makeLoop({ enabled: true, mode });
      await loop.runOne('bot1');
      const planner = plannerTexts.find((t) => t.includes(SECTION));
      expect(planner).toBeDefined();
      expect(planner).toContain(LESSON_TEXT);
      expect(executorTexts.some((t) => t.includes(SECTION) && t.includes(LESSON_TEXT))).toBe(true);
    });
  }

  test('off: no lessons in any prompt, even with a LESSONS.json', async () => {
    seedLesson();
    const { loop, plannerTexts, executorTexts } = makeLoop({ enabled: false });
    await loop.runOne('bot1');
    expect(plannerTexts.length).toBeGreaterThan(0);
    expect(plannerTexts.some((t) => t.includes(SECTION))).toBe(false);
    expect(executorTexts.some((t) => t.includes(SECTION))).toBe(false);
  });

  test('on: after the cycle a repeated failure class becomes a lesson, logged under the cycle', async () => {
    seedAuditFailures();
    const { loop, queryLog } = makeLoop({ enabled: true });
    await loop.runOne('bot1');
    const { cycleId } = cycleRow();
    const lessons = new LessonStore(soulDir).read().lessons;
    expect(lessons).toHaveLength(1);
    expect(lessons[0]).toMatchObject({ classKey: 'file_read:file-not-found', cycleId });
    const entry = queryLog.find((e) => e.caller === 'self-improve');
    expect(entry).toMatchObject({ botId: 'bot1', cycleId, success: true });
  });

  test('off: nothing is written after the cycle', async () => {
    seedAuditFailures();
    const { loop, queryLog } = makeLoop({ enabled: false });
    await loop.runOne('bot1');
    expect(existsSync(join(soulDir, 'LESSONS.json'))).toBe(false);
    expect(queryLog.some((e) => e.caller === 'self-improve')).toBe(false);
  });
});
