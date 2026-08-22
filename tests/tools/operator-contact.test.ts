/**
 * Operator contact registry.
 *
 * Bots that needed to reach the operator used to scrape the operator's chat id
 * out of another bot's cron payload. `chatId: "operator"` resolves through
 * `config.operator.telegramChatId` instead, and fails loudly when that is not
 * configured so the bot learns the real fix rather than guessing.
 */
import { describe, expect, mock, test } from 'bun:test';
import type { OperatorConfig } from '../../src/config';
import { createCronTool } from '../../src/tools/cron';
import {
  OPERATOR_NOT_CONFIGURED_ERROR,
  createSendProactiveMessageTool,
  resolveOperatorTarget,
} from '../../src/tools/send-proactive-message';

const logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as any;

const OPERATOR: OperatorConfig = {
  name: 'Diego',
  telegramChatId: 796164002,
  email: 'diego@example.com',
  notifyOnAsk: true,
};

describe('resolveOperatorTarget', () => {
  test('"operator" (any case) resolves to the configured chat id', () => {
    expect(resolveOperatorTarget('operator', OPERATOR)).toEqual({
      kind: 'operator',
      chatId: 796164002,
    });
    expect(resolveOperatorTarget('  Operator ', OPERATOR)).toEqual({
      kind: 'operator',
      chatId: 796164002,
    });
  });

  test('the literal operator email is an alias too', () => {
    expect(resolveOperatorTarget('Diego@Example.com', OPERATOR)).toEqual({
      kind: 'operator',
      chatId: 796164002,
    });
  });

  test('alias without telegramChatId resolves to operator with no chat id', () => {
    expect(resolveOperatorTarget('operator', { name: 'Diego' })).toEqual({
      kind: 'operator',
      chatId: undefined,
    });
    expect(resolveOperatorTarget('operator', undefined)).toEqual({
      kind: 'operator',
      chatId: undefined,
    });
  });

  test('anything else is not the operator', () => {
    expect(resolveOperatorTarget('12345', OPERATOR)).toEqual({ kind: 'other' });
    expect(resolveOperatorTarget('widget-user', OPERATOR)).toEqual({ kind: 'other' });
    // No email configured: an email-looking string is not magically the operator.
    expect(resolveOperatorTarget('someone@example.com', { telegramChatId: 1 })).toEqual({
      kind: 'other',
    });
  });
});

describe('send_proactive_message with chatId "operator"', () => {
  function makeTool(operator: OperatorConfig | undefined, sent: Array<[number, string]>) {
    return createSendProactiveMessageTool({
      sendTelegramMessage: async (chatId, text) => {
        sent.push([chatId, text]);
      },
      appendToSession: () => {
        throw new Error('must not fall through to the session path');
      },
      getOperator: () => operator,
    });
  }

  test('resolves to operator.telegramChatId', async () => {
    const sent: Array<[number, string]> = [];
    const tool = makeTool(OPERATOR, sent);
    const result = await tool.execute(
      { chatId: 'operator', message: 'Weekly report ready', _botId: 'b' },
      logger
    );
    expect(result.success).toBe(true);
    expect(sent).toEqual([[796164002, 'Weekly report ready']]);
    expect(result.content).toMatch(/operator/);
  });

  test('the operator email works as the target as well', async () => {
    const sent: Array<[number, string]> = [];
    const tool = makeTool(OPERATOR, sent);
    const result = await tool.execute(
      { chatId: 'diego@example.com', message: 'hi', _botId: 'b' },
      logger
    );
    expect(result.success).toBe(true);
    expect(sent).toEqual([[796164002, 'hi']]);
  });

  test('not configured: clear error naming the config key, nothing sent', async () => {
    const sent: Array<[number, string]> = [];
    const tool = makeTool({ name: 'Diego' }, sent);
    const result = await tool.execute({ chatId: 'operator', message: 'hi', _botId: 'b' }, logger);
    expect(result.success).toBe(false);
    expect(result.content).toBe(OPERATOR_NOT_CONFIGURED_ERROR);
    expect(result.content).toContain('config.operator.telegramChatId');
    expect(sent).toEqual([]);
  });

  test('deps without getOperator behave as not configured', async () => {
    const tool = createSendProactiveMessageTool({
      sendTelegramMessage: async () => {},
      appendToSession: () => {},
    });
    const result = await tool.execute({ chatId: 'operator', message: 'hi' }, logger);
    expect(result.success).toBe(false);
    expect(result.content).toBe(OPERATOR_NOT_CONFIGURED_ERROR);
  });

  test('tool description advertises chatId: "operator"', () => {
    const tool = makeTool(OPERATOR, []);
    expect(tool.definition.function.description).toContain('"operator"');
    expect(String(tool.definition.function.parameters.properties.chatId)).toBeDefined();
    const chatIdProp = tool.definition.function.parameters.properties.chatId as {
      description: string;
    };
    expect(chatIdProp.description).toContain('"operator"');
  });
});

describe('cron tool with chatId "operator"', () => {
  function makeCronService() {
    const add = mock(async (input: any) => ({
      id: 'job-1',
      name: input.name,
      schedule: input.schedule,
      state: { nextRunAtMs: Date.now() + 60_000, consecutiveErrors: 0 },
      payload: input.payload,
      enabled: true,
      deleteAfterRun: input.deleteAfterRun,
    }));
    return { add, list: mock(async () => []), status: mock(async () => ({})) } as any;
  }

  const addArgs = {
    action: 'add',
    name: 'Daily digest',
    schedule: { kind: 'cron', expr: '0 9 * * *', tz: 'America/Buenos_Aires' },
    text: 'Send the digest',
    _botId: 'bot1',
  };

  test('resolves "operator" to the configured chat id in the payload', async () => {
    const svc = makeCronService();
    const tool = createCronTool(svc, { getOperator: () => OPERATOR });
    const result = await tool.execute({ ...addArgs, chatId: 'operator' }, logger);
    expect(result.success).toBe(true);
    expect(svc.add).toHaveBeenCalledTimes(1);
    expect(svc.add.mock.calls[0][0].payload.chatId).toBe(796164002);
  });

  test('the operator email resolves the same way', async () => {
    const svc = makeCronService();
    const tool = createCronTool(svc, { getOperator: () => OPERATOR });
    const result = await tool.execute({ ...addArgs, chatId: 'diego@example.com' }, logger);
    expect(result.success).toBe(true);
    expect(svc.add.mock.calls[0][0].payload.chatId).toBe(796164002);
  });

  test('not configured: error names the config key and no job is created', async () => {
    const svc = makeCronService();
    const tool = createCronTool(svc, { getOperator: () => ({ name: 'Diego' }) });
    const result = await tool.execute({ ...addArgs, chatId: 'operator' }, logger);
    expect(result.success).toBe(false);
    expect(result.content).toBe(OPERATOR_NOT_CONFIGURED_ERROR);
    expect(svc.add).not.toHaveBeenCalled();
  });

  test('numeric chat ids (number or numeric string) still work unchanged', async () => {
    const svc = makeCronService();
    const tool = createCronTool(svc, { getOperator: () => OPERATOR });
    await tool.execute({ ...addArgs, chatId: 123 }, logger);
    await tool.execute({ ...addArgs, chatId: '456' }, logger);
    expect(svc.add.mock.calls[0][0].payload.chatId).toBe(123);
    expect(svc.add.mock.calls[1][0].payload.chatId).toBe(456);
  });

  test('explicit operator alias wins over the conversation _chatId', async () => {
    const svc = makeCronService();
    const tool = createCronTool(svc, { getOperator: () => OPERATOR });
    await tool.execute({ ...addArgs, chatId: 'operator', _chatId: 999 }, logger);
    expect(svc.add.mock.calls[0][0].payload.chatId).toBe(796164002);
  });

  test('tool description advertises chatId: "operator"', () => {
    const tool = createCronTool(makeCronService(), { getOperator: () => OPERATOR });
    expect(tool.definition.function.description).toContain('"operator"');
  });
});
