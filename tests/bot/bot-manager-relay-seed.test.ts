/**
 * Starting a bot (Telegram or headless) seeds the configured operator into
 * its contact directory, so "operator" resolves before anyone has written.
 */
import { describe, expect, it } from 'bun:test';
import { BotManager } from '../../src/bot/bot-manager';

const quiet = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

describe('BotManager.startBot — operator seed', () => {
  it('seeds the operator before the rest of the startup runs', async () => {
    const seeded: string[] = [];
    const self = {
      runningBots: new Set<string>(),
      logger: quiet,
      relayService: { ensureOperator: (botId: string) => seeded.push(botId) },
      // Stop right after the seed: the rest of startBot needs real infrastructure.
      getBotLogger: () => {
        throw new Error('stop here');
      },
    };
    await expect(
      BotManager.prototype.startBot.call(
        self as never,
        {
          id: 'bot1',
          name: 'Bot',
          enabled: true,
        } as never
      )
    ).rejects.toThrow('stop here');
    expect(seeded).toEqual(['bot1']);
  });

  it('does not seed for a disabled bot', async () => {
    const seeded: string[] = [];
    const self = {
      runningBots: new Set<string>(),
      logger: quiet,
      relayService: { ensureOperator: (botId: string) => seeded.push(botId) },
    };
    await expect(
      BotManager.prototype.startBot.call(
        self as never,
        {
          id: 'bot1',
          name: 'Bot',
          enabled: false,
        } as never
      )
    ).rejects.toThrow();
    expect(seeded).toEqual([]);
  });
});
