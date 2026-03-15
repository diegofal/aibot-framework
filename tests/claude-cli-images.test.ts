import { describe, expect, test } from 'bun:test';
import { ClaudeCliLLMClient } from '../src/core/llm-client';

// Minimal mock logger
const mockLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  child: () => mockLogger,
} as any;

describe('ClaudeCliLLMClient — image handling', () => {
  test('formatMessageContent adds image marker when images present', () => {
    // Access the private method via prototype for testing
    const client = new ClaudeCliLLMClient('/usr/bin/false', 1000, mockLogger);

    // Use the formatMessageContent method indirectly by checking what chat() would build
    // We test the method exists and works by instantiating and checking the prototype
    const formatted = (client as any).formatMessageContent({
      role: 'user' as const,
      content: 'What is in this image?',
      images: ['base64data1', 'base64data2'],
    });

    expect(formatted).toContain('What is in this image?');
    expect(formatted).toContain('2 image(s) attached');
    expect(formatted).toContain('Claude CLI does not support inline vision');
  });

  test('formatMessageContent returns plain content when no images', () => {
    const client = new ClaudeCliLLMClient('/usr/bin/false', 1000, mockLogger);

    const formatted = (client as any).formatMessageContent({
      role: 'user' as const,
      content: 'Hello world',
    });

    expect(formatted).toBe('Hello world');
    expect(formatted).not.toContain('image');
  });

  test('formatMessageContent handles empty images array', () => {
    const client = new ClaudeCliLLMClient('/usr/bin/false', 1000, mockLogger);

    const formatted = (client as any).formatMessageContent({
      role: 'user' as const,
      content: 'No images here',
      images: [],
    });

    expect(formatted).toBe('No images here');
  });

  test('formatMessageContent handles single image', () => {
    const client = new ClaudeCliLLMClient('/usr/bin/false', 1000, mockLogger);

    const formatted = (client as any).formatMessageContent({
      role: 'user' as const,
      content: 'Look at this',
      images: ['singleBase64'],
    });

    expect(formatted).toContain('1 image(s) attached');
  });
});
