import { describe, expect, test } from 'bun:test';
import {
  buildClaudePromptInput,
  buildStreamJsonUserMessage,
  extractStreamJsonResult,
  sniffImageMediaType,
} from '../src/claude-cli';
import { ClaudeCliLLMClient } from '../src/core/llm-client';

// Minimal mock logger
const mockLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  child: () => mockLogger,
} as any;

const b64 = (bytes: number[]) => Buffer.from(bytes).toString('base64');
const JPEG = b64([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]);
const PNG = b64([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const GIF = Buffer.from('GIF89a....').toString('base64');
const WEBP = Buffer.from('RIFF\0\0\0\0WEBPVP8 ').toString('base64');

describe('sniffImageMediaType', () => {
  test('reads the magic bytes, not a declared type', () => {
    expect(sniffImageMediaType(JPEG)).toBe('image/jpeg');
    expect(sniffImageMediaType(PNG)).toBe('image/png');
    expect(sniffImageMediaType(GIF)).toBe('image/gif');
    expect(sniffImageMediaType(WEBP)).toBe('image/webp');
  });

  test('unknown bytes fall back to jpeg (what Telegram photos are)', () => {
    expect(sniffImageMediaType(b64([1, 2, 3, 4]))).toBe('image/jpeg');
  });
});

describe('buildStreamJsonUserMessage', () => {
  test('one user message: image blocks first, then the prompt text', () => {
    const line = buildStreamJsonUserMessage('what is this?', [PNG, JPEG]);
    expect(line.endsWith('\n')).toBe(true);
    const msg = JSON.parse(line);
    expect(msg.type).toBe('user');
    expect(msg.message.role).toBe('user');
    expect(msg.message.content).toEqual([
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG } },
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: JPEG } },
      { type: 'text', text: 'what is this?' },
    ]);
  });
});

describe('buildClaudePromptInput', () => {
  test('without images the prompt goes as the -p argument, json output', () => {
    const input = buildClaudePromptInput('hello');
    expect(input.args).toEqual(['-p', 'hello', '--output-format', 'json']);
    expect(input.stdin).toBeUndefined();
  });

  test('with images the prompt goes on stdin as stream-json', () => {
    const input = buildClaudePromptInput('hello', [PNG]);
    expect(input.args).toEqual([
      '-p',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--verbose',
    ]);
    expect(input.args).not.toContain('hello');
    expect(input.stdin).toBe(buildStreamJsonUserMessage('hello', [PNG]));
  });

  test('an empty images array is the plain path', () => {
    expect(buildClaudePromptInput('hello', []).stdin).toBeUndefined();
  });
});

describe('extractStreamJsonResult', () => {
  test('returns the result event line, which has the --output-format json shape', () => {
    const result = { type: 'result', result: 'Red', is_error: false, usage: { input_tokens: 3 } };
    const stdout = [
      JSON.stringify({ type: 'system', subtype: 'init' }),
      JSON.stringify({ type: 'assistant', message: { content: [] } }),
      JSON.stringify(result),
      '',
    ].join('\n');
    expect(JSON.parse(extractStreamJsonResult(stdout))).toEqual(result);
  });

  test('no result event: stdout comes back unchanged', () => {
    expect(extractStreamJsonResult('not json\n')).toBe('not json\n');
  });
});

describe('ClaudeCliLLMClient — image handling', () => {
  const client = new ClaudeCliLLMClient('/usr/bin/false', 1000, mockLogger);

  test('images on messages are collected for the CLI, not replaced by a "no vision" note', () => {
    const built = (client as any).buildPrompt([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'What is in this image?', images: [JPEG, PNG] },
    ]);
    expect(built.system).toBe('sys');
    expect(built.images).toEqual([JPEG, PNG]);
    expect(built.prompt).toContain('What is in this image?');
    expect(built.prompt).toContain('2 image(s) attached');
    expect(built.prompt).not.toContain('does not support');
  });

  test('no images: plain transcript and no images', () => {
    const built = (client as any).buildPrompt([
      { role: 'user', content: 'Hello world' },
      { role: 'assistant', content: 'Hi' },
      { role: 'tool', content: 'ok' },
    ]);
    expect(built.prompt).toBe('User: Hello world\n\nAssistant: Hi\n\nTool Result: ok');
    expect(built.images).toEqual([]);
  });

  test('an empty images array adds no marker', () => {
    const built = (client as any).buildPrompt([{ role: 'user', content: 'x', images: [] }]);
    expect(built.prompt).toBe('User: x');
  });

  test('keeps only the most recent images', () => {
    const many = Array.from({ length: 12 }, (_, i) => b64([0xff, 0xd8, 0xff, i]));
    const built = (client as any).buildPrompt([{ role: 'user', content: 'x', images: many }]);
    expect(built.images).toEqual(many.slice(-8));
  });
});
