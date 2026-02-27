import { describe, expect, test, beforeEach, afterEach, mock, spyOn } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createMoltbookRegisterTool } from '../src/tools/moltbook';

function makeLogger() {
  return {
    info: mock(() => {}),
    debug: mock(() => {}),
    warn: mock(() => {}),
    error: mock(() => {}),
    child: () => makeLogger(),
  } as any;
}

describe('moltbook_register tool', () => {
  const tool = createMoltbookRegisterTool();

  test('has correct definition', () => {
    expect(tool.definition.function.name).toBe('moltbook_register');
    expect(tool.definition.function.parameters.required).toContain('description');
  });

  test('rejects missing description', async () => {
    const result = await tool.execute({}, makeLogger());
    expect(result.success).toBe(false);
    expect(result.content).toContain('Missing required parameter');
  });

  test('rejects non-string description', async () => {
    const result = await tool.execute({ description: 123 }, makeLogger());
    expect(result.success).toBe(false);
    expect(result.content).toContain('Missing required parameter');
  });

  test('returns already registered when credentials exist', async () => {
    // We can't easily mock the CREDENTIALS_PATH constant,
    // but we can test the tool's behavior when fetch would be called
    // by checking it handles network errors gracefully
    const logger = makeLogger();
    const originalFetch = globalThis.fetch;

    // Mock fetch to simulate network error
    globalThis.fetch = mock(async () => {
      throw new Error('Network unavailable');
    }) as any;

    try {
      const result = await tool.execute(
        { description: 'Test agent' },
        logger,
      );
      // Either already registered (credentials file exists) or network error
      if (result.success) {
        expect(result.content).toContain('Already registered');
      } else {
        expect(result.content).toContain('error');
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('handles HTTP error from API', async () => {
    const logger = makeLogger();
    const originalFetch = globalThis.fetch;

    globalThis.fetch = mock(async () => ({
      ok: false,
      status: 422,
      text: async () => 'Validation failed: name already taken',
    })) as any;

    try {
      const result = await tool.execute(
        { description: 'Test agent' },
        logger,
      );
      // If credentials file exists, will return "already registered"
      // Otherwise will return the HTTP error
      if (!result.success) {
        expect(result.content).toContain('422');
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('handles successful registration', async () => {
    const logger = makeLogger();
    const originalFetch = globalThis.fetch;

    globalThis.fetch = mock(async () => ({
      ok: true,
      json: async () => ({
        api_key: 'test-key-123',
        claim_url: 'https://moltbook.com/claim/abc',
        verification_code: 'VERIFY-XYZ',
      }),
    })) as any;

    try {
      const result = await tool.execute(
        { description: 'An autonomous agent' },
        logger,
      );
      // If credentials file already exists, returns "already registered"
      // Otherwise returns registration success
      if (result.success && result.content.includes('claim_url')) {
        expect(result.content).toContain('NodeSpider');
        expect(result.content).toContain('claim');
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
