/**
 * ask_human called from a conversation.
 *
 * In a conversation `_chatId` is the chat of whoever is talking to the bot. A
 * user asked the bot something, the bot called ask_human, and the user got
 * "🤖 Bot needs your input… Reply to this message" — a question meant for the
 * operator. Worse, the store's single-pending fallback then took the user's next
 * plain message as the answer and the bot never replied to it.
 *
 * Now the chat notification only goes to the operator's chat or to the chat the
 * agent loop reports to (`_memoryViewer: null`, no human viewer), and only a
 * question whose notification actually landed in a chat can capture that chat's
 * plain messages.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AskHumanStore } from '../../src/bot/ask-human-store';
import type { OperatorConfig } from '../../src/config';
import type { Logger } from '../../src/logger';
import {
  type AskHumanDeps,
  createAskHumanTool,
  mayNotifyAskingChat,
} from '../../src/tools/ask-human';
import { createTempDir, removeTempDir } from '../helpers/temp-dir';

const OPERATOR_CHAT = 4242;
const USER_CHAT = 5555;
const REPORT_CHAT = 7777;

function makeLogger(): Logger {
  const logger = {
    info: () => {},
    debug: () => {},
    warn: () => {},
    error: () => {},
    child: () => logger,
  } as unknown as Logger;
  return logger;
}

type Sent = { chatId: number; text: string };

let store: AskHumanStore;
let viaInstance: Sent[];
let viaOperatorNotifier: Sent[];

function deps(operator: OperatorConfig | undefined): AskHumanDeps {
  return {
    store,
    getBotName: () => 'Bot One',
    getBotInstance: () =>
      ({
        api: {
          sendMessage: async (chatId: number, text: string) => {
            viaInstance.push({ chatId, text });
            return { message_id: 100 + viaInstance.length };
          },
        },
      }) as never,
    getOperator: () => operator,
    notifyOperator: async (msg) => {
      viaOperatorNotifier.push({ chatId: msg.chatId, text: msg.text });
    },
  };
}

beforeEach(() => {
  store = new AskHumanStore(makeLogger());
  viaInstance = [];
  viaOperatorNotifier = [];
});

describe('ask_human from a non-operator conversation', () => {
  const userArgs = { _botId: 'bot1', _chatId: USER_CHAT, _memoryViewer: String(USER_CHAT) };

  test('sends nothing to the user, pings the operator, and keeps the question in the inbox', async () => {
    const tool = createAskHumanTool(
      deps({ telegramChatId: OPERATOR_CHAT, notifyOnAsk: true } as OperatorConfig)
    );

    const result = await tool.execute({ question: 'Who is this user?', ...userArgs }, makeLogger());

    expect(result.success).toBe(true);
    expect(viaInstance.filter((m) => m.chatId === USER_CHAT)).toEqual([]);
    expect(viaOperatorNotifier).toHaveLength(1);
    expect(viaOperatorNotifier[0].chatId).toBe(OPERATOR_CHAT);
    expect(store.getPendingForBot('bot1')).toHaveLength(1);
  });

  test('without notifyOnAsk nothing is sent at all', async () => {
    const tool = createAskHumanTool(deps({ telegramChatId: OPERATOR_CHAT } as OperatorConfig));

    await tool.execute({ question: 'Who is this user?', ...userArgs }, makeLogger());

    expect(viaInstance).toEqual([]);
    expect(viaOperatorNotifier).toEqual([]);
    expect(store.getPendingCount()).toBe(1);
  });

  test("the user's next message is not swallowed as the answer", async () => {
    const tool = createAskHumanTool(
      deps({ telegramChatId: OPERATOR_CHAT, notifyOnAsk: true } as OperatorConfig)
    );
    await tool.execute({ question: 'Who is this user?', ...userArgs }, makeLogger());

    const reply = store.handleReply('bot1', USER_CHAT, 'and what about tomorrow?');

    expect(reply.matched).toBe(false);
    expect(store.getPendingCount()).toBe(1);
  });

  test('a legacy caller with no viewer arg is treated as a conversation too', async () => {
    const tool = createAskHumanTool(deps(undefined));

    await tool.execute({ question: 'Hm?', _botId: 'bot1', _chatId: USER_CHAT }, makeLogger());

    expect(viaInstance).toEqual([]);
  });
});

describe('ask_human from the operator chat', () => {
  test('notifies that chat once and matches a plain reply', async () => {
    const tool = createAskHumanTool(
      deps({ telegramChatId: OPERATOR_CHAT, notifyOnAsk: true } as OperatorConfig)
    );

    await tool.execute(
      {
        question: 'Ship it?',
        _botId: 'bot1',
        _chatId: OPERATOR_CHAT,
        _memoryViewer: String(OPERATOR_CHAT),
      },
      makeLogger()
    );

    expect(viaInstance.map((m) => m.chatId)).toEqual([OPERATOR_CHAT]);
    expect(viaInstance[0].text).toContain('Reply to this message');
    expect(viaOperatorNotifier).toEqual([]);
    expect(store.handleReply('bot1', OPERATOR_CHAT, 'yes').matched).toBe(true);
  });

  test('a reply-to on the notification still matches', async () => {
    const tool = createAskHumanTool(deps({ telegramChatId: OPERATOR_CHAT } as OperatorConfig));
    await tool.execute(
      { question: 'Ship it?', _botId: 'bot1', _chatId: OPERATOR_CHAT },
      makeLogger()
    );

    expect(store.handleReply('bot1', OPERATOR_CHAT, 'yes', 101).matched).toBe(true);
  });
});

describe('ask_human from the agent loop', () => {
  test('a report chat (no human viewer) is still notified and its plain reply matched', async () => {
    const tool = createAskHumanTool(deps({ telegramChatId: OPERATOR_CHAT } as OperatorConfig));

    await tool.execute(
      { question: 'Which source?', _botId: 'bot1', _chatId: REPORT_CHAT, _memoryViewer: null },
      makeLogger()
    );

    expect(viaInstance.map((m) => m.chatId)).toEqual([REPORT_CHAT]);
    expect(store.handleReply('bot1', REPORT_CHAT, 'the second').matched).toBe(true);
  });

  test('no chat: only the operator ping, as before', async () => {
    const tool = createAskHumanTool(
      deps({ telegramChatId: OPERATOR_CHAT, notifyOnAsk: true } as OperatorConfig)
    );

    await tool.execute(
      { question: 'Which source?', _botId: 'bot1', _chatId: 0, _memoryViewer: null },
      makeLogger()
    );

    expect(viaInstance).toEqual([]);
    expect(viaOperatorNotifier.map((m) => m.chatId)).toEqual([OPERATOR_CHAT]);
  });
});

describe('AskHumanStore single-pending fallback', () => {
  test('a question never notified in the chat does not capture its messages', () => {
    store.ask('bot1', USER_CHAT, 'q');
    expect(store.handleReply('bot1', USER_CHAT, 'hello').matched).toBe(false);
  });

  test('a question notified in the chat captures a plain reply', () => {
    const { id } = store.ask('bot1', USER_CHAT, 'q');
    store.setMessageId(id, 9);
    expect(store.handleReply('bot1', USER_CHAT, 'hello').matched).toBe(true);
  });

  describe('pending.json written before the fix', () => {
    let dir: string;
    beforeEach(() => {
      dir = createTempDir('ask-human-conversation');
    });
    afterEach(() => removeTempDir(dir));

    function restoreFrom(entries: unknown[]): AskHumanStore {
      writeFileSync(join(dir, 'pending.json'), JSON.stringify({ pending: entries }));
      return new AskHumanStore(makeLogger(), dir);
    }

    test('an entry with a messageId keeps the old fallback', () => {
      const s = restoreFrom([
        { id: 'q-1', botId: 'bot1', chatId: 42, question: 'q', createdAt: 1, messageId: 5 },
      ]);
      expect(s.handleReply('bot1', 42, 'yes').matched).toBe(true);
    });

    test('an entry without a messageId no longer captures plain messages', () => {
      const s = restoreFrom([
        { id: 'q-1', botId: 'bot1', chatId: 42, question: 'q', createdAt: 1, messageId: null },
      ]);
      expect(s.handleReply('bot1', 42, 'hello').matched).toBe(false);
    });
  });
});

describe('mayNotifyAskingChat', () => {
  const operator = { telegramChatId: OPERATOR_CHAT } as OperatorConfig;

  test('no chat: never', () => {
    expect(mayNotifyAskingChat(0, { _memoryViewer: null }, operator)).toBe(false);
  });

  test("the operator's chat: yes, whatever the viewer", () => {
    expect(mayNotifyAskingChat(OPERATOR_CHAT, { _memoryViewer: 'x' }, operator)).toBe(true);
    expect(mayNotifyAskingChat(OPERATOR_CHAT, {}, operator)).toBe(true);
  });

  test('a chat with no human viewer (agent loop, collaboration): yes', () => {
    expect(mayNotifyAskingChat(REPORT_CHAT, { _memoryViewer: null }, undefined)).toBe(true);
  });

  test("someone's conversation, or a legacy caller without a viewer: no", () => {
    expect(mayNotifyAskingChat(USER_CHAT, { _memoryViewer: 'u1' }, operator)).toBe(false);
    expect(mayNotifyAskingChat(USER_CHAT, {}, operator)).toBe(false);
    expect(mayNotifyAskingChat(USER_CHAT, {}, undefined)).toBe(false);
  });
});
