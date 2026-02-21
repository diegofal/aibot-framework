import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Tool, ToolResult } from './types';
import { wrapExternalContent } from './types';
import type { Logger } from '../logger';
import type { BrowserToolsConfig } from '../config';
import {
  ensureBrowser,
  getActivePage,
  getBrowserStatus,
  isRunning,
  closeBrowser,
  storeRefs,
  resolveRef,
  touchActivity,
} from './browser-session';
import { takeSnapshot } from './browser-snapshot';

// ─── URL Security ───────────────────────────────────────────

const BLOCKED_HOST_PATTERNS = [
  /^localhost$/i,
  /^127\./,
  /^10\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^169\.254\./,
  /^0\./,
  /^\[::1\]$/,
  /^\[fc/i,
  /^\[fd/i,
  /^\[fe80/i,
];

function isBlockedHost(hostname: string): boolean {
  return BLOCKED_HOST_PATTERNS.some((p) => p.test(hostname));
}

function validateUrl(
  rawUrl: string,
  config: BrowserToolsConfig,
): { ok: true; url: URL } | { ok: false; reason: string } {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { ok: false, reason: `Invalid URL: ${rawUrl}` };
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    return { ok: false, reason: 'Only http and https URLs are allowed' };
  }

  if (isBlockedHost(parsed.hostname)) {
    return { ok: false, reason: 'Blocked: cannot navigate to private/local addresses' };
  }

  // Configurable blocklist
  if (config.blockedUrlPatterns?.length) {
    for (const pattern of config.blockedUrlPatterns) {
      if (new RegExp(pattern).test(rawUrl)) {
        return { ok: false, reason: `URL blocked by pattern: ${pattern}` };
      }
    }
  }

  // Configurable allowlist (if set, URL must match at least one)
  if (config.allowedUrlPatterns?.length) {
    const allowed = config.allowedUrlPatterns.some((p) => new RegExp(p).test(rawUrl));
    if (!allowed) {
      return { ok: false, reason: 'URL not in allowedUrlPatterns' };
    }
  }

  return { ok: true, url: parsed };
}

// ─── Action Handlers ────────────────────────────────────────

async function handleStatus(logger: Logger): Promise<ToolResult> {
  const status = getBrowserStatus();
  if (!status.running) {
    return { success: true, content: 'Browser is not running.' };
  }

  const page = getActivePage()!;
  const title = await page.title();
  logger.debug('browser: status');
  return {
    success: true,
    content: `Browser is running.\nURL: ${status.url}\nTitle: ${title}`,
  };
}

async function handleNavigate(
  args: Record<string, unknown>,
  config: BrowserToolsConfig,
  logger: Logger,
): Promise<ToolResult> {
  const rawUrl = String(args.url ?? '').trim();
  if (!rawUrl) {
    return { success: false, content: 'Missing required parameter: url' };
  }

  const check = validateUrl(rawUrl, config);
  if (!check.ok) {
    return { success: false, content: check.reason };
  }

  logger.info({ url: rawUrl }, 'browser: navigate');

  let page;
  try {
    page = await ensureBrowser(config);
    await page.goto(rawUrl, { waitUntil: 'load' });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return { success: false, content: `Navigation failed: ${msg}` };
  }

  // Auto-snapshot after navigation
  const snap = await takeSnapshot(page, config.maxSnapshotChars);
  storeRefs(snap.refs);
  touchActivity();

  const suffix = snap.truncated ? '\n\n[snapshot truncated]' : '';
  return { success: true, content: wrapExternalContent(snap.text + suffix) };
}

async function handleSnapshot(
  config: BrowserToolsConfig,
  logger: Logger,
): Promise<ToolResult> {
  if (!isRunning()) {
    return { success: false, content: 'Browser is not running. Use navigate first.' };
  }

  const page = getActivePage()!;
  logger.debug('browser: snapshot');

  const snap = await takeSnapshot(page, config.maxSnapshotChars);
  storeRefs(snap.refs);
  touchActivity();

  const suffix = snap.truncated ? '\n\n[snapshot truncated]' : '';
  return { success: true, content: wrapExternalContent(snap.text + suffix) };
}

const VALID_ACT_KINDS = new Set(['click', 'type', 'fill', 'press', 'hover', 'select']);

async function handleAct(
  args: Record<string, unknown>,
  config: BrowserToolsConfig,
  logger: Logger,
): Promise<ToolResult> {
  const kind = String(args.kind ?? '').trim();
  const ref = String(args.ref ?? '').trim();

  if (!kind) {
    return { success: false, content: 'Missing required parameter: kind' };
  }
  if (!VALID_ACT_KINDS.has(kind)) {
    return {
      success: false,
      content: `Invalid kind: ${kind}. Valid kinds: ${[...VALID_ACT_KINDS].join(', ')}`,
    };
  }
  if (!ref) {
    return { success: false, content: 'Missing required parameter: ref' };
  }

  if (!isRunning()) {
    return { success: false, content: 'Browser is not running. Use navigate first.' };
  }

  const element = resolveRef(ref);
  if (!element) {
    return {
      success: false,
      content: `Unknown ref: ${ref}. Take a new snapshot to get current element refs.`,
    };
  }

  const page = getActivePage()!;
  logger.info({ kind, ref, element: element.name }, 'browser: act');

  try {
    // Locate element by role + name
    const locator = page.getByRole(element.role as any, {
      name: element.name || undefined,
    }).first();

    switch (kind) {
      case 'click':
        await locator.click({ timeout: config.actionTimeout });
        break;
      case 'type':
        await locator.pressSequentially(String(args.text ?? ''), { timeout: config.actionTimeout });
        break;
      case 'fill':
        await locator.fill(String(args.text ?? ''), { timeout: config.actionTimeout });
        break;
      case 'press':
        await locator.press(String(args.key ?? ''), { timeout: config.actionTimeout });
        break;
      case 'hover':
        await locator.hover({ timeout: config.actionTimeout });
        break;
      case 'select': {
        const values = args.values;
        const selectValues = Array.isArray(values) ? values.map(String) : [String(values ?? '')];
        await locator.selectOption(selectValues, { timeout: config.actionTimeout });
        break;
      }
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return { success: false, content: `Action failed: ${msg}` };
  }

  // Wait briefly for any navigation/re-render
  await page.waitForTimeout(500);

  // Auto-snapshot after action
  const snap = await takeSnapshot(page, config.maxSnapshotChars);
  storeRefs(snap.refs);
  touchActivity();

  const suffix = snap.truncated ? '\n\n[snapshot truncated]' : '';
  return { success: true, content: wrapExternalContent(snap.text + suffix) };
}

async function handleScreenshot(
  args: Record<string, unknown>,
  config: BrowserToolsConfig,
  logger: Logger,
): Promise<ToolResult> {
  if (!isRunning()) {
    return { success: false, content: 'Browser is not running. Use navigate first.' };
  }

  const page = getActivePage()!;
  const fullPage = args.full_page === true;

  mkdirSync(config.screenshotDir, { recursive: true });

  const filename = `screenshot_${Date.now()}.png`;
  const filepath = join(config.screenshotDir, filename);

  await page.screenshot({
    path: filepath,
    fullPage,
  });

  touchActivity();
  logger.info({ filepath, fullPage }, 'browser: screenshot');

  return {
    success: true,
    content: `Screenshot saved to: ${filepath}`,
  };
}

async function handleClose(logger: Logger): Promise<ToolResult> {
  await closeBrowser();
  logger.info('browser: closed');
  return { success: true, content: 'Browser closed.' };
}

// ─── Tool Factory ───────────────────────────────────────────

export function createBrowserTool(config: BrowserToolsConfig): Tool {
  return {
    definition: {
      type: 'function',
      function: {
        name: 'browser',
        description:
          'Control a headless browser for interacting with dynamic web pages. Actions: ' +
          '"status" — check if browser is running. ' +
          '"navigate" — go to a URL (returns accessibility snapshot). ' +
          '"snapshot" — get current page accessibility tree with element refs. ' +
          '"act" — interact with an element by ref (click, type, fill, press, hover, select). ' +
          '"screenshot" — save a screenshot to disk. ' +
          '"close" — shut down the browser.',
        parameters: {
          type: 'object',
          properties: {
            action: {
              type: 'string',
              enum: ['status', 'navigate', 'snapshot', 'act', 'screenshot', 'close'],
              description: 'The action to perform',
            },
            url: {
              type: 'string',
              description: 'URL to navigate to (required for "navigate")',
            },
            kind: {
              type: 'string',
              enum: ['click', 'type', 'fill', 'press', 'hover', 'select'],
              description: 'Interaction kind (required for "act")',
            },
            ref: {
              type: 'string',
              description: 'Element reference from snapshot, e.g. "e3" (required for "act")',
            },
            text: {
              type: 'string',
              description: 'Text input for "type" or "fill" actions',
            },
            key: {
              type: 'string',
              description: 'Key to press for "press" action, e.g. "Enter", "Tab"',
            },
            values: {
              type: 'array',
              items: { type: 'string' },
              description: 'Values to select for "select" action',
            },
            full_page: {
              type: 'boolean',
              description: 'Capture full scrollable page for "screenshot" (default: false)',
            },
          },
          required: ['action'],
        },
      },
    },

    async execute(args: Record<string, unknown>, logger: Logger): Promise<ToolResult> {
      const action = String(args.action ?? '').trim();

      switch (action) {
        case 'status':
          return handleStatus(logger);
        case 'navigate':
          return handleNavigate(args, config, logger);
        case 'snapshot':
          return handleSnapshot(config, logger);
        case 'act':
          return handleAct(args, config, logger);
        case 'screenshot':
          return handleScreenshot(args, config, logger);
        case 'close':
          return handleClose(logger);
        default:
          return {
            success: false,
            content: `Unknown action: ${action}. Valid actions: status, navigate, snapshot, act, screenshot, close`,
          };
      }
    },
  };
}
