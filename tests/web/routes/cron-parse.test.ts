/**
 * POST /api/cron/parse (session S8 of docs/plans/jarvis-fleet-plan.md): free text
 * -> a cron proposal the UI previews and then posts to the existing POST
 * /api/cron. The LLM is injected; nothing here talks to Ollama or the CLI, and
 * the route never creates a job.
 */
import { describe, expect, it, mock } from 'bun:test';
import { Hono } from 'hono';
import type { Config } from '../../../src/config';
import {
  type CronParseLlm,
  type CronParseLlmResolver,
  buildCronParseLlmResolver,
  cronParseRoutes,
} from '../../../src/web/routes/cron-parse';

const noopLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  child: () => noopLogger,
} as never;

const TZ = 'America/Argentina/Buenos_Aires';
const NOW = Date.UTC(2026, 8, 14, 15, 0, 0);

const config = {
  bots: [
    { id: 'hunter', name: 'Hunter', tenantId: 't1', llmBackend: 'claude-cli' },
    { id: 'echo', name: 'Echo', tenantId: 't2', llmBackend: 'ollama' },
  ],
  operator: { telegramChatId: 4242 },
  datetime: { timezone: TZ },
  agentLoop: { plannerBackend: 'inherit', claudeTimeout: 1000 },
  ollama: { models: { primary: 'llama3' } },
  claudeCli: { model: 'claude-opus-5' },
} as unknown as Config;

function llmReplying(text: string, calls: string[] = []): CronParseLlmResolver {
  return async () => ({
    backend: 'claude-cli',
    model: 'claude-opus-5',
    client: {
      generate: async (prompt: string) => {
        calls.push(prompt);
        return { text };
      },
    },
  });
}

function makeApp(llmFor: CronParseLlmResolver | undefined, tenantId?: string, extra = {}) {
  const app = new Hono();
  if (tenantId) {
    app.use('*', async (c, next) => {
      c.set('tenant', { tenantId, apiKey: 'k', plan: 'pro' });
      return next();
    });
  }
  app.route(
    '/api/cron',
    cronParseRoutes({ config, logger: noopLogger, llmFor, now: () => NOW, ...extra })
  );
  return app;
}

const post = (app: Hono, body: unknown) =>
  app.request('/api/cron/parse', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

describe('POST /api/cron/parse', () => {
  it('turns the LLM answer into a proposal (happy path)', async () => {
    const calls: string[] = [];
    const app = makeApp(
      llmReplying(
        '```json\n{"schedule":"0 */3 * * *","instruction":"Check job boards for new roles","chatId":"operator","confidence":"high","explanation":"Every three hours, report to you.","warnings":[]}\n```',
        calls
      )
    );
    const res = await post(app, {
      text: 'check job boards every 3 hours and message me',
      botId: 'hunter',
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      schedule: '0 */3 * * *',
      tz: TZ,
      scheduleHuman: `Every 3 hours (${TZ})`,
      instruction: 'Check job boards for new roles',
      botId: 'hunter',
      chatId: 'operator',
      operatorChatId: 4242,
      confidence: 'high',
      explanation: 'Every three hours, report to you.',
      source: 'llm',
      llm: { backend: 'claude-cli', model: 'claude-opus-5' },
    });
    expect(body.warnings).toEqual([]);
    expect(body.nextRunAt).toBe('2026-09-14T18:00:00.000Z');
    // The prompt carried the timezone, the agent and the text.
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain(TZ);
    expect(calls[0]).toContain('Hunter');
    expect(calls[0]).toContain('check job boards every 3 hours and message me');
  });

  it('falls back to the built-in parser when the LLM answer is garbage', async () => {
    const app = makeApp(llmReplying('Sorry, I can only help with recipes.'));
    const res = await post(app, {
      text: 'check job boards every 3 hours and message me',
      botId: 'hunter',
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.source).toBe('fallback');
    expect(body.schedule).toBe('0 */3 * * *');
    expect(body.instruction).toBe('Check job boards');
    expect(body.confidence).toBe('medium');
    expect(body.warnings.join(' ')).toMatch(/not usable/i);
  });

  it('rejects a bad cron from the LLM and falls back with a warning', async () => {
    const app = makeApp(
      llmReplying(
        '{"schedule":"0 0 */3 * * *","instruction":"Check job boards","chatId":"operator"}'
      )
    );
    const res = await post(app, { text: 'check job boards every 3 hours', botId: 'hunter' });
    const body = await res.json();
    expect(body.source).toBe('fallback');
    expect(body.schedule).toBe('0 */3 * * *');
    expect(body.warnings.join(' ')).toMatch(/not usable/i);
  });

  it('uses the built-in parser when the agent has no LLM (not running) and says so', async () => {
    const app = makeApp(async () => null);
    const res = await post(app, { text: 'send the report every monday at 9', botId: 'hunter' });
    const body = await res.json();
    expect(body.source).toBe('fallback');
    expect(body.schedule).toBe('0 9 * * 1');
    expect(body.scheduleHuman).toBe(`Every Monday at 09:00 (${TZ})`);
    expect(body.warnings.join(' ')).toMatch(/not running/i);
    expect(body.llm).toBeNull();
  });

  it('survives an LLM that throws or hangs', async () => {
    const throwing: CronParseLlmResolver = async () => ({
      backend: 'ollama',
      model: 'llama3',
      client: {
        generate: async () => {
          throw new Error('connection refused');
        },
      },
    });
    const res = await post(makeApp(throwing), {
      text: 'ping me every 10 minutes',
      botId: 'hunter',
    });
    const body = await res.json();
    expect(body.source).toBe('fallback');
    expect(body.schedule).toBe('*/10 * * * *');
    expect(body.warnings.join(' ')).toMatch(/connection refused/);

    const hanging: CronParseLlmResolver = async () => ({
      backend: 'ollama',
      model: 'llama3',
      client: { generate: () => new Promise(() => {}) },
    });
    const slow = await post(makeApp(hanging, undefined, { llmTimeoutMs: 20 }), {
      text: 'ping me every 10 minutes',
      botId: 'hunter',
    });
    const slowBody = await slow.json();
    expect(slowBody.source).toBe('fallback');
    expect(slowBody.warnings.join(' ')).toMatch(/timed out/i);
  });

  it('answers 404 for a bot outside the tenant and for an unknown bot', async () => {
    const llm = mock(llmReplying('{"schedule":"0 9 * * *","instruction":"x"}'));
    const app = makeApp(llm, 't2');
    const foreign = await post(app, { text: 'x every day', botId: 'hunter' });
    expect(foreign.status).toBe(404);
    expect(await foreign.json()).toEqual({ error: 'Bot not found' });
    const unknown = await post(app, { text: 'x every day', botId: 'nope' });
    expect(unknown.status).toBe(404);
    expect(llm).not.toHaveBeenCalled();
    // The admin sees everything.
    const admin = await post(makeApp(llm, '__admin__'), { text: 'x every day', botId: 'hunter' });
    expect(admin.status).toBe(200);
  });

  it('answers 400 when text or botId is missing', async () => {
    const app = makeApp(llmReplying('{}'));
    expect((await post(app, { botId: 'hunter' })).status).toBe(400);
    expect((await post(app, { text: '   ', botId: 'hunter' })).status).toBe(400);
    expect((await post(app, { text: 'x' })).status).toBe(400);
    const bad = await app.request('/api/cron/parse', { method: 'POST', body: 'not json' });
    expect(bad.status).toBe(400);
  });

  it('caps the text length', async () => {
    const app = makeApp(llmReplying('{}'));
    const res = await post(app, { text: 'x'.repeat(5000), botId: 'hunter' });
    expect(res.status).toBe(400);
  });
});

describe('buildCronParseLlmResolver', () => {
  const planner = {
    backend: 'claude-cli' as const,
    generate: async () => ({ text: '{}' }),
    chat: async () => ({ text: '' }),
    getBackendClient: (b: string) => (b === 'claude-cli' ? planner : undefined),
  };

  it('returns null when the bot has no client (not started)', async () => {
    const resolver = buildCronParseLlmResolver(
      {
        getLLMClient: () => {
          throw new Error('No LLMClient registered');
        },
        getActiveModel: () => 'x',
      },
      config,
      noopLogger
    );
    expect(await resolver('hunter')).toBeNull();
    expect(await resolver('unknown-bot')).toBeNull();
  });

  it('pins the planner backend and model of the bot', async () => {
    const resolver = buildCronParseLlmResolver(
      { getLLMClient: () => planner as never, getActiveModel: () => 'claude-opus-5' },
      config,
      noopLogger
    );
    const llm = (await resolver('hunter')) as CronParseLlm;
    expect(llm.backend).toBe('claude-cli');
    expect(llm.model).toBe('claude-opus-5');
    expect(llm.client).toBe(planner);
  });
});
