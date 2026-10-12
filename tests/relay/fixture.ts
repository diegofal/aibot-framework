/**
 * A synthetic relay world for tests: a real UserDirectory and RelayStore in a
 * temp dir, fake Telegram instances that record what they sent, and a session
 * recorder. Names and ids are made up (Ana, Bruno, Op).
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UserDirectory } from '../../src/bot/user-directory';
import { RelayService, type RelayServiceConfigView } from '../../src/relay/service';
import { RelayStore } from '../../src/relay/store';
import type { RelayParty } from '../../src/relay/types';

export const silentLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  trace: () => {},
  child: () => silentLogger,
} as any;

export const OP_CHAT = 9001;
export const ANA_CHAT = 1001;
export const BRUNO_CHAT = 1002;

export interface SentTg {
  via: string;
  chatId: number | string;
  text: string;
  messageId: number;
}

export interface FakeTelegram {
  botId: string;
  api: { sendMessage(chatId: number | string, text: string): Promise<{ message_id: number }> };
}

let nextMessageId = 500;

export function fakeTelegram(
  botId: string,
  sent: SentTg[],
  fail?: (chatId: number | string) => Error | null
): FakeTelegram {
  return {
    botId,
    api: {
      async sendMessage(chatId, text) {
        const err = fail?.(chatId);
        if (err) throw err;
        const messageId = nextMessageId++;
        sent.push({ via: botId, chatId, text, messageId });
        return { message_id: messageId };
      },
    },
  };
}

export function tgError(code: number, description: string): Error {
  return Object.assign(new Error(`Call to 'sendMessage' failed! (${code}: ${description})`), {
    error_code: code,
    description,
  });
}

export interface World {
  dir: string;
  directory: UserDirectory;
  store: RelayStore;
  service: RelayService;
  sent: SentTg[];
  /** botId → instance; mutate to simulate headless bots or failures. */
  instances: Map<string, FakeTelegram>;
  sessions: Array<{ botId: string; party: RelayParty; text: string }>;
  config: RelayServiceConfigView;
  cleanup(): void;
}

export function makeWorld(
  opts: {
    bots?: RelayServiceConfigView['bots'];
    instances?: string[];
    operator?: RelayServiceConfigView['operator'];
  } = {}
): World {
  const dir = mkdtempSync(join(tmpdir(), 'relay-world-'));
  const directory = new UserDirectory(dir, silentLogger);
  const store = new RelayStore(dir, silentLogger);
  const sent: SentTg[] = [];
  const instances = new Map<string, FakeTelegram>();
  for (const id of opts.instances ?? ['bot1']) instances.set(id, fakeTelegram(id, sent));
  const sessions: World['sessions'] = [];
  const config: RelayServiceConfigView = {
    operator: opts.operator ?? { name: 'Op', telegramChatId: OP_CHAT, email: 'op@example.test' },
    bots: opts.bots ?? [{ id: 'bot1', name: 'Bot' }],
  };
  const service = new RelayService({
    store,
    directory,
    delivery: {
      telegramInstances: (botId) => {
        const own = instances.get(botId);
        const rest = [...instances.values()].filter((i) => i.botId !== botId);
        return own ? [own, ...rest] : rest;
      },
      appendWebSession: () => {},
      logger: silentLogger,
    },
    config: () => config,
    appendToSession: (botId, party, text) => sessions.push({ botId, party, text }),
    logger: silentLogger,
  });
  return {
    dir,
    directory,
    store,
    service,
    sent,
    instances,
    sessions,
    config,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/** Ana and Bruno as tracked Telegram users of `botId`. */
export function seedPeople(w: World, botId = 'bot1'): void {
  for (const [id, name] of [
    [ANA_CHAT, 'Ana'],
    [BRUNO_CHAT, 'Bruno'],
  ] as const) {
    w.directory.track(botId, {
      messageId: 'm',
      channelKind: 'telegram',
      text: 'hola',
      chatId: String(id),
      chatType: 'private',
      sender: { id: String(id), firstName: name },
      timestamp: Date.now(),
    });
  }
}
