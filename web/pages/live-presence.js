/**
 * Live links to the activity stream.
 *
 * `watchAgent()` — one `/ws/activity` socket filtered to a bot plus a slow
 * poll, feeding the presence header (and, on the Home page, the timeline).
 * `watchFleet()` — one socket for the whole fleet, feeding the Fleet Home
 * ticker and refetching the fleet presence map.
 *
 * Pages call the watcher on render and the returned `stop()` on navigation;
 * `app.js` calls `stopAllWatches()` from `navigate()` so a page that forgets
 * still gets cleaned up.
 */
import { isPresenceEvent } from './agent-home-helpers.js';
import { api, getAuthToken } from './shared.js';

const active = new Set();

/**
 * Shared link: socket + debounced refresh + fallback poll.
 * @param {object} o
 * @param {() => Promise<void>} o.refresh
 * @param {(event: object) => boolean} o.accept   which activity events matter
 * @param {(event: object) => void} [o.onEvent]
 * @param {number} o.debounceMs
 * @param {number} o.pollMs
 */
function openLink(o) {
  let ws = null;
  let timer = null;
  let stopped = false;

  const refresh = async () => {
    if (stopped) return;
    await o.refresh();
  };
  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(refresh, o.debounceMs);
  };

  const poll = setInterval(refresh, o.pollMs);
  try {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const token = getAuthToken();
    const authParam = token ? `?token=${encodeURIComponent(token)}` : '';
    ws = new WebSocket(`${proto}//${location.host}/ws/activity${authParam}`);
    ws.onmessage = (e) => {
      try {
        const d = JSON.parse(e.data);
        if (d.type !== 'activity' || !o.accept(d.event)) return;
        o.onEvent?.(d.event);
        schedule();
      } catch {
        /* ignore */
      }
    };
    ws.onerror = () => ws?.close();
  } catch {
    /* polling still runs */
  }

  const handle = {
    refresh,
    stop() {
      stopped = true;
      active.delete(handle);
      clearTimeout(timer);
      clearInterval(poll);
      if (ws) {
        try {
          ws.onclose = null;
          ws.close();
        } catch {
          /* ignore */
        }
        ws = null;
      }
    },
  };
  active.add(handle);
  return handle;
}

/**
 * @param {string} botId
 * @param {object} opts
 * @param {(presence: object) => void} opts.onPresence  called with each fresh `/presence` payload
 * @param {(event: object) => void} [opts.onEvent]      called with every matching activity event
 * @param {number} [opts.debounceMs]                     wait after an event before refetching (800)
 * @param {number} [opts.pollMs]                         fallback poll interval (30 000)
 * @returns {{ stop: () => void, refresh: () => Promise<void> }}
 */
export function watchAgent(botId, opts = {}) {
  return openLink({
    debounceMs: opts.debounceMs ?? 800,
    pollMs: opts.pollMs ?? 30_000,
    accept: (ev) => isPresenceEvent(ev, botId),
    onEvent: opts.onEvent,
    refresh: async () => {
      try {
        const p = await api(`/api/agents/${encodeURIComponent(botId)}/presence`);
        if (p && !p.error) opts.onPresence?.(p);
      } catch {
        /* keep the last known line */
      }
    },
  });
}

/**
 * Fleet-wide link: every activity event reaches `onEvent`; the fleet presence
 * map (`GET /api/agents/presence`) is refetched debounced after presence
 * events and on the poll.
 * @param {object} opts
 * @param {(body: { generatedAt: string, agents: object }) => void} opts.onPresence
 * @param {(event: object) => void} [opts.onEvent]
 * @param {number} [opts.debounceMs]  (1 500)
 * @param {number} [opts.pollMs]      (30 000)
 */
export function watchFleet(opts = {}) {
  return openLink({
    debounceMs: opts.debounceMs ?? 1500,
    pollMs: opts.pollMs ?? 30_000,
    accept: (ev) => Boolean(ev && typeof ev.type === 'string'),
    onEvent: opts.onEvent,
    refresh: async () => {
      try {
        const body = await api('/api/agents/presence');
        if (body && !body.error) opts.onPresence?.(body);
      } catch {
        /* keep the last known map */
      }
    },
  });
}

export function stopAllWatches() {
  for (const h of [...active]) h.stop();
}
