/**
 * Borrowing another bot's Telegram connection.
 *
 * Most bots are headless: no Telegram token of their own. Their messages to
 * the operator (curiosity dispatches, ask_human pings, cron replies,
 * send_proactive_message) used to go out through whichever instance was
 * first in the fleet map, from that bot's account and with nothing saying who
 * wrote them; a reply then reached the lending bot, not the author.
 *
 * `operator.borrowFleetTelegram` (default off) decides it once, here:
 *   off  nothing is borrowed; the dashboard is the channel.
 *   on   another live instance delivers, and every text it sends through the
 *        borrowed connection starts with "🤖 <author>:".
 * Relays (`src/relay/`) are not routed through this: they carry their own
 * header and are the only way to reach a third person.
 */

type SendMessage = (chatId: number, text: string, extra?: never) => Promise<unknown>;
type TelegramLike = { api: { sendMessage: SendMessage } & object };

/** Thrown by a sender when the bot has no Telegram route (own or borrowed). */
export class NoTelegramRouteError extends Error {
  constructor(botId: string) {
    super(`Bot ${botId} has no Telegram connection of its own`);
    this.name = 'NoTelegramRouteError';
  }
}

/** The text as sent through another bot's account: the author named first. */
export function borrowedText(name: string, text: string, parseMode?: string): string {
  const who = parseMode === 'Markdown' ? name.replace(/([_*`[])/g, '\\$1') : name;
  return `🤖 ${who}:\n${text}`;
}

/**
 * `borrowFleetTelegram` bound to a fleet: the switch and the author's name are
 * read from the config at send time.
 */
export function fleetTelegramBorrower<B extends TelegramLike>(
  bots: ReadonlyMap<string, B> | undefined,
  getConfig: () => {
    operator?: { borrowFleetTelegram?: boolean };
    bots: ReadonlyArray<{ id: string; name?: string }>;
  }
): (botId: string) => B | undefined {
  return (botId) => {
    if (!bots) return undefined;
    const config = getConfig();
    return borrowFleetTelegram(bots, botId, {
      enabled: config.operator?.borrowFleetTelegram === true,
      name: config.bots.find((b) => b.id === botId)?.name || botId,
    });
  };
}

/**
 * Another live instance for `botId` to send through (the caller tries the
 * bot's own first), or undefined when borrowing is off or none is live. The
 * returned instance's `api.sendMessage` prefixes the author; every other api
 * method passes through untouched.
 */
export function borrowFleetTelegram<B extends TelegramLike>(
  bots: ReadonlyMap<string, B>,
  botId: string,
  opts: { enabled: boolean; name: string }
): B | undefined {
  if (!opts.enabled) return undefined;
  const lender = [...bots].find(([id]) => id !== botId)?.[1];
  if (!lender) return undefined;
  const api = new Proxy(lender.api, {
    get(target, prop) {
      if (prop === 'sendMessage') {
        return (chatId: number, text: string, extra?: { parse_mode?: string }) =>
          (target.sendMessage as (c: number, t: string, e?: unknown) => Promise<unknown>)(
            chatId,
            borrowedText(opts.name, text, extra?.parse_mode),
            extra
          );
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return { ...lender, api } as B;
}
