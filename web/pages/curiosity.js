/**
 * Curiosity DNA — DOM side (step C7 of docs/plans/curiosity-navigator-plan.md).
 *
 * `wireCuriositySignals` handles every 👍 / 👎 / "more like this" button the
 * helpers render (event delegation on `data-curio-kind`), and `mountMind`
 * loads `/api/curiosity/:id` into the Agent Home "Mind" slot. Markup lives in
 * curiosity-helpers.js.
 */
import { emptyState, showToast, skeleton } from '../ui/index.js';
import { mindSection, signalRequest } from './curiosity-helpers.js';
import { api } from './shared.js';

const TOAST = {
  dispatch: { up: 'Noted — more of this', down: 'Noted — less of this', more: 'More like this' },
  frontier: { up: 'Approved for exploration', down: 'Dropped from the frontier' },
  direction: { up: 'Direction confirmed', down: 'Flagged for a rethink' },
};

/**
 * Click → POST the signal → mark the pressed button. Idempotent per root
 * (a second call is a no-op). `onSignal(kind, result)` runs after success.
 */
export function wireCuriositySignals(root, { onSignal } = {}) {
  if (!root || root._curioWired) return;
  root._curioWired = true;
  root.addEventListener('click', async (e) => {
    const btn = e.target.closest?.('button.curio-signal');
    if (!btn || !root.contains(btn)) return;
    const { curioKind: kind, bot, id, signal } = btn.dataset;
    const req = signalRequest(kind, bot, id, signal);
    if (!req) return;
    const group = btn.closest('.curio-signals');
    const buttons = group ? [...group.querySelectorAll('button.curio-signal')] : [btn];
    for (const b of buttons) b.disabled = true;
    const res = await api(req.path, { method: 'POST', body: req.body });
    for (const b of buttons) b.disabled = false;
    if (!res || res.error) {
      showToast(res?.error || 'Could not record the signal', { tone: 'danger' });
      return;
    }
    for (const b of buttons) {
      const on = b === btn;
      b.classList.toggle('active', on);
      b.setAttribute('aria-pressed', String(on));
    }
    showToast(TOAST[kind]?.[signal] ?? 'Saved', { tone: 'ok' });
    onSignal?.(kind, res);
  });
}

/** Render the Mind section for one agent into `slot`. Never throws. */
export async function mountMind(slot, botId) {
  if (!slot) return;
  slot.innerHTML = skeleton({ block: true, height: 160 });
  const snap = await api(`/api/curiosity/${encodeURIComponent(botId)}`).catch(() => null);
  if (!slot.isConnected) return;
  if (!snap || snap.error) {
    slot.innerHTML = emptyState({
      icon: '◎',
      title: 'Mind unavailable',
      hint: snap?.error || 'The curiosity state could not be loaded.',
    });
    return;
  }
  slot.innerHTML = mindSection(snap);
  wireCuriositySignals(slot);
}
