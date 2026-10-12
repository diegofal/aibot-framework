/**
 * Workers — Work tab (C20 of docs/plans/goal-tasks-architecture-plan.md):
 * task-worker runs across the fleet, active first, then recent. Click a row
 * for the worker sheet (Stop, Retry, journal).
 *
 * Data: `GET /api/workers` (tenant-scoped). Live: `worker:*` / `task:changed`
 * on the activity socket trigger a debounced refetch, plus a slow poll — the
 * page never relies on push alone. Markup: workers-helpers.js.
 */
import { emptyState, skeleton } from '../ui/index.js';
import { api, getAuthToken } from './shared.js';
import { isWorkerEvent, workersList } from './workers-helpers.js';
import { dashboardSocketUrl, openReconnectingSocket } from './ws-reconnect.js';

const REFETCH_DEBOUNCE_MS = 1000;
const POLL_MS = 20_000;

let link = null;
let poll = null;
let timer = null;

export function destroyWorkers() {
  link?.close();
  link = null;
  clearInterval(poll);
  poll = null;
  clearTimeout(timer);
  timer = null;
}

export async function renderWorkers(el) {
  destroyWorkers();
  let names = {};

  el.innerHTML = `
    <div class="curio-inbox">
      <div class="curio-inbox-head">
        <div>
          <div class="page-title">Workers</div>
          <div class="text-dim text-sm">Tasks your agents handed to workers: what each is doing now, and how recent runs ended. Open one for its steps, Stop or Retry.</div>
        </div>
        <button class="btn btn-sm" id="workers-refresh">Refresh</button>
      </div>
      <div id="workers-list">${skeleton({ block: true, height: 180 })}</div>
    </div>`;

  const load = async () => {
    const res = await api('/api/workers').catch((err) => ({ error: err?.message }));
    if (!el.isConnected) return;
    const box = el.querySelector('#workers-list');
    if (!box) return;
    if (!res || res.error) {
      box.innerHTML = emptyState({
        icon: '∅',
        title: 'Could not load workers',
        hint: res?.error || 'The server did not answer.',
      });
      return;
    }
    box.innerHTML = workersList(res.runs, { names, enabled: res.enabled !== false });
  };

  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(load, REFETCH_DEBOUNCE_MS);
  };

  el.querySelector('#workers-refresh').addEventListener('click', () => load());

  const bots = await api('/api/agents').catch(() => null);
  if (Array.isArray(bots)) names = Object.fromEntries(bots.map((b) => [b.id, b.name ?? b.id]));
  await load();
  if (!el.isConnected) return;
  poll = setInterval(load, POLL_MS);
  try {
    link = openReconnectingSocket({
      url: () => dashboardSocketUrl(location, '/ws/activity', { token: getAuthToken() }),
      onMessage: (e) => {
        try {
          const d = JSON.parse(e.data);
          if (d.type === 'activity' && isWorkerEvent(d.event)) schedule();
        } catch {
          /* ignore */
        }
      },
    });
  } catch {
    /* the poll still runs */
  }
}
