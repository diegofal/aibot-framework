/**
 * The agent loop's curiosity dispatch deliverer uses `isTenantBot`: a bot of
 * the admin tenant (`__admin__`) is the instance's own and pings the operator
 * on Telegram; a customer tenant's bot keeps its dispatches in the inbox.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentLoop } from '../../../src/bot/agent-loop';
import { GlobalAgentLoopConfigSchema } from '../../../src/config';

const logger: any = { info() {}, warn() {}, error() {}, debug() {} };
logger.child = () => logger;

let dataDir: string;
beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'aibot-dispatch-tenant-'));
});
afterEach(() => rmSync(dataDir, { recursive: true, force: true }));

function deliverFor(botId: string) {
  const sent: string[] = [];
  const instance = { api: { sendMessage: async (_c: number, t: string) => void sent.push(t) } };
  const ctx: any = {
    config: {
      agentLoop: GlobalAgentLoopConfigSchema.parse({}),
      multiTenant: { enabled: true },
      operator: { telegramChatId: 42 },
      bots: [
        { id: 'admin-bot', name: 'Admin', tenantId: '__admin__' },
        { id: 'customer-bot', name: 'Customer', tenantId: 't1' },
      ],
      paths: { data: dataDir },
    },
    bots: new Map([
      ['admin-bot', instance],
      ['customer-bot', instance],
    ]),
    logger,
  };
  const loop = new AgentLoop(ctx, {} as any, {} as any);
  loop.setCuriosityService({} as any);
  const deps = (loop as any).buildCuriosityDeps(
    botId,
    logger,
    {},
    {
      client: {},
      model: 'm',
      backend: 'ollama',
    }
  );
  return { deliver: deps.deliver as (id: string, text: string) => Promise<unknown>, sent };
}

describe('curiosity dispatch delivery by tenant', () => {
  test('an __admin__ bot dispatch goes to the operator on Telegram', async () => {
    const { deliver, sent } = deliverFor('admin-bot');
    expect(await deliver('admin-bot', 'hello')).toBe('telegram');
    expect(sent).toEqual(['hello']);
  });

  test('a customer tenant bot dispatch stays in the inbox', async () => {
    const { deliver, sent } = deliverFor('customer-bot');
    expect(await deliver('customer-bot', 'hello')).toBe('inbox');
    expect(sent).toEqual([]);
  });
});
