/**
 * A question broadcast reaches the operator without the bot's own executor:
 * the shared proactive throttle (keyed `__watcher__`, so the bot's cooldown is
 * untouched and the fleet cap is shared), the bot's Telegram route, an audit
 * row under `__watcher__` (Work → Sent to you), and never karma.
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ToolAuditEntry } from '../../src/bot/tool-audit-log';
import type { Config } from '../../src/config';
import { ProactiveThrottle } from '../../src/tools/send-proactive-message';
import { Broadcaster } from '../../src/watcher/broadcast';
import {
  WATCHER_QUESTION_PREFIX,
  deliverWatcherQuestion,
  fleetBroadcastDelivery,
} from '../../src/watcher/watcher';

const logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as never;
const NOW = Date.parse('2026-10-23T10:00:00Z');

function setup(
  opts: { cooldownMs?: number; dailyCap?: number; telegram?: boolean; fail?: boolean } = {}
) {
  const throttle = new ProactiveThrottle(
    () => ({ cooldownMs: opts.cooldownMs ?? 3_600_000, dailyCap: opts.dailyCap ?? 10 }),
    () => NOW
  );
  const sent: Array<{ chatId: number; text: string }> = [];
  const audit: ToolAuditEntry[] = [];
  const deps = {
    throttle,
    operatorChatId: (): number | undefined => 42,
    telegram: () =>
      opts.telegram === false
        ? undefined
        : {
            api: {
              sendMessage: async (chatId: number, text: string) => {
                if (opts.fail) throw new Error('chat not found');
                sent.push({ chatId, text });
              },
            },
          },
    audit: (e: ToolAuditEntry) => audit.push(e),
    now: () => NOW,
    logger,
  };
  return { deps, throttle, sent, audit };
}

describe('deliverWatcherQuestion', () => {
  test("sends through the bot's Telegram route and audits it under __watcher__", async () => {
    const { deps, sent, audit, throttle } = setup();
    const out = await deliverWatcherQuestion(deps, 'b1', 'Should Jarvis own the lead?');
    expect(out.ok).toBe(true);
    const message = `${WATCHER_QUESTION_PREFIX}Should Jarvis own the lead?`;
    expect(sent).toEqual([{ chatId: 42, text: message }]);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      botId: '__watcher__',
      toolName: 'send_proactive_message',
      success: true,
      args: { chatId: 'operator', message, aboutBot: 'b1' },
    });
    // The watcher's send is its own: the bot may still send its own proactive message.
    expect(throttle.check('b1').allowed).toBe(true);
    expect(throttle.check('__watcher__').allowed).toBe(false);
  });

  test('a throttle refusal is audited as policy and nothing is sent', async () => {
    const { deps, sent, audit } = setup({ dailyCap: 1 });
    deps.throttle.record('b2'); // a bot used the fleet cap
    const out = await deliverWatcherQuestion(deps, 'b1', 'Anything?');
    expect(out.ok).toBe(false);
    expect(out.detail).toContain('Proactive send throttled');
    expect(sent).toEqual([]);
    expect(audit[0]).toMatchObject({ botId: '__watcher__', success: false, failureKind: 'policy' });
  });

  test('without a Telegram route the dashboard is the channel: delivered, audited, counted', async () => {
    const { deps, audit, throttle } = setup({ telegram: false });
    const out = await deliverWatcherQuestion(deps, 'b1', 'Anything?');
    expect(out.ok).toBe(true);
    expect(out.detail).toContain('Sent to you');
    expect(audit[0].success).toBe(true);
    expect(throttle.check('__watcher__').allowed).toBe(false);
  });

  test('a failed send is audited, reported, and does not use the quota', async () => {
    const { deps, audit, throttle } = setup({ fail: true });
    const out = await deliverWatcherQuestion(deps, 'b1', 'Anything?');
    expect(out.ok).toBe(false);
    expect(audit[0]).toMatchObject({ success: false });
    expect(audit[0].failureKind).toBeUndefined();
    expect(throttle.check('__watcher__').allowed).toBe(true);
  });

  // Like the no-route case: a failure here would be retried and every retry
  // would use one of the bot's 3 broadcasts a day, capping the other kinds.
  test('without an operator chat the dashboard is the channel: delivered, audited, counted', async () => {
    const { deps, sent, audit, throttle } = setup();
    const out = await deliverWatcherQuestion(
      { ...deps, operatorChatId: () => undefined },
      'b1',
      'x'
    );
    expect(out.ok).toBe(true);
    expect(out.detail).toContain('Sent to you');
    expect(sent).toEqual([]);
    expect(audit[0]).toMatchObject({ botId: '__watcher__', success: true });
    expect(throttle.check('__watcher__').allowed).toBe(false);
  });
});

describe('fleetBroadcastDelivery.question', () => {
  test("never runs the bot's executor; uses the shared throttle, the route and the audit", async () => {
    const throttle = new ProactiveThrottle(
      () => ({ cooldownMs: 0, dailyCap: 10 }),
      () => NOW
    );
    const audit: ToolAuditEntry[] = [];
    const sent: string[] = [];
    let executors = 0;
    const manager = {
      getToolRegistry: () => ({
        setFleetMemory: () => {},
        createExecutor: () => {
          executors++;
          return async () => ({ success: true, content: '' });
        },
        getProactiveThrottle: () => throttle,
      }),
      getOperatorTelegramRoute: () => ({
        api: {
          sendMessage: async (_c: number, text: string) => {
            sent.push(text);
          },
        },
      }),
      getToolAuditLog: () => ({ append: (e: ToolAuditEntry) => audit.push(e) }),
    };
    const config = { bots: [{ id: 'b1' }], operator: { telegramChatId: 42 } } as unknown as Config;
    const delivery = fleetBroadcastDelivery(config, manager as never, logger);
    const out = await delivery.question?.('b1', 'Who owns Acme?');
    expect(out?.ok).toBe(true);
    expect(executors).toBe(0);
    expect(sent).toEqual([`${WATCHER_QUESTION_PREFIX}Who owns Acme?`]);
    expect(audit[0].botId).toBe('__watcher__');
  });

  test('without the shared throttle it reports unavailable instead of sending', async () => {
    const manager = { getToolRegistry: () => ({ setFleetMemory: () => {} }) };
    const config = { bots: [], operator: { telegramChatId: 42 } } as unknown as Config;
    const out = await fleetBroadcastDelivery(config, manager as never, logger).question?.(
      'b1',
      'x'
    );
    expect(out?.ok).toBe(false);
  });
});

describe('question broadcasts without an operator Telegram chat (cap)', () => {
  test('a question lands once; repeats are duplicates and other kinds are not capped', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'watcher-q-'));
    try {
      const { deps } = setup();
      const noChat = { ...deps, operatorChatId: (): number | undefined => undefined };
      const b = new Broadcaster({
        dir,
        now: () => NOW,
        delivery: {
          question: (botId: string, text: string) => deliverWatcherQuestion(noChat, botId, text),
          wake: async () => ({ ok: true }),
        },
      });
      const q = {
        botId: 'b1',
        kind: 'question' as const,
        text: 'Who owns Acme?',
        insightId: 'n-1',
      };
      expect((await b.send(q)).status).toBe('delivered');
      expect((await b.send(q)).status).toBe('duplicate');
      expect((await b.send(q)).status).toBe('duplicate');
      expect(b.countToday('b1')).toBe(1);
      const wake = await b.send({ botId: 'b1', kind: 'wake', text: '', insightId: 'n-2' });
      expect(wake.status).toBe('delivered');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('a question refused by the shared throttle is a deferral (cap)', () => {
  test("another bot's question in the cooldown never uses this bot's cap; it is retryable later", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'watcher-q-'));
    try {
      let now = NOW;
      const throttle = new ProactiveThrottle(
        () => ({ cooldownMs: 3_600_000, dailyCap: 10 }),
        () => now
      );
      const sent: string[] = [];
      const woken: string[] = [];
      const qDeps = {
        throttle,
        operatorChatId: (): number | undefined => 42,
        telegram: () => ({
          api: {
            sendMessage: async (_chatId: number, text: string) => {
              sent.push(text);
            },
          },
        }),
        now: () => now,
        logger,
      };
      const b = new Broadcaster({
        dir,
        now: () => now,
        delivery: {
          question: (botId: string, text: string) => deliverWatcherQuestion(qDeps, botId, text),
          wake: (botId: string) => {
            woken.push(botId);
          },
        },
      });
      const qa = {
        botId: 'a',
        kind: 'question' as const,
        text: 'Who owns Acme?',
        insightId: 'n-1',
      };
      const qb = { botId: 'b', kind: 'question' as const, text: 'Is B blocked?', insightId: 'n-2' };
      // One pass: A's question lands, B's is refused by the `__watcher__` cooldown.
      expect((await b.send(qa)).status).toBe('delivered');
      const refused = await b.send(qb);
      expect(refused.status).toBe('deferred');
      expect(b.countToday('b')).toBe(0);
      // Re-proposed in later passes, still within the cooldown: never burns B's cap.
      for (let i = 0; i < 5; i++) {
        now += 60_000;
        expect((await b.send(qb)).status).toBe('deferred');
      }
      expect(b.countToday('b')).toBe(0);
      // B's other kinds still go out.
      const wake = await b.send({ botId: 'b', kind: 'wake', text: '', insightId: 'n-3' });
      expect(wake.status).toBe('delivered');
      expect(woken).toEqual(['b']);
      // After the cooldown the same question is retried and lands.
      now = NOW + 3_600_001;
      expect((await b.send(qb)).status).toBe('delivered');
      expect(b.countToday('b')).toBe(2);
      expect(sent).toHaveLength(2);
      // A deferral is in the file, distinct from a failure, and survives a restart.
      const reloaded = new Broadcaster({ dir, now: () => now, delivery: {} });
      const deferred = reloaded.list({ botId: 'b' }).filter((x) => x.deferred);
      expect(deferred.length).toBe(6);
      expect(reloaded.countToday('b')).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a real Telegram error is still a failure that counts toward the cap', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'watcher-q-'));
    try {
      const { deps } = setup({ fail: true });
      const b = new Broadcaster({
        dir,
        now: () => NOW,
        delivery: { question: (botId, text) => deliverWatcherQuestion(deps, botId, text) },
      });
      const out = await b.send({ botId: 'b1', kind: 'question', text: 'Hi?', insightId: 'n-1' });
      expect(out.status).toBe('failed');
      expect(out.broadcast?.deferred).toBeUndefined();
      expect(b.countToday('b1')).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
