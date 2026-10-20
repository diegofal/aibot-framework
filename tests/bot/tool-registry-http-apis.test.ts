import { describe, expect, test } from 'bun:test';
import { ToolRegistry } from '../../src/bot/tool-registry';
import type { BotContext } from '../../src/bot/types';

const noopLogger = {
  info: () => {},
  warn: () => {},
  debug: () => {},
  error: () => {},
  child: () => noopLogger,
} as any;

function ctxWith(integrations: unknown): BotContext {
  return {
    config: {
      bots: [{ id: 'default' }, { id: 'other' }],
      integrations,
    },
    tools: [],
    toolDefinitions: [],
    logger: noopLogger,
  } as unknown as BotContext;
}

const finanzas = {
  name: 'finanzas',
  baseUrl: 'https://finance.example.com',
  auth: { type: 'bearer', env: 'FIN_KEY' },
  bots: ['default'],
  operatorOnly: true,
  timeoutMs: 15000,
  endpoints: [
    { name: 'saldos', method: 'GET', path: '/api/agent/saldos', description: 'Balances' },
  ],
};

const names = (defs: { function: { name: string } }[]) => defs.map((d) => d.function.name);

describe('ToolRegistry.registerHttpApiTools', () => {
  test('registers endpoint tools only for the listed bots', () => {
    const ctx = ctxWith({ httpApis: [finanzas] });
    const reg = new ToolRegistry(ctx);
    reg.registerHttpApiTools();
    expect(names(ctx.toolDefinitions)).toContain('api_finanzas_saldos');
    expect(names(reg.getDefinitionsForBot('default'))).toContain('api_finanzas_saldos');
    expect(names(reg.getDefinitionsForBot('other'))).not.toContain('api_finanzas_saldos');
    expect(names(reg.getToolsForBot('other').map((t) => t.definition))).not.toContain(
      'api_finanzas_saldos'
    );
    expect(names(reg.getCollaborationToolsForBot('other').definitions)).not.toContain(
      'api_finanzas_saldos'
    );
  });

  test('no integrations configured → nothing registered', () => {
    const ctx = ctxWith(undefined);
    const reg = new ToolRegistry(ctx);
    reg.registerHttpApiTools();
    expect(ctx.tools).toHaveLength(0);
    expect(reg.getDefinitionsForBot('default')).toHaveLength(0);
  });
});
