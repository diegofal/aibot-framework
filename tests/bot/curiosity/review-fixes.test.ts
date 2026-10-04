/**
 * Regression tests for the curiosity review findings (2026-10-03).
 * One describe per finding; the numbers match the review.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { CURIOSITY_PRESETS, resolveCuriosity } from '../../../src/bot/curiosity/config';
import {
  decideCycleMode,
  noteCycle,
  recordCycle,
  renderFrontierForPrompt,
  selectFrontierItem,
} from '../../../src/bot/curiosity/cycle';
import { addDirective, renderDirectivesForPrompt } from '../../../src/bot/curiosity/directives';
import { buildDigestCandidate } from '../../../src/bot/curiosity/dispatch';
import { emptyKnowledgeMap, mergeExtraction } from '../../../src/bot/curiosity/knowledge-map';
import { createOperatorDispatchDeliverer } from '../../../src/bot/curiosity/loop-wiring';
import { shouldRunNavigator } from '../../../src/bot/curiosity/navigator';
import { beginCuriosityCycle, finishCuriosityCycle } from '../../../src/bot/curiosity/runner';
import type { RunnerDeps } from '../../../src/bot/curiosity/runner';
import { CuriosityService } from '../../../src/bot/curiosity/service';
import {
  CURIOSITY_FILES,
  CuriosityStore,
  DISPATCH_KEEP,
  emptyNavigatorState,
  emptyTasteProfile,
} from '../../../src/bot/curiosity/store';
import { applyIgnored } from '../../../src/bot/curiosity/taste';
import type { Dispatch, FrontierItem } from '../../../src/bot/curiosity/types';
import type { CuriosityConfig } from '../../../src/config';

const ROOT = join(import.meta.dir, '.tmp-curiosity-review');
const NOW = '2026-10-03T12:00:00.000Z';
const logger = { warn() {}, info() {}, debug() {}, error() {} } as any;
const cfg = resolveCuriosity(undefined, undefined);

const fi = (id: string, over: Partial<FrontierItem> = {}): FrontierItem => ({
  id,
  question: `question ${id}`,
  whyInteresting: 'w',
  bridge: 'b',
  distance: 1,
  surpriseScore: 0.5,
  createdAt: NOW,
  status: 'open',
  ...over,
});

const dispatch = (over: Partial<Dispatch> = {}): Dispatch => ({
  id: 'd1',
  botId: 'b',
  createdAt: NOW,
  kind: 'insight',
  topic: 't',
  hook: 'h',
  whyCare: 'w',
  evidence: 'e',
  action: 'a',
  body: 'b',
  editorScore: 0.8,
  status: 'sent',
  sentAt: '2026-09-30T00:00:00.000Z',
  ...over,
});

let svc: CuriosityService;
let botCfg: CuriosityConfig | undefined;
beforeEach(() => {
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(ROOT, { recursive: true });
  botCfg = undefined;
  svc = new CuriosityService({
    getSoulDir: (id) => join(ROOT, id),
    getCuriosityInputs: () => ({ global: undefined, bot: botCfg }),
    now: () => NOW,
  });
});
afterEach(() => rmSync(ROOT, { recursive: true, force: true }));

describe('#1 only the operator steers', () => {
  it('recordOperatorMessage ignores short chatter', () => {
    expect(svc.recordOperatorMessage('b', 'thanks!')).toBe(false);
    expect(svc.recordOperatorMessage('b', 'Go deep on retrieval economics next')).toBe(true);
    expect(svc.storeFor('b')!.loadNavigator().directives).toHaveLength(1);
  });

  it('does not write state for a bot with curiosity disabled', () => {
    botCfg = { enabled: false };
    expect(svc.recordOperatorMessage('b', 'Go deep on retrieval economics next')).toBe(false);
    svc.recordDirective('b', 'Another long enough instruction', 'feedback');
    expect(svc.storeFor('b')!.loadNavigator().directives).toHaveLength(0);
  });

  it('renders directives within a char budget', () => {
    let nav = emptyNavigatorState();
    for (let i = 0; i < 20; i++) {
      nav = addDirective(nav, {
        text: `instruction ${i} ${'detail '.repeat(150)} unique${i * 31}`,
        source: 'message',
        receivedAt: NOW,
      });
    }
    expect(renderDirectivesForPrompt(nav).length).toBeLessThanOrEqual(2500);
  });
});

describe('#2 exploring items never get stranded', () => {
  it('exploring items stay selectable and get a small priority', () => {
    const map = {
      ...emptyKnowledgeMap(),
      frontier: [
        fi('a', { surpriseScore: 0.55 }),
        fi('b', { status: 'exploring', surpriseScore: 0.5 }),
      ],
    };
    expect(selectFrontierItem(map, CURIOSITY_PRESETS.explorer).item?.id).toBe('b');
  });

  it('the prompt still shows exploring items', () => {
    const map = { ...emptyKnowledgeMap(), frontier: [fi('x', { status: 'exploring' })] };
    expect(renderFrontierForPrompt(map, CURIOSITY_PRESETS.explorer)).toContain('[x]');
  });
});

describe('#3 explore decisions cannot freeze', () => {
  it('noteCycle advances the explore counter without touching the log', () => {
    let nav = noteCycle(emptyNavigatorState(), 'exploit');
    expect(nav.cyclesSinceExplore).toBe(1);
    nav = noteCycle(nav, 'explore');
    expect(nav.cyclesSinceExplore).toBe(0);
    expect(nav.cycleLog).toHaveLength(0);
  });

  it('an explore cycle resets the no-surprise streak', () => {
    let nav = { ...emptyNavigatorState(), noSurpriseStreak: 5 };
    nav = recordCycle(nav, { at: NOW, topic: 't', mode: 'explore', surprised: false });
    expect(nav.noSurpriseStreak).toBe(0);
  });

  it('right after exploring, streak/concentration do not trigger another explore', () => {
    const nav = {
      ...emptyNavigatorState(),
      cyclesSinceExplore: 0,
      noSurpriseStreak: 10,
      cycleLog: Array.from({ length: 8 }, () => ({
        at: NOW,
        topic: 't',
        mode: 'exploit' as const,
        surprised: false,
      })),
    };
    expect(decideCycleMode(nav, cfg).mode).toBe('exploit');
    expect(decideCycleMode({ ...nav, cyclesSinceExplore: 1 }, cfg).mode).toBe('explore');
  });
});

describe('#7 navigator backs off after a failed attempt', () => {
  it('does not retry within the backoff window', () => {
    const nav = { ...emptyNavigatorState(), lastNavigatorAttemptAt: NOW };
    expect(shouldRunNavigator(nav, cfg, Date.parse(NOW) + 60_000)).toBe(false);
    expect(shouldRunNavigator(nav, cfg, Date.parse(NOW) + 3 * 3_600_000)).toBe(true);
  });

  it('a failing navigator is attempted once, not every cycle', async () => {
    let calls = 0;
    const deps: RunnerDeps = {
      service: svc,
      llm: {
        client: {
          generate: async () => {
            calls++;
            return { text: 'garbage' };
          },
        } as any,
        model: 'm',
      },
      logger,
      deliver: async () => 'inbox',
      applyGoalOperations: () => {},
      now: () => NOW,
    };
    const args = {
      botId: 'b',
      identity: 'I',
      soul: 'S',
      motivations: 'M',
      goals: 'G',
      answered: [],
      feedback: [],
    };
    await beginCuriosityCycle(deps, args);
    await svc.waitForNavigator('b');
    const after1 = calls;
    await beginCuriosityCycle(deps, args);
    await svc.waitForNavigator('b');
    expect(calls).toBe(after1);
  });
});

describe('#6 the navigator never blocks the cycle, and a slow one still lands', () => {
  it('begin returns before the navigator finishes; its result is applied later', async () => {
    let goalOps = 0;
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const nav = JSON.stringify({
      retrospective: 'r',
      direction: {
        summary: 'new direction',
        bets: [{ title: 't', kind: 'explore', rationale: 'r' }],
      },
      goal_operations: [{ action: 'add', goal: 'x' }],
    });
    const deps: RunnerDeps = {
      service: svc,
      llm: {
        client: {
          generate: async () => {
            await gate; // a slow Claude CLI retrospective
            return { text: nav };
          },
        } as any,
        model: 'm',
      },
      logger,
      deliver: async () => 'inbox',
      applyGoalOperations: () => {
        goalOps++;
      },
      now: () => NOW,
    };
    const r = await beginCuriosityCycle(deps, {
      botId: 'b',
      identity: 'I',
      soul: 'S',
      motivations: 'M',
      goals: 'G',
      answered: [],
      feedback: [],
    });
    expect(r?.navigatorStarted).toBe(true);
    expect(svc.storeFor('b')!.loadNavigator().direction).toBeNull();
    release();
    await svc.waitForNavigator('b');
    expect(svc.storeFor('b')!.loadNavigator().direction?.summary).toBe('new direction');
    expect(goalOps).toBe(1);
  });

  it('a second begin while the navigator is in flight does not start another', async () => {
    let calls = 0;
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const deps: RunnerDeps = {
      service: svc,
      llm: {
        client: {
          generate: async () => {
            calls++;
            await gate;
            return { text: 'garbage' };
          },
        } as any,
        model: 'm',
      },
      logger,
      deliver: async () => 'inbox',
      applyGoalOperations: () => {},
      now: () => NOW,
    };
    const args = {
      botId: 'b',
      identity: 'I',
      soul: 'S',
      motivations: 'M',
      goals: 'G',
      answered: [],
      feedback: [],
    };
    await beginCuriosityCycle(deps, args);
    const second = await beginCuriosityCycle(deps, args);
    expect(second?.navigatorStarted).toBe(false);
    release();
    await svc.waitForNavigator('b');
    expect(calls).toBe(2); // one run: first attempt + its parse retry
  });
});

describe('#5 finish applies onto fresh state after the LLM await', () => {
  it('a directive recorded during extraction survives', async () => {
    const store = svc.storeFor('b')!;
    const n = store.loadNavigator();
    n.lastNavigatorAt = NOW;
    store.saveNavigator(n);
    const deps: RunnerDeps = {
      service: svc,
      llm: {
        client: {
          generate: async () => {
            svc.recordOperatorMessage('b', 'Operator says: look at retrieval costs');
            return { text: JSON.stringify({ topic: 'X', surprises: ['s'] }) };
          },
        } as any,
        model: 'm',
      },
      logger,
      deliver: async () => 'inbox',
      applyGoalOperations: () => {},
      now: () => NOW,
    };
    const cycle = (await beginCuriosityCycle(deps, {
      botId: 'b',
      identity: 'I',
      soul: 'S',
      motivations: 'M',
      goals: 'G',
      answered: [],
      feedback: [],
    }))!;
    await finishCuriosityCycle(deps, {
      botId: 'b',
      botName: 'B',
      identity: 'I',
      cycle,
      plan: ['p'],
      summary: 's',
      toolCalls: [],
    });
    const nav = store.loadNavigator();
    expect(nav.directives.map((d) => d.text)).toContain('Operator says: look at retrieval costs');
    expect(nav.cycleLog).toHaveLength(1);
  });

  it('a failed extraction still advances the explore counter', async () => {
    const store = svc.storeFor('b')!;
    const n = store.loadNavigator();
    n.lastNavigatorAt = NOW;
    store.saveNavigator(n);
    const deps: RunnerDeps = {
      service: svc,
      llm: { client: { generate: async () => ({ text: 'nope' }) } as any, model: 'm' },
      logger,
      deliver: async () => 'inbox',
      applyGoalOperations: () => {},
      now: () => NOW,
    };
    const cycle = (await beginCuriosityCycle(deps, {
      botId: 'b',
      identity: 'I',
      soul: 'S',
      motivations: 'M',
      goals: 'G',
      answered: [],
      feedback: [],
    }))!;
    await finishCuriosityCycle(deps, {
      botId: 'b',
      botName: 'B',
      identity: 'I',
      cycle,
      plan: [],
      summary: '',
      toolCalls: [],
    });
    expect(store.loadNavigator().cyclesSinceExplore).toBe(1);
    await finishCuriosityCycle(deps, {
      botId: 'b',
      botName: 'B',
      identity: 'I',
      cycle,
      plan: [],
      summary: '',
      toolCalls: [],
      idle: true,
    });
    expect(store.loadNavigator().cyclesSinceExplore).toBe(2);
  });
});

describe('#9 approving an identity proposal adopts the interest', () => {
  it('signal up on an interest proposal adds it to the map', () => {
    const store = svc.storeFor('b')!;
    store.appendDispatch(
      dispatch({ id: 'p', kind: 'proposal', topic: 'identity', interest: 'information theory' })
    );
    svc.signalDispatch('b', 'p', 'up');
    expect(store.loadMap().interests).toEqual(['information theory']);
  });
});

describe('#11 dispatch edge cases', () => {
  it('repeat clicks do not compound the cadence', () => {
    const store = svc.storeFor('b')!;
    store.appendDispatch(dispatch());
    svc.signalDispatch('b', 'd1', 'up');
    const once = store.loadTaste().cadence.intervalHours;
    svc.signalDispatch('b', 'd1', 'up');
    svc.signalDispatch('b', 'd1', 'up');
    expect(store.loadTaste().cadence.intervalHours).toBe(once);
    expect(store.loadTaste().topics.t.up).toBe(1);
  });

  it('inbox-only dispatches are not counted as ignored', () => {
    const r = applyIgnored(
      emptyTasteProfile(12),
      [dispatch({ deliveredVia: 'inbox' })],
      cfg.dispatch,
      NOW
    );
    expect(r.counted).toEqual([]);
  });

  it('delivery reports the channel, and tenant bots stay in the inbox', async () => {
    const sent: string[] = [];
    const bot = { api: { sendMessage: async (_c: number, t: string) => void sent.push(t) } };
    const deliver = createOperatorDispatchDeliverer({
      getOperatorChatId: () => 42,
      getBot: () => bot,
      getAnyBot: () => bot,
      isTenantBot: (id) => id === 'tenant-bot',
      logger,
    });
    expect(await deliver('own', 'x')).toBe('telegram');
    expect(await deliver('tenant-bot', 'y')).toBe('inbox');
    expect(sent).toEqual(['x']);
  });

  it('the digest action does not promise an unhandled reply', () => {
    const c = buildDigestCandidate([dispatch({ status: 'held' })])!;
    expect(c.action).not.toContain('Reply with a number');
  });
});

describe('#12 dispatch log is bounded', () => {
  it('trims to the newest DISPATCH_KEEP entries', () => {
    const store = new CuriosityStore(join(ROOT, 'trim'));
    for (let i = 0; i < DISPATCH_KEEP + 120; i++) store.appendDispatch(dispatch({ id: `d${i}` }));
    const lines = readFileSync(join(ROOT, 'trim', CURIOSITY_FILES.dispatches), 'utf-8')
      .trim()
      .split('\n');
    expect(lines.length).toBeLessThanOrEqual(DISPATCH_KEEP + 100);
    expect(store.listDispatches(1)[0].id).toBe(`d${DISPATCH_KEEP + 119}`);
  });
});

describe('#5 per-bot exclusivity', () => {
  it('runExclusive serialises work for one bot', async () => {
    const order: string[] = [];
    const slow = svc.runExclusive('b', async () => {
      await new Promise((r) => setTimeout(r, 30));
      order.push('first');
    });
    const fast = svc.runExclusive('b', async () => {
      order.push('second');
    });
    await Promise.all([slow, fast]);
    expect(order).toEqual(['first', 'second']);
  });
});

describe('mergeExtraction still works with the new frontier rules', () => {
  it('sanity', () => {
    const m = mergeExtraction(
      emptyKnowledgeMap(),
      {
        topic: 'x',
        findings: [],
        surprises: [],
        openQuestions: [],
        frontier: [],
        servedDirectiveIds: [],
        noSurprise: true,
      },
      NOW
    );
    expect(m.topics).toHaveLength(1);
  });
});
