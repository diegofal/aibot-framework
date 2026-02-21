import type { Browser, BrowserContext, Page } from 'playwright';
import type { ElementRef } from './browser-snapshot';
import type { BrowserToolsConfig } from '../config';

// ─── Singleton State ────────────────────────────────────────

let browser: Browser | null = null;
let context: BrowserContext | null = null;
let activePage: Page | null = null;
let currentRefs = new Map<string, ElementRef>();
let idleTimer: ReturnType<typeof setTimeout> | null = null;
let launchPromise: Promise<void> | null = null;
let currentConfig: BrowserToolsConfig | null = null;

// ─── Idle Timer ─────────────────────────────────────────────

function resetIdleTimer(): void {
  if (idleTimer) clearTimeout(idleTimer);
  const timeout = currentConfig?.idleTimeoutMs ?? 300_000;
  idleTimer = setTimeout(() => {
    closeBrowser().catch(() => {});
  }, timeout);
}

// ─── Public API ─────────────────────────────────────────────

export function touchActivity(): void {
  resetIdleTimer();
}

export function storeRefs(refs: Map<string, ElementRef>): void {
  currentRefs = refs;
}

export function resolveRef(refId: string): ElementRef | undefined {
  return currentRefs.get(refId);
}

export function getBrowserStatus(): {
  running: boolean;
  url?: string;
  title?: string;
} {
  if (!browser || !activePage) {
    return { running: false };
  }
  return {
    running: true,
    url: activePage.url(),
    title: undefined, // title requires async — set by caller if needed
  };
}

export function isRunning(): boolean {
  return browser !== null && activePage !== null;
}

export function getActivePage(): Page | null {
  return activePage;
}

/**
 * Ensure browser is launched and a page is ready.
 * Deduplicates concurrent launches via launchPromise.
 */
export async function ensureBrowser(config: BrowserToolsConfig): Promise<Page> {
  currentConfig = config;

  if (activePage && browser) {
    touchActivity();
    return activePage;
  }

  if (launchPromise) {
    await launchPromise;
    if (activePage) return activePage;
  }

  launchPromise = doLaunch(config);
  try {
    await launchPromise;
  } finally {
    launchPromise = null;
  }

  return activePage!;
}

async function doLaunch(config: BrowserToolsConfig): Promise<void> {
  const pw = await import('playwright');

  const launchOptions: Record<string, unknown> = {
    headless: config.headless,
    timeout: config.launchTimeout,
  };
  if (config.executablePath) {
    launchOptions.executablePath = config.executablePath;
  }

  browser = await pw.chromium.launch(launchOptions);

  context = await browser.newContext({
    viewport: {
      width: config.viewport.width,
      height: config.viewport.height,
    },
  });

  activePage = await context.newPage();
  activePage.setDefaultNavigationTimeout(config.navigationTimeout);
  activePage.setDefaultTimeout(config.actionTimeout);

  // Close everything if browser disconnects unexpectedly
  browser.on('disconnected', () => {
    browser = null;
    context = null;
    activePage = null;
    currentRefs.clear();
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
  });

  resetIdleTimer();
}

/**
 * Close the browser and free all resources. Idempotent.
 */
export async function closeBrowser(): Promise<void> {
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }

  currentRefs.clear();

  if (browser) {
    try {
      await browser.close();
    } catch {
      // Already closed
    }
  }

  browser = null;
  context = null;
  activePage = null;
  launchPromise = null;
}
