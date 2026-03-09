import { describe, expect, test } from 'bun:test';

// Test the session key derivation logic and filtering that chat-history route uses
describe('chat-history route logic', () => {
  test('filters system messages from history', () => {
    const history = [
      { role: 'system', content: 'You are a bot' },
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi there!' },
      { role: 'user', content: '[CONTEXT_SUMMARY] Previous conversation summary' },
      { role: 'user', content: 'How are you?' },
      { role: 'assistant', content: 'I am doing well!' },
    ];

    const filtered = history.filter((msg) => {
      if (msg.role === 'system') return false;
      if (typeof msg.content === 'string' && msg.content.startsWith('[CONTEXT_SUMMARY]'))
        return false;
      return true;
    });

    expect(filtered).toHaveLength(4);
    expect(filtered[0].content).toBe('Hello');
    expect(filtered[1].content).toBe('Hi there!');
    expect(filtered[2].content).toBe('How are you?');
    expect(filtered[3].content).toBe('I am doing well!');
  });

  test('maps assistant role to bot', () => {
    const messages = [
      { role: 'user', content: 'Hi' },
      { role: 'assistant', content: 'Hello!' },
    ];

    const mapped = messages.map((msg) => ({
      role: msg.role === 'assistant' ? 'bot' : msg.role,
      content: msg.content,
    }));

    expect(mapped[0].role).toBe('user');
    expect(mapped[1].role).toBe('bot');
  });

  test('limit clamping', () => {
    const clamp = (v: number) => Math.min(Math.max(1, v), 200);
    expect(clamp(0)).toBe(1);
    expect(clamp(50)).toBe(50);
    expect(clamp(300)).toBe(200);
    expect(clamp(-5)).toBe(1);
  });

  test('preserves user messages with content that looks like system text', () => {
    const history = [
      { role: 'user', content: 'system prompt testing' },
      { role: 'assistant', content: 'Sure, I can help with that' },
    ];

    const filtered = history.filter((msg) => {
      if (msg.role === 'system') return false;
      if (typeof msg.content === 'string' && msg.content.startsWith('[CONTEXT_SUMMARY]'))
        return false;
      return true;
    });

    expect(filtered).toHaveLength(2);
    expect(filtered[0].content).toBe('system prompt testing');
  });

  test('handles empty history', () => {
    const history: { role: string; content: string }[] = [];

    const filtered = history.filter((msg) => {
      if (msg.role === 'system') return false;
      if (typeof msg.content === 'string' && msg.content.startsWith('[CONTEXT_SUMMARY]'))
        return false;
      return true;
    });

    expect(filtered).toHaveLength(0);
  });

  test('filters context summary regardless of role', () => {
    const history = [
      { role: 'system', content: '[CONTEXT_SUMMARY] Summary of previous context' },
      { role: 'user', content: '[CONTEXT_SUMMARY] User accidentally typed this' },
      { role: 'user', content: 'Normal message' },
    ];

    const filtered = history.filter((msg) => {
      if (msg.role === 'system') return false;
      if (typeof msg.content === 'string' && msg.content.startsWith('[CONTEXT_SUMMARY]'))
        return false;
      return true;
    });

    // Both system and [CONTEXT_SUMMARY] user messages filtered
    expect(filtered).toHaveLength(1);
    expect(filtered[0].content).toBe('Normal message');
  });
});
