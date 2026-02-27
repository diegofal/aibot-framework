import type { Browser, BrowserContext, Page } from 'playwright';
import type { ElementRef } from './browser-snapshot';
import type { BrowserToolsConfig } from '../config';

// ─── Per-Bot Session State ──────────────────────────────────

interface BrowserSession {
  browser: Browser | null;
  context: BrowserContext | null;
  activePage: Page | null;
  currentRefs: Map<string, ElementRef>;
  idleTimer: ReturnType<typeof setTimeout> | null;
  launchPromise: Promise<void> | null;
  currentConfig: BrowserToolsConfig | null;
}

const sessions = new Map<string, BrowserSession>();

function getSession(botId: string): BrowserSession {
  let session = sessions.get(botId);
  if (!session) {
    session = {
      browser: null,
      context: null,
      activePage: null,
      currentRefs: new Map(),
      idleTimer: null,
      launchPromise: null,
      currentConfig: null,
    };
    sessions.set(botId, session);
  }
  return session;
}

// ─── Idle Timer ─────────────────────────────────────────────

function resetIdleTimer(botId: string, session: BrowserSession): void {
  if (session.idleTimer) clearTimeout(session.idleTimer);
  const timeout = session.currentConfig?.idleTimeoutMs ?? 300_000;
  session.idleTimer = setTimeout(() => {
    closeBrowser(botId).catch(() => {});
  }, timeout);
}

// ─── Public API ─────────────────────────────────────────────

export function touchActivity(botId: string): void {
  const session = getSession(botId);
  resetIdleTimer(botId, session);
}

export function storeRefs(botId: string, refs: Map<string, ElementRef>): void {
  getSession(botId).currentRefs = refs;
}

export function resolveRef(botId: string, refId: string): ElementRef | undefined {
  return getSession(botId).currentRefs.get(refId);
}

export function getBrowserStatus(botId: string): {
  running: boolean;
  url?: string;
  title?: string;
} {
  const session = getSession(botId);
  if (!session.browser || !session.activePage) {
    return { running: false };
  }
  return {
    running: true,
    url: session.activePage.url(),
    title: undefined,
  };
}

export function isRunning(botId: string): boolean {
  const session = getSession(botId);
  return session.browser !== null && session.activePage !== null;
}

export function getActivePage(botId: string): Page | null {
  return getSession(botId).activePage;
}

/**
 * Ensure browser is launched and a page is ready.
 * Deduplicates concurrent launches via launchPromise.
 */
export async function ensureBrowser(botId: string, config: BrowserToolsConfig): Promise<Page> {
  const session = getSession(botId);
  session.currentConfig = config;

  if (session.activePage && session.browser) {
    touchActivity(botId);
    return session.activePage;
  }

  if (session.launchPromise) {
    await session.launchPromise;
    if (session.activePage) return session.activePage;
  }

  session.launchPromise = doLaunch(botId, session, config);
  try {
    await session.launchPromise;
  } finally {
    session.launchPromise = null;
  }

  return session.activePage!;
}

async function doLaunch(botId: string, session: BrowserSession, config: BrowserToolsConfig): Promise<void> {
  const pw = await import('playwright');

  const launchOptions: Record<string, unknown> = {
    headless: config.headless,
    timeout: config.launchTimeout,
  };
  if (config.executablePath) {
    launchOptions.executablePath = config.executablePath;
  }

  session.browser = await pw.chromium.launch(launchOptions);

  session.context = await session.browser.newContext({
    viewport: {
      width: config.viewport.width,
      height: config.viewport.height,
    },
  });

  session.activePage = await session.context.newPage();
  session.activePage.setDefaultNavigationTimeout(config.navigationTimeout);
  session.activePage.setDefaultTimeout(config.actionTimeout);

  // Close everything if browser disconnects unexpectedly.
  // Capture `session` by closure (not re-fetching from map) because
  // closeBrowser may have already deleted the map entry.
  session.browser.on('disconnected', () => {
    session.browser = null;
    session.context = null;
    session.activePage = null;
    session.currentRefs.clear();
    if (session.idleTimer) {
      clearTimeout(session.idleTimer);
      session.idleTimer = null;
    }
  });

  resetIdleTimer(botId, session);
}

/**
 * Close the browser and free all resources for a specific bot. Idempotent.
 */
export async function closeBrowser(botId: string): Promise<void> {
  const session = sessions.get(botId);
  if (!session) return;

  if (session.idleTimer) {
    clearTimeout(session.idleTimer);
    session.idleTimer = null;
  }

  session.currentRefs.clear();

  if (session.browser) {
    try {
      await session.browser.close();
    } catch {
      // Already closed
    }
  }

  session.browser = null;
  session.context = null;
  session.activePage = null;
  session.launchPromise = null;
  sessions.delete(botId);
}

/**
 * Close all browser sessions (for shutdown).
 */
export async function closeAllBrowsers(): Promise<void> {
  const botIds = [...sessions.keys()];
  await Promise.all(botIds.map((id) => closeBrowser(id)));
}
