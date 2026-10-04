/**
 * `POST /api/cron/parse` (session S8 of docs/plans/jarvis-fleet-plan.md).
 *
 * Free text + a bot id -> a cron proposal the dashboard previews. The bot's
 * own LLM (planner selection: bare client, no silent cross-backend fallback)
 * does the reading; when the bot is not running, the answer is garbage or the
 * call fails, `deterministicParse` takes over and says so in `warnings`. This
 * route never creates a job — the UI posts the proposal to `POST /api/cron`.
 *
 * Mounted under `/api/cron` BEFORE `cronRoutes` so nothing reads "parse" as an id.
 */
import { Hono } from 'hono';
import {
  resolvePlannerBackend,
  resolvePlannerModel,
  selectPlannerClient,
} from '../../bot/agent-planner';
import type { Config } from '../../config';
import { ClaudeCliLLMClient, type LLMClient } from '../../core/llm-client';
import {
  type CronProposal,
  buildParsePrompt,
  composeProposal,
  parseLlmProposal,
} from '../../cron/nl-parse';
import type { Logger } from '../../logger';
import { getTenantId, scopeBots } from '../../tenant/tenant-scoping';

/** The LLM a parse call runs on: a bare client pinned to one backend + the model to send. */
export interface CronParseLlm {
  client: Pick<LLMClient, 'generate'>;
  model: string;
  backend: string;
}

/** Resolves the LLM for a bot; null when the bot has none (not started). */
export type CronParseLlmResolver = (botId: string) => Promise<CronParseLlm | null>;

/** Response of `POST /api/cron/parse`: the proposal plus which LLM (if any) produced it. */
export interface CronParseResponse extends CronProposal {
  llm: { backend: string; model: string } | null;
}

export const CRON_PARSE_TEXT_MAX = 2000;
export const CRON_PARSE_LLM_TIMEOUT_MS = 60_000;
const LLM_MAX_TOKENS = 600;

/**
 * Production resolver over BotManager: the bot's registered client, unwrapped
 * to the planner backend the same way the agent loop does it, so a claude-cli
 * bot's parse never lands on the Ollama quota and vice versa.
 */
export function buildCronParseLlmResolver(
  botManager: { getLLMClient(botId: string): LLMClient; getActiveModel(botId: string): string },
  config: Config,
  logger: Logger
): CronParseLlmResolver {
  return async (botId) => {
    const bot = config.bots.find((b) => b.id === botId);
    if (!bot) return null;
    let botClient: LLMClient;
    try {
      botClient = botManager.getLLMClient(botId);
    } catch {
      return null;
    }
    const backend = resolvePlannerBackend(config.agentLoop, bot);
    const client = selectPlannerClient(botClient, backend, {
      logger,
      createClaudeClient: () =>
        new ClaudeCliLLMClient(
          'claude',
          bot.agentLoop?.claudeTimeout ?? config.agentLoop.claudeTimeout,
          logger,
          config.claudeCli?.model
        ),
    });
    const model = resolvePlannerModel(backend, bot, config, botManager.getActiveModel(botId));
    return { client, model, backend };
  };
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timed out after ${Math.round(ms / 1000)}s`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      }
    );
  });
}

export function cronParseRoutes(deps: {
  config: Config;
  logger: Logger;
  llmFor?: CronParseLlmResolver;
  now?: () => number;
  llmTimeoutMs?: number;
}) {
  const app = new Hono();
  const now = deps.now ?? (() => Date.now());
  const llmFor = deps.llmFor ?? (async () => null);
  const timeoutMs = deps.llmTimeoutMs ?? CRON_PARSE_LLM_TIMEOUT_MS;

  app.post('/parse', async (c) => {
    let body: { text?: unknown; botId?: unknown };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'JSON body with text and botId is required' }, 400);
    }
    const text = typeof body?.text === 'string' ? body.text.trim() : '';
    const botId = typeof body?.botId === 'string' ? body.botId.trim() : '';
    if (!text || !botId) return c.json({ error: 'text and botId are required' }, 400);
    if (text.length > CRON_PARSE_TEXT_MAX) {
      return c.json({ error: `text is limited to ${CRON_PARSE_TEXT_MAX} characters` }, 400);
    }

    const bot = scopeBots(deps.config.bots, getTenantId(c)).find((b) => b.id === botId);
    if (!bot) return c.json({ error: 'Bot not found' }, 404);

    const tz = deps.config.datetime?.timezone || 'UTC';
    const nowMs = now();
    const operator = deps.config.operator;
    const operatorConfigured = typeof operator?.telegramChatId === 'number';

    let llm: CronParseLlm | null = null;
    try {
      llm = await llmFor(botId);
    } catch (err) {
      deps.logger.warn({ botId, err }, 'cron parse: could not resolve the bot LLM');
    }

    let proposal: CronProposal;
    if (!llm) {
      proposal = composeProposal({
        text,
        botId,
        tz,
        nowMs,
        operator,
        llm: null,
        llmNote: 'Agent is not running (no LLM available)',
      });
    } else {
      const prompt = buildParsePrompt({
        text,
        botId,
        botName: bot.name || bot.id,
        tz,
        nowIso: new Date(nowMs).toISOString(),
        operatorConfigured,
      });
      let llmNote: string | undefined;
      let parsed = null;
      try {
        const res = await withTimeout(
          llm.client.generate(prompt, {
            model: llm.model,
            temperature: 0,
            maxTokens: LLM_MAX_TOKENS,
          }),
          timeoutMs
        );
        parsed = parseLlmProposal(res.text, deps.logger);
        if (!parsed) llmNote = "The agent's answer was not usable";
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        deps.logger.warn(
          { botId, backend: llm.backend, err: message },
          'cron parse: LLM call failed'
        );
        llmNote = /timed out/.test(message)
          ? `The agent's LLM ${message}`
          : `The agent's LLM failed (${message})`;
      }
      proposal = composeProposal({ text, botId, tz, nowMs, operator, llm: parsed, llmNote });
    }

    const response: CronParseResponse = {
      ...proposal,
      llm: llm ? { backend: llm.backend, model: llm.model } : null,
    };
    return c.json(response);
  });

  return app;
}
