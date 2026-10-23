/**
 * The agent loop shows the fleet watcher's pending broadcasts to the planner
 * ("## Fleet broadcast"), marks them shown for the cycle, and records on the
 * cycle row which ones were shown (`broadcastIds`) and which one the plan
 * served (`servesBroadcast`, only when it was shown). Watcher phase 3.
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
import type { WatcherBroadcastSource } from '../../src/bot/types';
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

let dataDir: string;
let soulDir: string;
beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'aibot-fleet-broadcast-'));
  soulDir = join(dataDir, 'soul');
  mkdirSync(soulDir, { recursive: true });
  writeFileSync(join(soulDir, 'GOALS.md'), GOALS);
});
afterEach(() => rmSync(dataDir, { recursive: true, force: true }));

function fakeSource(items: Array<{ id: string; kind: 'wake' | 'directive'; text: string }>) {
  const shown: Array<{ ids: string[]; cycleId?: string }> = [];
  let pending = [...items];
  const source: WatcherBroadcastSource = {
    pendingFor: (botId) => (botId === 'bot1' ? pending : []),
    markShown: (ids, cycleId) => {
      shown.push({ ids, cycleId });
      pending = pending.filter((p) => !ids.includes(p.id));
    },
  };
  return { source, shown };
}

function makeLoop(answer: string, opts: { source?: WatcherBroadcastSource; mode?: string } = {}) {
  const soulLoader = {
    readIdentity: () => 'id',
    readSoul: () => 'soul',
    readMotivations: () => 'mot',
    readGoals: () => GOALS,
    readRecentDailyLogs: () => '',
    readDailyLogsSince: () => '',
    appendDailyMemory: () => {},
    writeGoals: () => {},
  };
  const systems: string[] = [];
  const llm: any = {
    backend: 'ollama',
    generate: mock((_p: string, o: { system?: string }) => {
      systems.push(o?.system ?? '');
      return Promise.resolve({ text: answer });
    }),
    chat: mock(() => Promise.resolve({ text: 'executed' })),
    getBackendClient: () => llm,
  };
  const botConfig = { id: 'bot1', name: 'Bot 1', agentLoop: { mode: opts.mode ?? 'periodic' } };
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
    llmQueryLog: { append: () => {} },
    sessionManager: { listSessions: () => [] },
    getLLMClient: () => llm,
    getActiveModel: () => 'm',
    getBotLogger: () => mockLogger(),
    getSoulLoader: () => soulLoader,
    resolveBotId: (id: string) => id,
    activityStream: { publish: mock(() => {}) },
    ...(opts.source ? { watcherBroadcasts: opts.source } : {}),
  };
  const loop = new AgentLoop(
    ctx,
    { build: () => 'system' } as any,
    { getDefinitionsForBot: () => [], getDefinitionsByCategories: () => [] } as any
  );
  (loop as any).scheduler.syncSchedules();
  return { loop, systems };
}

function cycleRows(): any[] {
  const dir = join(dataDir, 'agent-cycles', 'bot1');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((f) =>
    readFileSync(join(dir, f), 'utf-8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l))
  );
}

const plan = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({ reasoning: 'r', plan: ['Talk to Scout'], priority: 'medium', ...extra });

const items = [
  { id: 'b-11111111', kind: 'directive' as const, text: 'Coordinate with Scout on Acme' },
  { id: 'b-22222222', kind: 'wake' as const, text: '' },
];

describe('agent loop: fleet broadcasts', () => {
  for (const mode of ['periodic', 'continuous']) {
    test(`${mode}: the planner sees them, they are marked shown, the row records them`, async () => {
      const { source, shown } = fakeSource(items);
      const { loop, systems } = makeLoop(plan({ serves_broadcast: 'b-11111111' }), {
        source,
        mode,
      });
      await loop.runOne('bot1');
      expect(systems.some((s) => s.includes('## Fleet broadcast'))).toBe(true);
      expect(systems.some((s) => s.includes('- [b-11111111] directive: Coordinate'))).toBe(true);
      const [row] = cycleRows();
      expect(shown).toEqual([{ ids: ['b-11111111', 'b-22222222'], cycleId: row.cycleId }]);
      expect(row.broadcastIds).toEqual(['b-11111111', 'b-22222222']);
      expect(row.servesBroadcast).toBe('b-11111111');
    });
  }

  test('a serves_broadcast the planner was not shown is not recorded', async () => {
    const { source } = fakeSource(items);
    const { loop } = makeLoop(plan({ serves_broadcast: 'b-99999999' }), { source });
    await loop.runOne('bot1');
    const [row] = cycleRows();
    expect(row.broadcastIds).toEqual(['b-11111111', 'b-22222222']);
    expect(row).not.toHaveProperty('servesBroadcast');
  });

  test('without broadcasts there is no section and the row has no broadcast fields', async () => {
    const { source } = fakeSource([]);
    const { loop, systems } = makeLoop(plan(), { source });
    await loop.runOne('bot1');
    expect(systems.some((s) => s.includes('## Fleet broadcast'))).toBe(false);
    const [row] = cycleRows();
    expect(row).not.toHaveProperty('broadcastIds');
    expect(row).not.toHaveProperty('servesBroadcast');
  });

  test('without a watcher nothing changes', async () => {
    const { loop, systems } = makeLoop(plan({ serves_broadcast: 'b-11111111' }));
    await loop.runOne('bot1');
    expect(systems.some((s) => s.includes('## Fleet broadcast'))).toBe(false);
    expect(cycleRows()[0]).not.toHaveProperty('servesBroadcast');
  });

  test('a source that throws only drops the section', async () => {
    const source: WatcherBroadcastSource = {
      pendingFor: () => {
        throw new Error('boom');
      },
      markShown: () => {},
    };
    const { loop, systems } = makeLoop(plan(), { source });
    await loop.runOne('bot1');
    expect(systems.length).toBeGreaterThan(0);
    expect(cycleRows()[0].status).toBeDefined();
  });
});
