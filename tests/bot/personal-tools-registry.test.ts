import { describe, expect, test } from 'bun:test';
import { ToolExecutor } from '../../src/bot/tool-executor';
import { getPermissionLevel } from '../../src/bot/tool-permissions';
import { TOOL_CATEGORIES, TOOL_TO_CATEGORY, ToolRegistry } from '../../src/bot/tool-registry';
import type { BotContext } from '../../src/bot/types';
import { IntegrationsConfigSchema } from '../../src/config';
import { PERSONAL_TOOL_NAMES, createPersonalTools } from '../../src/tools/personal';

const logger = { info() {}, warn() {}, debug() {}, error() {}, child: () => logger } as never;

function ctx(bots: string[]): BotContext {
  const tools = createPersonalTools(() => undefined);
  return {
    config: {
      bots: [{ id: 'finny' }, { id: 'other' }],
      integrations: { personalAccounts: { bots } },
    },
    tools,
    toolDefinitions: tools.map((t) => t.definition),
    logger,
  } as unknown as BotContext;
}

describe('personal tools in the registry', () => {
  test('only bots in integrations.personalAccounts.bots see them', () => {
    const reg = new ToolRegistry(ctx(['finny']));
    const names = (id: string) => reg.getDefinitionsForBot(id).map((d) => d.function.name);
    expect(names('finny').sort()).toEqual([...PERSONAL_TOOL_NAMES].sort());
    expect(names('other')).toEqual([]);
    expect(reg.getToolsForBot('other')).toEqual([]);
    expect(reg.getCollaborationToolsForBot('other').tools).toEqual([]);
  });

  test('the executor refuses them for a bot outside the allowlist even if named', async () => {
    const exec = new ToolExecutor(ctx(['finny']), { botId: 'other', chatId: 0 });
    const r = await exec.execute('calendar_agenda', {});
    expect(r.success).toBe(false);
    expect(r.failureKind).toBe('disabled');
  });

  test('calendar tools in the calendar category, mail tools in mail', () => {
    for (const n of ['calendar_agenda', 'calendar_free_slots', 'calendar_create_event']) {
      expect(TOOL_TO_CATEGORY.get(n)).toBe('calendar');
    }
    expect(TOOL_CATEGORIES.mail.sort()).toEqual(['mail_read', 'mail_search']);
  });
});

describe('permission matrix', () => {
  test('reads are free, creating an event is confirm in both modes', () => {
    for (const n of ['calendar_agenda', 'calendar_free_slots', 'mail_search', 'mail_read']) {
      expect(getPermissionLevel(n, 'agent-loop')).toBe('free');
      expect(getPermissionLevel(n, 'conversation')).toBe('free');
    }
    expect(getPermissionLevel('calendar_create_event', 'agent-loop')).toBe('confirm');
    expect(getPermissionLevel('calendar_create_event', 'conversation')).toBe('confirm');
  });
});

describe('config', () => {
  test('integrations.personalAccounts.bots defaults to none', () => {
    expect(IntegrationsConfigSchema.parse({})).toEqual({
      personalAccounts: { bots: [] },
      httpApis: [],
    });
    expect(
      IntegrationsConfigSchema.parse({
        personalAccounts: { bots: ['finny'], redirectBaseUrl: 'https://x.example' },
      }).personalAccounts
    ).toEqual({ bots: ['finny'], redirectBaseUrl: 'https://x.example' });
  });
});
