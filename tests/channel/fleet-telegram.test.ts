import { describe, expect, it } from 'bun:test';
import {
  NoTelegramRouteError,
  borrowFleetTelegram,
  borrowedText,
  fleetTelegramBorrower,
} from '../../src/channel/fleet-telegram';

type Sent = { by: string; chatId: number; text: string; extra?: { parse_mode?: string } };

function fakeBot(name: string, log: Sent[], actions: string[] = []) {
  return {
    api: {
      sendMessage: async (chatId: number, text: string, extra?: { parse_mode?: string }) => {
        log.push({ by: name, chatId, text, extra });
        return { message_id: 1 };
      },
      sendChatAction: async (_chatId: number, action: string) => {
        actions.push(`${name}:${action}`);
        return true;
      },
    },
  };
}

describe('borrowedText', () => {
  it('names the bot that wrote the message', () => {
    expect(borrowedText('MyFirstMillion', 'Idea #3')).toBe('🤖 MyFirstMillion:\nIdea #3');
  });
  it('escapes the name for Markdown sends', () => {
    expect(borrowedText('ai_perfectionist', 'hi', 'Markdown')).toBe('🤖 ai\\_perfectionist:\nhi');
  });
});

describe('borrowFleetTelegram', () => {
  it('borrows nothing when the switch is off (the dashboard is the channel)', () => {
    const log: Sent[] = [];
    const bots = new Map([['default', fakeBot('default', log)]]);
    expect(borrowFleetTelegram(bots, 'myfirstmillion', { enabled: false, name: 'M' })).toBe(
      undefined
    );
  });

  it('borrows nothing when no other instance is live', () => {
    const log: Sent[] = [];
    const bots = new Map([['myfirstmillion', fakeBot('own', log)]]);
    expect(borrowFleetTelegram(bots, 'myfirstmillion', { enabled: true, name: 'M' })).toBe(
      undefined
    );
    expect(borrowFleetTelegram(new Map(), 'x', { enabled: true, name: 'M' })).toBe(undefined);
  });

  it('when on, sends through another instance with the author named first', async () => {
    const log: Sent[] = [];
    const actions: string[] = [];
    const bots = new Map([['default', fakeBot('default', log, actions)]]);
    const borrowed = borrowFleetTelegram(bots, 'myfirstmillion', {
      enabled: true,
      name: 'MyFirstMillion',
    });
    if (!borrowed) throw new Error('expected a borrowed instance');
    await borrowed.api.sendMessage(42, 'Idea #3');
    await borrowed.api.sendMessage(42, '*q*', { parse_mode: 'Markdown' });
    await borrowed.api.sendChatAction(42, 'typing');
    expect(log).toEqual([
      { by: 'default', chatId: 42, text: '🤖 MyFirstMillion:\nIdea #3', extra: undefined },
      {
        by: 'default',
        chatId: 42,
        text: '🤖 MyFirstMillion:\n*q*',
        extra: { parse_mode: 'Markdown' },
      },
    ]);
    expect(actions).toEqual(['default:typing']);
  });
});

describe('NoTelegramRouteError', () => {
  it('is an Error with its own name', () => {
    const err = new NoTelegramRouteError('b');
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('NoTelegramRouteError');
  });
});

describe('fleetTelegramBorrower', () => {
  it('reads the switch and the author name from the live config', async () => {
    const log: Sent[] = [];
    const bots = new Map([['default', fakeBot('default', log)]]);
    const config = {
      operator: { borrowFleetTelegram: false as boolean | undefined },
      bots: [{ id: 'mfm', name: 'MyFirstMillion' }, { id: 'noname' }],
    };
    const borrow = fleetTelegramBorrower(bots, () => config);
    expect(borrow('mfm')).toBe(undefined);
    config.operator.borrowFleetTelegram = true;
    await borrow('mfm')?.api.sendMessage(1, 'a');
    await borrow('noname')?.api.sendMessage(1, 'b');
    expect(log.map((m) => m.text)).toEqual(['🤖 MyFirstMillion:\na', '🤖 noname:\nb']);
    expect(fleetTelegramBorrower(undefined, () => config)('mfm')).toBe(undefined);
  });
});
