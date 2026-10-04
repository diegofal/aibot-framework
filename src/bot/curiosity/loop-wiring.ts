/**
 * Glue between the curiosity runner and the fleet: how a dispatch reaches the
 * operator, and the fleet-wide daily cap it shares with proactive sends.
 */
import type { Logger } from '../../logger';
import { ProactiveThrottle } from '../../tools/send-proactive-message';
import type { LlmQueryEntry } from '../llm-query-log';
import type { CuriosityLLMCall } from './runner';

interface TelegramLike {
  api: { sendMessage: (chatId: number, text: string) => Promise<unknown> };
}

/**
 * Dispatch delivery: the bot's own Telegram instance, else any live one in
 * the fleet (7 of 8 bots are headless), to `operator.telegramChatId`. With no
 * Telegram route at all the dashboard Dispatches inbox IS the channel, so the
 * dispatch counts as delivered. Only a rejected send reports failure.
 */
export type DispatchDelivery = 'telegram' | 'inbox' | false;

export function createOperatorDispatchDeliverer(deps: {
  getOperatorChatId: () => number | undefined;
  getBot: (botId: string) => TelegramLike | undefined;
  getAnyBot: () => TelegramLike | undefined;
  /** Tenant bots never ping the instance operator; their feed is the inbox. */
  isTenantBot?: (botId: string) => boolean;
  logger: Pick<Logger, 'warn'>;
}): (botId: string, text: string) => Promise<DispatchDelivery> {
  return async (botId, text) => {
    if (deps.isTenantBot?.(botId)) return 'inbox';
    const chatId = deps.getOperatorChatId();
    if (chatId === undefined) return 'inbox';
    const bot = deps.getBot(botId) ?? deps.getAnyBot();
    if (!bot) return 'inbox';
    try {
      await bot.api.sendMessage(chatId, text);
      return 'telegram';
    } catch (err) {
      deps.logger.warn({ err, botId }, 'Curiosity: dispatch delivery failed');
      return false;
    }
  };
}

/** Fleet-wide rolling-24h cap on dispatches (no per-bot cooldown: cadence owns that). */
export function createFleetDispatchLimiter(
  getDailyCap: () => number,
  now: () => number = Date.now
): { allows: (botId: string) => boolean; record: (botId: string) => void } {
  const throttle = new ProactiveThrottle(
    () => ({ cooldownMs: 0, dailyCap: Math.max(0, getDailyCap()) }),
    now
  );
  return {
    allows: (botId) => throttle.check(botId).allowed,
    record: (botId) => throttle.record(botId),
  };
}

/**
 * Every curiosity LLM call (navigator, extractor, editor) goes to the query
 * log and, for a tenant bot in multi-tenant mode, to tenant metering as one
 * `llm_request`. Failed attempts count too: the backend was still called.
 * A failing sink is swallowed, since curiosity must never fail a cycle.
 */
export function createCuriosityCallRecorder(deps: {
  botId: string;
  model: string;
  backend: string;
  appendQueryLog?: (entry: LlmQueryEntry) => void;
  /** Set only when the call should count against a tenant's quota. */
  meter?: (quantity: number, metadata: Record<string, unknown>) => void;
  now?: () => Date;
}): (call: CuriosityLLMCall) => void {
  const now = deps.now ?? (() => new Date());
  return (call) => {
    try {
      deps.appendQueryLog?.({
        timestamp: now().toISOString(),
        botId: deps.botId,
        caller: call.caller,
        model: call.usage?.model ?? deps.model,
        backend: deps.backend,
        promptTokens: call.usage?.promptTokens,
        completionTokens: call.usage?.completionTokens,
        totalTokens: call.usage?.totalTokens,
        durationMs: call.durationMs,
        success: call.success,
        error: call.error,
      });
    } catch {
      /* the query log is best-effort */
    }
    try {
      deps.meter?.(1, { caller: call.caller });
    } catch {
      /* metering is best-effort */
    }
  };
}

/**
 * Tenant metering for curiosity calls: one `llm_request` per call against
 * the bot's tenant, only in multi-tenant mode. Tenant and mode are read at
 * call time (the navigator lands in the background, maybe after an edit).
 */
export function createTenantCallMeter(deps: {
  botId: string;
  getTenantId: () => string | undefined;
  isMultiTenant: () => boolean;
  recordUsage: (
    tenantId: string,
    botId: string,
    type: 'llm_request',
    quantity: number,
    metadata: Record<string, unknown>
  ) => void;
}): (quantity: number, metadata: Record<string, unknown>) => void {
  return (quantity, metadata) => {
    const tenantId = deps.getTenantId();
    if (!tenantId || !deps.isMultiTenant()) return;
    deps.recordUsage(tenantId, deps.botId, 'llm_request', quantity, metadata);
  };
}
