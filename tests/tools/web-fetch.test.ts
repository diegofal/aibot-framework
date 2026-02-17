import { describe, test, expect } from 'bun:test';
import { createWebFetchTool } from '../../src/tools/web-fetch';

function createMockLogger() {
  return {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    child: () => createMockLogger(),
    fatal: () => {},
    trace: () => {},
    level: 'info',
    silent: () => {},
  } as any;
}

const logger = createMockLogger();

describe('web_fetch tool', () => {
  const tool = createWebFetchTool({
    maxContentLength: 1000,
    timeout: 5000,
    cacheTtlMs: 100,
  });

  test('has correct definition', () => {
    expect(tool.definition.function.name).toBe('web_fetch');
    expect(tool.definition.type).toBe('function');
  });

  describe('input validation', () => {
    test('rejects missing url', async () => {
      const result = await tool.execute({}, logger);
      expect(result.success).toBe(false);
      expect(result.content).toContain('Missing required parameter');
    });

    test('rejects empty url', async () => {
      const result = await tool.execute({ url: '' }, logger);
      expect(result.success).toBe(false);
      expect(result.content).toContain('Missing required parameter');
    });

    test('rejects invalid url', async () => {
      const result = await tool.execute({ url: 'not-a-url' }, logger);
      expect(result.success).toBe(false);
      expect(result.content).toContain('Invalid URL');
    });

    test('rejects non-http(s) schemes', async () => {
      const result = await tool.execute({ url: 'ftp://example.com/file' }, logger);
      expect(result.success).toBe(false);
      expect(result.content).toContain('only http and https');
    });

    test('rejects file:// scheme', async () => {
      const result = await tool.execute({ url: 'file:///etc/passwd' }, logger);
      expect(result.success).toBe(false);
      expect(result.content).toContain('only http and https');
    });
  });

  describe('SSRF protection', () => {
    test('blocks localhost', async () => {
      const result = await tool.execute({ url: 'http://localhost/admin' }, logger);
      expect(result.success).toBe(false);
      expect(result.content).toContain('private/local');
    });

    test('blocks 127.0.0.1', async () => {
      const result = await tool.execute({ url: 'http://127.0.0.1:8080/' }, logger);
      expect(result.success).toBe(false);
      expect(result.content).toContain('private/local');
    });

    test('blocks 10.x.x.x', async () => {
      const result = await tool.execute({ url: 'http://10.0.0.1/' }, logger);
      expect(result.success).toBe(false);
      expect(result.content).toContain('private/local');
    });

    test('blocks 172.16-31.x.x', async () => {
      const result = await tool.execute({ url: 'http://172.16.0.1/' }, logger);
      expect(result.success).toBe(false);
      expect(result.content).toContain('private/local');
    });

    test('blocks 192.168.x.x', async () => {
      const result = await tool.execute({ url: 'http://192.168.1.1/' }, logger);
      expect(result.success).toBe(false);
      expect(result.content).toContain('private/local');
    });

    test('blocks 169.254.x.x (link-local)', async () => {
      const result = await tool.execute({ url: 'http://169.254.169.254/metadata' }, logger);
      expect(result.success).toBe(false);
      expect(result.content).toContain('private/local');
    });

    test('blocks 0.x.x.x', async () => {
      const result = await tool.execute({ url: 'http://0.0.0.0/' }, logger);
      expect(result.success).toBe(false);
      expect(result.content).toContain('private/local');
    });

    test('blocks IPv6 loopback', async () => {
      const result = await tool.execute({ url: 'http://[::1]/' }, logger);
      expect(result.success).toBe(false);
      expect(result.content).toContain('private/local');
    });

    test('blocks IPv6 unique-local (fc00::)', async () => {
      const result = await tool.execute({ url: 'http://[fc00::1]/' }, logger);
      expect(result.success).toBe(false);
      expect(result.content).toContain('private/local');
    });

    test('blocks IPv6 link-local (fe80::)', async () => {
      const result = await tool.execute({ url: 'http://[fe80::1]/' }, logger);
      expect(result.success).toBe(false);
      expect(result.content).toContain('private/local');
    });

    test('does not block public addresses (connection may fail but not SSRF)', async () => {
      // Use a non-routable TEST-NET address (RFC 5737) with very short timeout
      const shortTimeoutTool = createWebFetchTool({
        maxContentLength: 1000,
        timeout: 500,
        cacheTtlMs: 100,
      });
      const result = await shortTimeoutTool.execute({ url: 'http://203.0.113.1/' }, logger);
      // Should fail with connection/timeout error, NOT SSRF block
      expect(result.success).toBe(false);
      expect(result.content).not.toContain('private/local');
      expect(result.content).not.toContain('Blocked');
    });
  });
});
