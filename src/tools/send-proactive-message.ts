/**
 * Tool that lets the agent loop send proactive messages to users.
 * For Telegram: uses bot.api.sendMessage()
 * For Widget: appends to session transcript (visible on reconnect via history endpoint)
 *
 * `chatId: "operator"` (or the operator's configured email) resolves through
 * `config.operator.telegramChatId`. Before that alias existed, bots that had
 * to reach the operator scraped a numeric chat id out of another bot's cron
 * payload — which worked until it did not, and silently went to the wrong
 * person when it did not.
 */
import type { OperatorConfig } from '../config';
import type { Logger } from '../logger';
import type { Tool, ToolResult } from './types';

export const OPERATOR_CHAT_ALIAS = 'operator';

export const OPERATOR_NOT_CONFIGURED_ERROR =
  'Operator chat id not configured (config.operator.telegramChatId)';

export type OperatorTarget = { kind: 'operator'; chatId: number | undefined } | { kind: 'other' };

/**
 * Is `raw` the operator? Matches the literal alias (any case) and, when
 * configured, the operator's email. Shared by send_proactive_message and cron
 * so the two tools cannot disagree about who the operator is.
 */
export function resolveOperatorTarget(
  raw: string,
  operator: OperatorConfig | null | undefined
): OperatorTarget {
  const needle = raw.trim().toLowerCase();
  if (!needle) return { kind: 'other' };
  const email = operator?.email?.trim().toLowerCase();
  const isAlias = needle === OPERATOR_CHAT_ALIAS || (!!email && needle === email);
  if (!isAlias) return { kind: 'other' };
  return { kind: 'operator', chatId: operator?.telegramChatId };
}

/** Per-bot cooldown applied when `operator.proactiveCooldownMinutes` is unset. */
export const DEFAULT_PROACTIVE_COOLDOWN_MINUTES = 60;
/** Fleet-wide rolling-24 h cap applied when `operator.proactiveDailyCap` is unset. */
export const DEFAULT_PROACTIVE_DAILY_CAP = 10;
/** The fleet cap window: 24 h, rolling. */
export const PROACTIVE_FLEET_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface ProactiveLimits {
  /** 0 disables the per-bot cooldown. */
  cooldownMs: number;
  /** 0 disables the fleet cap. */
  dailyCap: number;
}

/** Read the throttle limits off `config.operator`, defaults included. */
export function resolveProactiveLimits(
  operator: OperatorConfig | null | undefined
): ProactiveLimits {
  const minutes = operator?.proactiveCooldownMinutes ?? DEFAULT_PROACTIVE_COOLDOWN_MINUTES;
  const cap = operator?.proactiveDailyCap ?? DEFAULT_PROACTIVE_DAILY_CAP;
  return { cooldownMs: Math.max(0, minutes) * 60_000, dailyCap: Math.max(0, cap) };
}

export type ProactiveThrottleCheck = { allowed: true } | { allowed: false; reason: string };

/**
 * Rate limit for proactive sends — same shape as `CollaborationTracker`: an
 * in-memory map, an explicit clock, and a check that hands back the reason.
 *
 * Two limits, both hit before delivery: one message per bot per cooldown, and
 * `dailyCap` messages across the whole fleet per rolling 24 h. State lives in
 * the process; a restart forgives everything, which is the right trade for a
 * courtesy limit.
 */
export class ProactiveThrottle {
  /** botId → epoch ms of its last delivered proactive message */
  private lastSendByBot = new Map<string, number>();
  /** epoch ms of every fleet send inside the window (ascending) */
  private fleetSends: number[] = [];

  constructor(
    private getLimits: () => ProactiveLimits,
    private now: () => number = Date.now
  ) {}

  /** May `botId` send right now? The refusal says when it may. */
  check(botId: string): ProactiveThrottleCheck {
    const { cooldownMs, dailyCap } = this.getLimits();
    const now = this.now();

    if (cooldownMs > 0) {
      const last = this.lastSendByBot.get(botId);
      if (last !== undefined && now - last < cooldownMs) {
        const retryAt = new Date(last + cooldownMs).toISOString();
        return {
          allowed: false,
          reason:
            `Proactive send throttled: ${botId} may send again at ${retryAt}. ` +
            `Per-bot cooldown ${Math.round(cooldownMs / 60_000)}m.`,
        };
      }
    }

    if (dailyCap > 0) {
      const recent = this.pruneFleet(now);
      if (recent.length >= dailyCap) {
        const retryAt = new Date(recent[0] + PROACTIVE_FLEET_WINDOW_MS).toISOString();
        return {
          allowed: false,
          reason:
            `Proactive send throttled: ${botId} may send again at ${retryAt}. ` +
            `Fleet cap ${dailyCap}/24h, used ${recent.length}.`,
        };
      }
    }

    return { allowed: true };
  }

  /** Record a delivered message against both limits. */
  record(botId: string): void {
    const now = this.now();
    this.lastSendByBot.set(botId, now);
    this.pruneFleet(now).push(now);
  }

  /** Drop sends older than the window; returns the live list (mutable). */
  private pruneFleet(now: number): number[] {
    const cutoff = now - PROACTIVE_FLEET_WINDOW_MS;
    while (this.fleetSends.length > 0 && this.fleetSends[0] <= cutoff) this.fleetSends.shift();
    return this.fleetSends;
  }
}

export interface SendProactiveMessageDeps {
  sendTelegramMessage: (chatId: number, text: string) => Promise<void>;
  appendToSession: (botId: string, userId: string, text: string) => void;
  /** Operator contact from `config.operator`; omitted means "not configured". */
  getOperator?: () => OperatorConfig | undefined;
  /** Injectable clock for the throttle. */
  now?: () => number;
}

export function createSendProactiveMessageTool(deps: SendProactiveMessageDeps): Tool {
  // One tool instance is shared by the whole fleet (ToolRegistry builds it
  // once), so this closure is where "fleet-wide" actually lives.
  const throttle = new ProactiveThrottle(
    () => resolveProactiveLimits(deps.getOperator?.()),
    deps.now ?? Date.now
  );

  return {
    definition: {
      type: 'function',
      function: {
        name: 'send_proactive_message',
        description:
          'Send a proactive message to a user. Use this to check in on student progress, ' +
          'send reminders, or follow up on goals. The message will be delivered via Telegram ' +
          'or visible when the user reconnects via the widget. ' +
          'To reach your human operator use chatId: "operator" — it resolves to the configured ' +
          'operator contact; never guess or copy numeric chat ids from elsewhere. ' +
          'Proactive sends are rate-limited (one per bot per cooldown, plus a fleet-wide daily ' +
          'cap): batch what you have to say into one message instead of sending several.',
        parameters: {
          type: 'object',
          properties: {
            chatId: {
              type: 'string',
              description:
                'The chat ID or user ID to send the message to. Use "operator" to message the human operator.',
            },
            message: {
              type: 'string',
              description: 'The message text to send',
            },
          },
          required: ['chatId', 'message'],
        },
      },
    },

    async execute(args: Record<string, unknown>, logger: Logger): Promise<ToolResult> {
      const chatId = String(args.chatId ?? '').trim();
      const message = String(args.message ?? '').trim();

      if (!chatId) return { success: false, content: 'Missing chatId' };
      if (!message) return { success: false, content: 'Missing message' };
      if (message.length > 4000)
        return { success: false, content: 'Message too long (max 4000 chars)' };

      const botId = String(args._botId ?? '');

      // Throttle before any delivery — operator-directed and arbitrary chat ids
      // alike. Recorded only after a send actually lands, so a failed delivery
      // does not burn the quota.
      const gate = throttle.check(botId || 'unknown');
      if (!gate.allowed) {
        logger.warn({ botId, chatId }, 'send_proactive_message: throttled');
        return { success: false, content: gate.reason };
      }

      const operatorTarget = resolveOperatorTarget(chatId, deps.getOperator?.());
      if (operatorTarget.kind === 'operator') {
        if (!operatorTarget.chatId) {
          logger.warn(
            { botId, chatId },
            'send_proactive_message: operator alias used but not configured'
          );
          return { success: false, content: OPERATOR_NOT_CONFIGURED_ERROR };
        }
        try {
          await deps.sendTelegramMessage(operatorTarget.chatId, message);
          throttle.record(botId || 'unknown');
          logger.info(
            { chatId: operatorTarget.chatId, botId, messageLength: message.length },
            'Proactive message sent to the operator via Telegram'
          );
          return {
            success: true,
            content: `Message sent to the operator (chat ${operatorTarget.chatId})`,
          };
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          logger.error({ err, botId }, 'Failed to send proactive message to the operator');
          return { success: false, content: `Failed to send: ${errMsg}` };
        }
      }

      try {
        // Try Telegram first (numeric chat ID)
        const numericId = Number(chatId);
        if (!Number.isNaN(numericId) && numericId !== 0) {
          await deps.sendTelegramMessage(numericId, message);
          throttle.record(botId || 'unknown');
          logger.info(
            { chatId, botId, messageLength: message.length },
            'Proactive message sent via Telegram'
          );
          return { success: true, content: `Message sent to chat ${chatId}` };
        }

        // For non-numeric IDs (widget users), append to session
        deps.appendToSession(botId, chatId, message);
        throttle.record(botId || 'unknown');
        logger.info(
          { userId: chatId, botId, messageLength: message.length },
          'Proactive message appended to session'
        );
        return {
          success: true,
          content: `Message queued for user ${chatId} (visible on reconnect)`,
        };
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        logger.error({ err, chatId, botId }, 'Failed to send proactive message');
        return { success: false, content: `Failed to send: ${errMsg}` };
      }
    },
  };
}
