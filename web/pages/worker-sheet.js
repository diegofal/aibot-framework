/**
 * The worker sheet (C20): one task-worker run — journal per step, budget used,
 * the dispatching cycle (Open cycle), its Why (shared panel), Stop and Retry. Opened from any
 * `[data-open-worker]` (one delegated listener, wired in app.js). While the
 * run is active the sheet refetches every few seconds; markup lives in
 * workers-helpers.js.
 */
import { confirmInline, openSheet, showToast } from '../ui/index.js';
import { api } from './shared.js';
import { workerActionPath, workerDetailUrl, workerSheetBody } from './workers-helpers.js';

const SHEET_POLL_MS = 5000;
const ACTIVE = new Set(['queued', 'running', 'waiting', 'interrupted']);

let pollTimer = null;

function message(text) {
  return `<div class="text-dim wk-empty">${text}</div>`;
}

export async function openWorkerSheet(runId) {
  clearTimeout(pollTimer);
  const body = openSheet({ title: 'Worker', body: message('Loading worker…'), wide: true });
  if (!body) return;

  const load = async () => {
    clearTimeout(pollTimer);
    const detail = await api(workerDetailUrl(runId)).catch((err) => ({
      error: err?.message || 'Request failed',
    }));
    if (!body.isConnected) return;
    if (!detail || detail.error) {
      body.innerHTML = message(`Could not load this worker: ${detail?.error || 'no response'}`);
      return;
    }
    // The sheet repaints while the run is active: keep an open Why fold open.
    const whyOpen = !!body.querySelector('details.why')?.open;
    body.innerHTML = workerSheetBody(detail);
    const why = body.querySelector('details.why');
    if (why && whyOpen) why.open = true;
    if (ACTIVE.has(detail.run?.status)) pollTimer = setTimeout(load, SHEET_POLL_MS);
  };

  body.addEventListener('click', async (e) => {
    const el = e.target instanceof Element ? e.target : null;
    const stop = el?.closest('[data-worker-stop]');
    const retry = el?.closest('[data-worker-retry]');
    if (stop) {
      if (!confirmInline(stop, { label: 'Click again to stop' })) return;
      stop.disabled = true;
      const res = await api(workerActionPath(runId, 'stop'), { method: 'POST' });
      if (res?.stopped) showToast('Worker stopped', { tone: 'ok' });
      else
        showToast(`Could not stop: ${res?.error || 'the run is not active'}`, { tone: 'danger' });
      load();
    } else if (retry) {
      retry.disabled = true;
      const res = await api(workerActionPath(runId, 'retry'), { method: 'POST' });
      if (res?.ok && res.runId) {
        showToast('Retry queued', { tone: 'ok' });
        openWorkerSheet(res.runId);
        return;
      }
      showToast(`Could not retry: ${res?.message || res?.error || 'refused'}`, { tone: 'danger' });
      load();
    }
  });

  await load();
}

/** One delegated listener: any `[data-open-worker]` opens its run. */
export function wireOpenWorker(root = document) {
  root.addEventListener('click', (e) => {
    const el = e.target instanceof Element ? e.target.closest('[data-open-worker]') : null;
    if (!el) return;
    e.preventDefault();
    e.stopPropagation();
    openWorkerSheet(el.getAttribute('data-open-worker') ?? '');
  });
}
