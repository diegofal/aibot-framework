import { describe, test, expect, beforeEach } from 'bun:test';
import { createBrowserTool } from '../src/tools/browser';
import { addRefsToSnapshot } from '../src/tools/browser-snapshot';
import type { BrowserToolsConfig } from '../src/config';
import type { Tool } from '../src/tools/types';

const noopLogger = {
  info: () => {},
  warn: () => {},
  debug: () => {},
  error: () => {},
  child: () => noopLogger,
} as any;

function makeConfig(overrides: Partial<BrowserToolsConfig> = {}): BrowserToolsConfig {
  return {
    enabled: true,
    headless: true,
    launchTimeout: 30_000,
    navigationTimeout: 30_000,
    actionTimeout: 10_000,
    idleTimeoutMs: 300_000,
    screenshotDir: './data/screenshots',
    maxSnapshotChars: 40_000,
    enableEvaluate: false,
    viewport: { width: 1280, height: 720 },
    ...overrides,
  };
}

let tool: Tool;

beforeEach(() => {
  tool = createBrowserTool(makeConfig());
});

describe('browser tool — action dispatch', () => {
  test('unknown action returns error', async () => {
    const result = await tool.execute({ action: 'unknown' }, noopLogger);
    expect(result.success).toBe(false);
    expect(result.content).toContain('Unknown action');
    expect(result.content).toContain('unknown');
  });

  test('empty action returns error', async () => {
    const result = await tool.execute({ action: '' }, noopLogger);
    expect(result.success).toBe(false);
    expect(result.content).toContain('Unknown action');
  });

  test('missing action returns error', async () => {
    const result = await tool.execute({}, noopLogger);
    expect(result.success).toBe(false);
    expect(result.content).toContain('Unknown action');
  });
});

describe('browser tool — navigate validation', () => {
  test('missing url returns error', async () => {
    const result = await tool.execute({ action: 'navigate' }, noopLogger);
    expect(result.success).toBe(false);
    expect(result.content).toContain('Missing required parameter: url');
  });

  test('empty url returns error', async () => {
    const result = await tool.execute({ action: 'navigate', url: '' }, noopLogger);
    expect(result.success).toBe(false);
    expect(result.content).toContain('Missing required parameter: url');
  });

  test('invalid url returns error', async () => {
    const result = await tool.execute({ action: 'navigate', url: 'not-a-url' }, noopLogger);
    expect(result.success).toBe(false);
    expect(result.content).toContain('Invalid URL');
  });

  test('ftp scheme is rejected', async () => {
    const result = await tool.execute({ action: 'navigate', url: 'ftp://example.com' }, noopLogger);
    expect(result.success).toBe(false);
    expect(result.content).toContain('Only http and https');
  });

  test('file scheme is rejected', async () => {
    const result = await tool.execute({ action: 'navigate', url: 'file:///etc/passwd' }, noopLogger);
    expect(result.success).toBe(false);
    expect(result.content).toContain('Only http and https');
  });
});

describe('browser tool — SSRF protection', () => {
  const blockedUrls = [
    'http://localhost/admin',
    'http://127.0.0.1/secret',
    'http://127.0.0.2/test',
    'http://10.0.0.1/internal',
    'http://10.255.255.255/test',
    'http://172.16.0.1/admin',
    'http://172.31.255.255/test',
    'http://192.168.1.1/router',
    'http://169.254.169.254/metadata',
    'http://0.0.0.0/test',
  ];

  for (const url of blockedUrls) {
    test(`blocks ${new URL(url).hostname}`, async () => {
      const result = await tool.execute({ action: 'navigate', url }, noopLogger);
      expect(result.success).toBe(false);
      expect(result.content).toContain('Blocked');
    });
  }

  test('allows public URL format (does not block valid domains)', async () => {
    // URL validation passes, but browser launch fails (no Chromium in test env)
    const result = await tool.execute({ action: 'navigate', url: 'https://example.com' }, noopLogger);
    expect(result.success).toBe(false);
    // Should fail at navigation/launch level, not URL validation
    expect(result.content).toContain('Navigation failed');
    expect(result.content).not.toContain('Blocked');
    expect(result.content).not.toContain('Invalid URL');
  });
});

describe('browser tool — blockedUrlPatterns / allowedUrlPatterns', () => {
  test('blockedUrlPatterns rejects matching URL', async () => {
    const t = createBrowserTool(makeConfig({
      blockedUrlPatterns: ['evil\\.com'],
    }));
    const result = await t.execute({ action: 'navigate', url: 'https://evil.com/page' }, noopLogger);
    expect(result.success).toBe(false);
    expect(result.content).toContain('blocked by pattern');
  });

  test('blockedUrlPatterns allows non-matching URL (fails at browser level)', async () => {
    const t = createBrowserTool(makeConfig({
      blockedUrlPatterns: ['evil\\.com'],
    }));
    const result = await t.execute({ action: 'navigate', url: 'https://good.com/page' }, noopLogger);
    expect(result.content).not.toContain('blocked by pattern');
    expect(result.content).toContain('Navigation failed');
  });

  test('allowedUrlPatterns rejects URL not matching any pattern', async () => {
    const t = createBrowserTool(makeConfig({
      allowedUrlPatterns: ['example\\.com'],
    }));
    const result = await t.execute({ action: 'navigate', url: 'https://other.com' }, noopLogger);
    expect(result.success).toBe(false);
    expect(result.content).toContain('not in allowedUrlPatterns');
  });

  test('allowedUrlPatterns allows matching URL (fails at browser level)', async () => {
    const t = createBrowserTool(makeConfig({
      allowedUrlPatterns: ['example\\.com'],
    }));
    const result = await t.execute({ action: 'navigate', url: 'https://example.com/page' }, noopLogger);
    expect(result.content).not.toContain('not in allowedUrlPatterns');
    expect(result.content).toContain('Navigation failed');
  });
});

describe('browser tool — act validation', () => {
  test('missing kind returns error', async () => {
    const result = await tool.execute({ action: 'act', ref: 'e1' }, noopLogger);
    expect(result.success).toBe(false);
    expect(result.content).toContain('Missing required parameter: kind');
  });

  test('invalid kind returns error', async () => {
    const result = await tool.execute({ action: 'act', kind: 'destroy', ref: 'e1' }, noopLogger);
    expect(result.success).toBe(false);
    expect(result.content).toContain('Invalid kind');
    expect(result.content).toContain('destroy');
  });

  test('missing ref returns error', async () => {
    const result = await tool.execute({ action: 'act', kind: 'click' }, noopLogger);
    expect(result.success).toBe(false);
    expect(result.content).toContain('Missing required parameter: ref');
  });

  test('act without running browser returns error', async () => {
    const result = await tool.execute({ action: 'act', kind: 'click', ref: 'e1' }, noopLogger);
    expect(result.success).toBe(false);
    expect(result.content).toContain('Browser is not running');
  });
});

describe('browser tool — close (idempotent)', () => {
  test('close when not running succeeds', async () => {
    const result = await tool.execute({ action: 'close' }, noopLogger);
    expect(result.success).toBe(true);
    expect(result.content).toContain('Browser closed');
  });

  test('close twice succeeds both times', async () => {
    const r1 = await tool.execute({ action: 'close' }, noopLogger);
    const r2 = await tool.execute({ action: 'close' }, noopLogger);
    expect(r1.success).toBe(true);
    expect(r2.success).toBe(true);
  });
});

describe('browser tool — status', () => {
  test('status when not running', async () => {
    const result = await tool.execute({ action: 'status' }, noopLogger);
    expect(result.success).toBe(true);
    expect(result.content).toContain('not running');
  });
});

describe('browser tool — snapshot without browser', () => {
  test('snapshot when not running returns error', async () => {
    const result = await tool.execute({ action: 'snapshot' }, noopLogger);
    expect(result.success).toBe(false);
    expect(result.content).toContain('Browser is not running');
  });
});

describe('browser tool — screenshot without browser', () => {
  test('screenshot when not running returns error', async () => {
    const result = await tool.execute({ action: 'screenshot' }, noopLogger);
    expect(result.success).toBe(false);
    expect(result.content).toContain('Browser is not running');
  });
});

describe('addRefsToSnapshot', () => {
  test('adds refs to interactive elements', () => {
    const raw = [
      '- navigation "Main":',
      '  - link "Home"',
      '  - link "About"',
      '- main:',
      '  - heading "Welcome" [level=1]',
      '  - button "Sign In"',
    ].join('\n');

    const { text, refs } = addRefsToSnapshot(raw, 10_000);

    // Links and button should have refs
    expect(refs.size).toBe(3);
    expect(refs.get('e1')).toEqual({ role: 'link', name: 'Home' });
    expect(refs.get('e2')).toEqual({ role: 'link', name: 'About' });
    expect(refs.get('e3')).toEqual({ role: 'button', name: 'Sign In' });

    // Text should contain refs
    expect(text).toContain('[ref=e1]');
    expect(text).toContain('[ref=e2]');
    expect(text).toContain('[ref=e3]');

    // Non-interactive elements should NOT have refs
    expect(text).toContain('heading "Welcome" [level=1]');
    expect(text).not.toContain('heading "Welcome" [level=1] [ref=');

    // Navigation should appear without ref
    expect(text).toContain('navigation "Main"');
  });

  test('preserves non-interactive elements unchanged', () => {
    const raw = [
      '- main:',
      '  - paragraph "Some text"',
      '  - img "Logo"',
    ].join('\n');

    const { text, refs } = addRefsToSnapshot(raw, 10_000);
    expect(refs.size).toBe(0);
    expect(text).toBe(raw); // unchanged
  });

  test('truncates at maxChars', () => {
    const lines = [];
    for (let i = 0; i < 100; i++) {
      lines.push(`- button "Button number ${i} with a longer name for testing"`);
    }
    const raw = lines.join('\n');

    const { text } = addRefsToSnapshot(raw, 500);
    expect(text.length).toBeLessThanOrEqual(600); // allow slack for truncation message
    expect(text).toContain('[snapshot truncated]');
  });

  test('handles checkbox properties', () => {
    const raw = [
      '- checkbox "Accept terms" [checked]',
      '- checkbox "Newsletter" [unchecked]',
    ].join('\n');

    const { text, refs } = addRefsToSnapshot(raw, 10_000);
    expect(refs.size).toBe(2);
    expect(text).toContain('[checked]');
    expect(text).toContain('[ref=e1]');
    expect(text).toContain('[ref=e2]');
  });

  test('handles textbox elements', () => {
    const raw = '- textbox "Email"';
    const { text, refs } = addRefsToSnapshot(raw, 10_000);
    expect(refs.size).toBe(1);
    expect(refs.get('e1')).toEqual({ role: 'textbox', name: 'Email' });
    expect(text).toContain('[ref=e1]');
  });

  test('empty input', () => {
    const { text, refs } = addRefsToSnapshot('', 10_000);
    expect(text).toBe('');
    expect(refs.size).toBe(0);
  });

  test('handles nested interactive elements with colon', () => {
    const raw = [
      '- navigation "Nav":',
      '  - link "Home"',
      '  - combobox "Search":',
      '    - option "Result 1"',
    ].join('\n');

    const { text, refs } = addRefsToSnapshot(raw, 10_000);
    // navigation is NOT interactive, so only link, combobox, option get refs
    expect(refs.size).toBe(3);
    expect(refs.get('e1')).toEqual({ role: 'link', name: 'Home' });
    expect(refs.get('e2')).toEqual({ role: 'combobox', name: 'Search' });
    expect(refs.get('e3')).toEqual({ role: 'option', name: 'Result 1' });
    // combobox with colon should keep the colon
    expect(text).toContain('combobox "Search" [ref=e2]:');
  });

  test('handles elements without names', () => {
    const raw = '- button';
    const { refs } = addRefsToSnapshot(raw, 10_000);
    expect(refs.size).toBe(1);
    expect(refs.get('e1')).toEqual({ role: 'button', name: '' });
  });
});

describe('browser tool definition', () => {
  test('has correct name and actions', () => {
    const def = tool.definition;
    expect(def.function.name).toBe('browser');
    expect(def.function.parameters.properties.action).toBeDefined();
    expect((def.function.parameters.properties.action as any).enum).toEqual([
      'status', 'navigate', 'snapshot', 'act', 'screenshot', 'close',
    ]);
  });

  test('has required action parameter', () => {
    expect(tool.definition.function.parameters.required).toEqual(['action']);
  });
});
