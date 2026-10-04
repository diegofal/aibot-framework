import { describe, expect, it } from 'bun:test';
import {
  createCuriosityCallRecorder,
  createFleetDispatchLimiter,
  createOperatorDispatchDeliverer,
  createTenantCallMeter,
} from '../../../src/bot/curiosity/loop-wiring';

const logger = { warn() {}, info() {}, debug() {}, error() {} } as any;

const fakeBot = (sent: Array<[number, string]>, fail = false) => ({
  api: {
    sendMessage: async (chatId: number, text: string) => {
      if (fail) throw new Error('403');
      sent.push([chatId, text]);
    },
  },
});

describe('createOperatorDispatchDeliverer', () => {
  it('sends through the bot’s own Telegram instance to the operator chat', async () => {
    const own: Array<[number, string]> = [];
    const any: Array<[number, string]> = [];
    const deliver = createOperatorDispatchDeliverer({
      getOperatorChatId: () => 42,
      getBot: () => fakeBot(own),
      getAnyBot: () => fakeBot(any),
      logger,
    });
    expect(await deliver('b', 'hello')).toBe('telegram');
    expect(own).toEqual([[42, 'hello']]);
    expect(any).toEqual([]);
  });

  it('falls back to any live instance for headless bots', async () => {
    const any: Array<[number, string]> = [];
    const deliver = createOperatorDispatchDeliverer({
      getOperatorChatId: () => 42,
      getBot: () => undefined,
      getAnyBot: () => fakeBot(any),
      logger,
    });
    expect(await deliver('b', 'hi')).toBe('telegram');
    expect(any).toEqual([[42, 'hi']]);
  });

  it('counts as delivered to the dashboard inbox when there is no Telegram route', async () => {
    const noChat = createOperatorDispatchDeliverer({
      getOperatorChatId: () => undefined,
      getBot: () => undefined,
      getAnyBot: () => undefined,
      logger,
    });
    expect(await noChat('b', 'x')).toBe('inbox');
    const noBot = createOperatorDispatchDeliverer({
      getOperatorChatId: () => 42,
      getBot: () => undefined,
      getAnyBot: () => undefined,
      logger,
    });
    expect(await noBot('b', 'x')).toBe('inbox');
  });

  it('reports failure when Telegram rejects the send', async () => {
    const deliver = createOperatorDispatchDeliverer({
      getOperatorChatId: () => 42,
      getBot: () => fakeBot([], true),
      getAnyBot: () => undefined,
      logger,
    });
    expect(await deliver('b', 'x')).toBe(false);
  });
});

describe('createFleetDispatchLimiter', () => {
  it('enforces the fleet daily cap across bots', () => {
    let t = 0;
    const limiter = createFleetDispatchLimiter(() => 2, () => t);
    expect(limiter.allows('a')).toBe(true);
    limiter.record('a');
    limiter.record('b');
    expect(limiter.allows('c')).toBe(false);
    t += 24 * 3_600_000 + 1;
    expect(limiter.allows('c')).toBe(true);
  });

  it('a cap of 0 disables the limit', () => {
    const limiter = createFleetDispatchLimiter(() => 0);
    for (let i = 0; i < 50; i++) limiter.record('a');
    expect(limiter.allows('a')).toBe(true);
  });
});

describe('createCuriosityCallRecorder', () => {
  const at = new Date('2026-10-04T05:00:00.000Z');
  const usage = { promptTokens: 100, completionTokens: 20, totalTokens: 120, model: 'opus' };

  it('appends every call to the query log with the curiosity caller', () => {
    const entries: any[] = [];
    const record = createCuriosityCallRecorder({
      botId: 'b',
      model: 'fallback-model',
      backend: 'claude-cli',
      appendQueryLog: (e) => entries.push(e),
      now: () => at,
    });
    record({ caller: 'curiosity:editor', durationMs: 900, success: true, usage });
    expect(entries).toEqual([
      {
        timestamp: at.toISOString(),
        botId: 'b',
        caller: 'curiosity:editor',
        model: 'opus',
        backend: 'claude-cli',
        promptTokens: 100,
        completionTokens: 20,
        totalTokens: 120,
        durationMs: 900,
        success: true,
        error: undefined,
      },
    ]);
  });

  it('falls back to the configured model when the call reports no usage', () => {
    const entries: any[] = [];
    const record = createCuriosityCallRecorder({
      botId: 'b',
      model: 'qwen',
      backend: 'ollama',
      appendQueryLog: (e) => entries.push(e),
    });
    record({ caller: 'curiosity:navigator', durationMs: 5, success: false, error: 'boom' });
    expect(entries[0].model).toBe('qwen');
    expect(entries[0].success).toBe(false);
    expect(entries[0].error).toBe('boom');
  });

  it('meters one llm request per call, failed attempts included, tagged with the caller', () => {
    const metered: Array<[number, Record<string, unknown>]> = [];
    const record = createCuriosityCallRecorder({
      botId: 'b',
      model: 'm',
      backend: 'ollama',
      meter: (q, meta) => metered.push([q, meta]),
    });
    record({ caller: 'curiosity:extractor', durationMs: 1, success: true });
    record({ caller: 'curiosity:navigator', durationMs: 1, success: false, error: 'x' });
    expect(metered).toEqual([
      [1, { caller: 'curiosity:extractor' }],
      [1, { caller: 'curiosity:navigator' }],
    ]);
  });

  it('a throwing sink never escapes (the runner must not fail a cycle)', () => {
    const record = createCuriosityCallRecorder({
      botId: 'b',
      model: 'm',
      backend: 'ollama',
      appendQueryLog: () => {
        throw new Error('disk full');
      },
      meter: () => {
        throw new Error('tenant store down');
      },
    });
    expect(() =>
      record({ caller: 'curiosity:editor', durationMs: 1, success: true })
    ).not.toThrow();
  });
});

describe('createTenantCallMeter', () => {
  const setup = (tenantId: string | undefined, multi: boolean) => {
    const usage: any[] = [];
    const meter = createTenantCallMeter({
      botId: 'b',
      getTenantId: () => tenantId,
      isMultiTenant: () => multi,
      recordUsage: (...args) => usage.push(args),
    });
    return { meter, usage };
  };

  it('records an llm_request against the bot’s tenant in multi-tenant mode', () => {
    const { meter, usage } = setup('t1', true);
    meter(1, { caller: 'curiosity:editor' });
    expect(usage).toEqual([['t1', 'b', 'llm_request', 1, { caller: 'curiosity:editor' }]]);
  });

  it('records nothing for a bot without a tenant', () => {
    const { meter, usage } = setup(undefined, true);
    meter(1, {});
    expect(usage).toEqual([]);
  });

  it('records nothing when multi-tenant is off', () => {
    const { meter, usage } = setup('t1', false);
    meter(1, {});
    expect(usage).toEqual([]);
  });

  it('resolves the tenant at call time, so a reassigned bot meters to its new tenant', () => {
    let tenant = 't1';
    const usage: any[] = [];
    const meter = createTenantCallMeter({
      botId: 'b',
      getTenantId: () => tenant,
      isMultiTenant: () => true,
      recordUsage: (...args) => usage.push(args),
    });
    tenant = 't2';
    meter(1, {});
    expect(usage[0][0]).toBe('t2');
  });
});
