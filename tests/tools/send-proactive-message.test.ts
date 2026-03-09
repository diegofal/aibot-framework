import { describe, expect, test } from 'bun:test';
import { createSendProactiveMessageTool } from '../../src/tools/send-proactive-message';

function createMockLogger() {
  return { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as any;
}

describe('send_proactive_message tool', () => {
  test('sends via Telegram for numeric chatId', async () => {
    let sentTo: number | null = null;
    let sentText = '';

    const tool = createSendProactiveMessageTool({
      sendTelegramMessage: async (chatId, text) => {
        sentTo = chatId;
        sentText = text;
      },
      appendToSession: () => {},
    });

    const result = await tool.execute(
      { chatId: '12345', message: 'Hello!', _botId: 'bot1' },
      createMockLogger()
    );

    expect(result.success).toBe(true);
    expect(sentTo).toBe(12345);
    expect(sentText).toBe('Hello!');
  });

  test('appends to session for non-numeric userId', async () => {
    let appendedBotId = '';
    let appendedUserId = '';
    let appendedText = '';

    const tool = createSendProactiveMessageTool({
      sendTelegramMessage: async () => {},
      appendToSession: (botId, userId, text) => {
        appendedBotId = botId;
        appendedUserId = userId;
        appendedText = text;
      },
    });

    const result = await tool.execute(
      { chatId: 'widget-user-abc', message: 'Check your goals!', _botId: 'coach-bot' },
      createMockLogger()
    );

    expect(result.success).toBe(true);
    expect(appendedBotId).toBe('coach-bot');
    expect(appendedUserId).toBe('widget-user-abc');
    expect(appendedText).toBe('Check your goals!');
  });

  test('rejects missing chatId', async () => {
    const tool = createSendProactiveMessageTool({
      sendTelegramMessage: async () => {},
      appendToSession: () => {},
    });

    const result = await tool.execute({ message: 'Hello' }, createMockLogger());
    expect(result.success).toBe(false);
    expect(result.content).toContain('Missing chatId');
  });

  test('rejects missing message', async () => {
    const tool = createSendProactiveMessageTool({
      sendTelegramMessage: async () => {},
      appendToSession: () => {},
    });

    const result = await tool.execute({ chatId: '123' }, createMockLogger());
    expect(result.success).toBe(false);
    expect(result.content).toContain('Missing message');
  });

  test('rejects message over 4000 chars', async () => {
    const tool = createSendProactiveMessageTool({
      sendTelegramMessage: async () => {},
      appendToSession: () => {},
    });

    const result = await tool.execute(
      { chatId: '123', message: 'x'.repeat(4001) },
      createMockLogger()
    );
    expect(result.success).toBe(false);
    expect(result.content).toContain('too long');
  });

  test('handles Telegram send error gracefully', async () => {
    const tool = createSendProactiveMessageTool({
      sendTelegramMessage: async () => {
        throw new Error('Bot blocked');
      },
      appendToSession: () => {},
    });

    const result = await tool.execute(
      { chatId: '12345', message: 'Hello', _botId: 'bot1' },
      createMockLogger()
    );

    expect(result.success).toBe(false);
    expect(result.content).toContain('Bot blocked');
  });

  test('tool definition has correct name and required params', () => {
    const tool = createSendProactiveMessageTool({
      sendTelegramMessage: async () => {},
      appendToSession: () => {},
    });

    expect(tool.definition.function.name).toBe('send_proactive_message');
    expect(tool.definition.function.parameters.required).toEqual(['chatId', 'message']);
  });
});
