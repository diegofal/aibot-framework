import { describe, expect, test } from 'bun:test';
import { GroupActivation } from '../../src/bot/group-activation';
import type { BotContext } from '../../src/bot/types';

function createMockCtx(
  bots: Array<{ id: string; name: string; tenantId?: string }>,
  agentRegistryOverride?: {
    listOtherAgents: (...args: any[]) => any[];
    getByTelegramUsername: (...args: any[]) => any;
  }
): BotContext {
  return {
    config: {
      bots: bots.map((b) => ({ ...b, enabled: true, token: 'x', skills: [] })),
      session: { llmRelevanceCheck: { multiBotAware: true } },
    },
    logger: {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
    },
    agentRegistry: agentRegistryOverride ?? {
      listOtherAgents: () => [],
      getByTelegramUsername: () => null,
    },
  } as unknown as BotContext;
}

describe('GroupActivation', () => {
  describe('getOtherBotsContext tenant isolation', () => {
    test('passes tenantId from bot config to listOtherAgents', () => {
      let capturedArgs: any[] = [];
      const bots = [
        { id: 'bot-a', name: 'BotA', tenantId: 'tenant-a' },
        { id: 'bot-b', name: 'BotB', tenantId: 'tenant-b' },
      ];
      const ctx = createMockCtx(bots, {
        listOtherAgents: (...args: any[]) => {
          capturedArgs = args;
          return [];
        },
        getByTelegramUsername: () => null,
      });
      const ga = new GroupActivation(ctx);

      ga.getOtherBotsContext('bot-a');

      expect(capturedArgs[0]).toBe('bot-a');
      expect(capturedArgs[1]).toBe('tenant-a');
    });

    test('passes undefined tenantId for bots without tenant', () => {
      let capturedArgs: any[] = [];
      const bots = [
        { id: 'bot-x', name: 'BotX' },
        { id: 'bot-y', name: 'BotY' },
      ];
      const ctx = createMockCtx(bots, {
        listOtherAgents: (...args: any[]) => {
          capturedArgs = args;
          return [];
        },
        getByTelegramUsername: () => null,
      });
      const ga = new GroupActivation(ctx);

      ga.getOtherBotsContext('bot-x');

      expect(capturedArgs[0]).toBe('bot-x');
      expect(capturedArgs[1]).toBeUndefined();
    });

    test('returns empty string when multiBotAware is disabled', () => {
      const ctx = createMockCtx([{ id: 'a', name: 'A' }]);
      (ctx.config as any).session.llmRelevanceCheck.multiBotAware = false;
      const ga = new GroupActivation(ctx);

      expect(ga.getOtherBotsContext('a')).toBe('');
    });
  });
});
