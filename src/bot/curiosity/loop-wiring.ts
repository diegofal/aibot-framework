/**
 * Glue between the curiosity runner and the fleet: how a dispatch reaches the
 * operator, and the fleet-wide daily cap it shares with proactive sends.
 */
import type { Logger } from '../../logger';
import { ProactiveThrottle } from '../../tools/send-proactive-message';

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
