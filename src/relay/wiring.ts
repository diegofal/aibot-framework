/**
 * Runtime wiring for relays: the fleet's Telegram instances, WhatsApp and the
 * web session as `DeliveryDeps`, plus the session transcript append. Built
 * once by `BotManager` and shared through `BotContext.relayService`.
 */
import type { UserDirectory } from '../bot/user-directory';
import { appendWebSessionMessage } from '../channel/outbound';
import { type WhatsAppConfig, whatsappChannel } from '../channel/whatsapp';
import type { Logger } from '../logger';
import type { SessionManager } from '../session';
import type { TelegramSender } from './delivery';
import { RelayService, type RelayServiceConfigView } from './service';
import { RelayStore } from './store';

type TelegramApiLike = { api: TelegramSender['api'] | object };

/** `botId`'s own Telegram instance first, then every other live instance. */
export function telegramInstancesFor(
  bots: ReadonlyMap<string, TelegramApiLike>,
  botId: string
): TelegramSender[] {
  const toSender = (id: string, bot: TelegramApiLike): TelegramSender => ({
    botId: id,
    api: bot.api as TelegramSender['api'],
  });
  const own = bots.get(botId);
  const rest = [...bots].filter(([id]) => id !== botId).map(([id, bot]) => toSender(id, bot));
  return own ? [toSender(botId, own), ...rest] : rest;
}

/**
 * The private session a person at `address` has with `botId` (the key the
 * conversation pipeline derives for a private chat). Undefined for a
 * non-numeric address: it would collapse into the shared `private:0` session.
 */
export function relaySessionKey(
  sessionManager: Pick<SessionManager, 'serializeKey'>,
  botId: string,
  address: string
): string | undefined {
  const id = Number(address);
  if (!id) return undefined;
  return sessionManager.serializeKey({ botId, chatType: 'private', chatId: id, userId: id });
}

export interface RelayWiringDeps {
  config: () => {
    operator?: RelayServiceConfigView['operator'];
    bots: Array<RelayServiceConfigView['bots'][number] & { whatsapp?: WhatsAppConfig }>;
  };
  dataDir: string;
  bots: ReadonlyMap<string, TelegramApiLike>;
  sessionManager: SessionManager;
  userDirectory: UserDirectory;
  /** The bot's identity name (soul IDENTITY.md), used in relay headers. */
  displayName?: (botId: string) => string | undefined;
  logger: Logger;
}

export function createRelayService(deps: RelayWiringDeps): RelayService {
  const { sessionManager, logger } = deps;
  return new RelayService({
    store: new RelayStore(deps.dataDir, logger),
    directory: deps.userDirectory,
    config: deps.config,
    ...(deps.displayName ? { displayName: deps.displayName } : {}),
    logger,
    delivery: {
      telegramInstances: (botId) => telegramInstancesFor(deps.bots, botId),
      sendWhatsApp: async (botId, address, text) => {
        const wa = deps.config().bots.find((b) => b.id === botId)?.whatsapp;
        if (!wa) throw new Error(`no WhatsApp config for ${botId}`);
        await whatsappChannel(address, wa).sendText(text);
      },
      appendWebSession: (botId, address, text) =>
        appendWebSessionMessage(sessionManager, botId, address, text),
      logger,
    },
    appendToSession: (botId, party, text) => {
      const key = relaySessionKey(sessionManager, botId, party.address);
      if (!key) return;
      sessionManager.appendMessages(key, [{ role: 'assistant', content: text }], 100);
    },
  });
}
