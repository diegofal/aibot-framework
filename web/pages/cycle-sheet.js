/**
 * The "Open cycle" sheet: one agent-loop cycle, opened from any Why
 * (`[data-open-cycle]` + `data-bot-id`, wired once in app.js). Markup in
 * `cycle-sheet-helpers.js`.
 */
import { openSheet } from '../ui/index.js';
import { cycleDetailUrl, cycleSheetBody, cycleSheetMessage } from './cycle-sheet-helpers.js';
import { api } from './shared.js';

export async function openCycleSheet(botId, cycleId) {
  const body = openSheet({ title: 'Cycle', body: cycleSheetMessage('Loading cycle…'), wide: true });
  if (!body) return;
  const detail = await api(cycleDetailUrl(botId, cycleId)).catch((err) => ({
    error: err?.message || 'Request failed',
  }));
  if (!body.isConnected) return;
  body.innerHTML =
    !detail || detail.error
      ? cycleSheetMessage(`Could not load this cycle: ${detail?.error || 'no response'}`)
      : cycleSheetBody(detail);
}

/** One delegated listener: any `[data-open-cycle]` opens its cycle. */
export function wireOpenCycle(root = document) {
  root.addEventListener('click', (e) => {
    const el = e.target instanceof Element ? e.target.closest('[data-open-cycle]') : null;
    if (!el) return;
    e.preventDefault();
    e.stopPropagation();
    openCycleSheet(el.getAttribute('data-bot-id') ?? '', el.getAttribute('data-open-cycle') ?? '');
  });
}
