/**
 * Dashboard sockets (`/ws/activity`, `/ws/logs`) that come back after a close.
 *
 * A server restart (every deploy) or a dropped connection used to leave a page
 * deaf until reload. `openReconnectingSocket` reopens with exponential backoff,
 * resets it once a connection opens, and stops for good on `close()`.
 */

/**
 * @param {number} attempt   0 for the first retry
 * @param {{ baseMs?: number, maxMs?: number }} [o]
 */
export function reconnectDelay(attempt, o = {}) {
  const base = o.baseMs ?? 1000;
  const max = o.maxMs ?? 30_000;
  return Math.min(max, base * 2 ** Math.max(0, attempt));
}

/**
 * @param {{ protocol: string, host: string }} loc   usually `location`
 * @param {string} path                              '/ws/activity' | '/ws/logs'
 * @param {{ token?: string | null, botId?: string }} [q]
 */
export function dashboardSocketUrl(loc, path, q = {}) {
  const proto = loc.protocol === 'https:' ? 'wss:' : 'ws:';
  const params = new URLSearchParams();
  if (q.token) params.set('token', q.token);
  if (q.botId) params.set('botId', q.botId);
  const qs = params.toString();
  return `${proto}//${loc.host}${path}${qs ? `?${qs}` : ''}`;
}

/**
 * @param {object} o
 * @param {() => string} o.url                 re-read on every (re)connect, so a new token is used
 * @param {(e: MessageEvent) => void} o.onMessage
 * @param {(url: string) => WebSocket} [o.createSocket]
 * @param {(fn: () => void, ms: number) => unknown} [o.schedule]
 * @param {(id: unknown) => void} [o.cancel]
 * @param {number} [o.baseMs]   first retry delay (1 000)
 * @param {number} [o.maxMs]    cap (30 000)
 * @returns {{ close: () => void }}
 */
export function openReconnectingSocket(o) {
  const createSocket = o.createSocket ?? ((u) => new WebSocket(u));
  const schedule = o.schedule ?? ((fn, ms) => setTimeout(fn, ms));
  const cancel = o.cancel ?? ((id) => clearTimeout(id));
  let ws = null;
  let timer = null;
  let attempt = 0;
  let stopped = false;

  const retry = () => {
    if (stopped) return;
    const ms = reconnectDelay(attempt++, o);
    timer = schedule(connect, ms);
  };

  function connect() {
    timer = null;
    if (stopped) return;
    try {
      ws = createSocket(o.url());
    } catch {
      ws = null;
      retry();
      return;
    }
    const sock = ws;
    sock.onopen = () => {
      attempt = 0;
    };
    sock.onmessage = (e) => o.onMessage(e);
    sock.onerror = () => sock.close();
    sock.onclose = () => {
      if (ws !== sock) return;
      ws = null;
      retry();
    };
  }

  connect();

  return {
    close() {
      stopped = true;
      if (timer !== null) cancel(timer);
      timer = null;
      const sock = ws;
      ws = null;
      if (sock) {
        try {
          sock.onclose = null;
          sock.close();
        } catch {
          /* ignore */
        }
      }
    },
  };
}
