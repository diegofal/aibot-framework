/**
 * The "Tell an agent what to do and when" box (session S8 of
 * docs/plans/jarvis-fleet-plan.md), mounted at the top of Automations -> Cron.
 *
 * Parse -> POST /api/cron/parse -> preview card (schedule in words, next run,
 * instruction, target, confidence, warnings, editable cron) -> Create -> the
 * existing POST /api/cron. Pure markup and request building live in
 * automations-helpers.js; this file only wires the DOM.
 */
import { showToast } from '../ui/index.js';
import {
  automationBox,
  buildCreateRequest,
  buildParseRequest,
  cronToHuman,
  isCronExpr,
  pickDefaultAgent,
  previewCard,
} from './automations-helpers.js';
import { api } from './shared.js';

/**
 * Render the box into `container`. `agents` is the /api/agents list;
 * `onCreated(job)` runs after a job is created (the cron page reloads).
 * Returns `{ parse(text, botId), destroy() }` for tests and callers.
 */
export function mountAutomationBox(container, { agents = [], onCreated, selectedId } = {}) {
  if (!container) return { parse: async () => null, destroy() {} };
  let proposal = null;
  container.innerHTML = automationBox({
    agents,
    selectedId: selectedId ?? pickDefaultAgent(agents),
    text: '',
  });
  const form = container.querySelector('[data-automation]');
  const preview = container.querySelector('[data-automation-preview]');
  const textInput = form.querySelector('input[name="text"]');
  const botSelect = form.querySelector('select[name="botId"]');
  const parseBtn = form.querySelector('button[type="submit"]');

  function setBusy(busy) {
    parseBtn.disabled = busy || !botSelect;
    parseBtn.textContent = busy ? 'Parsing…' : 'Parse';
    textInput.disabled = busy;
    if (botSelect) botSelect.disabled = busy;
  }

  function currentEdits() {
    const card = preview.querySelector('[data-automation-card]');
    if (!card) return {};
    return {
      expr: card.querySelector('input[name="expr"]')?.value,
      name: card.querySelector('input[name="name"]')?.value,
      instruction: card.querySelector('textarea[name="instruction"]')?.value,
      chatId: card.querySelector('input[name="chatId"]')?.value,
    };
  }

  function paintPreview() {
    preview.innerHTML = proposal ? previewCard(proposal, { agents, nowMs: Date.now() }) : '';
    if (!proposal) return;
    const card = preview.querySelector('[data-automation-card]');
    const exprInput = card.querySelector('input[name="expr"]');
    const human = card.querySelector('[data-cron-human]');
    exprInput.addEventListener('input', () => {
      const expr = exprInput.value.trim();
      human.textContent = cronToHuman(expr, proposal.tz);
      human.classList.toggle('auto-card-invalid', !isCronExpr(expr));
      card.querySelector('[data-cron-next]')?.remove();
    });
    card.querySelector('[data-automation-discard]').addEventListener('click', () => {
      proposal = null;
      paintPreview();
      textInput.focus();
    });
    card.querySelector('[data-automation-create]').addEventListener('click', create);
  }

  async function parse(text, botId) {
    const req = buildParseRequest(text, botId);
    if (req.error) {
      showToast(req.error, { tone: 'warn' });
      return null;
    }
    setBusy(true);
    try {
      const res = await api(req.path, { method: req.method, body: req.body });
      if (!res || res.error) {
        showToast(res?.error || 'Could not parse that', { tone: 'danger' });
        return null;
      }
      proposal = res;
      paintPreview();
      if (res.confidence === 'low') {
        showToast('Low confidence — check the cron field before creating', { tone: 'warn' });
      }
      return res;
    } finally {
      setBusy(false);
    }
  }

  async function create() {
    if (!proposal) return;
    const req = buildCreateRequest(proposal, currentEdits());
    if (req.error) {
      showToast(req.error, { tone: 'warn' });
      return;
    }
    const btn = preview.querySelector('[data-automation-create]');
    if (btn) btn.disabled = true;
    const job = await api(req.path, { method: req.method, body: req.body });
    if (!job || job.error) {
      if (btn) btn.disabled = false;
      showToast(job?.error || 'Could not create the job', { tone: 'danger' });
      return;
    }
    showToast(`Job created: ${req.body.name}`, { tone: 'ok' });
    proposal = null;
    textInput.value = '';
    paintPreview();
    onCreated?.(job);
  }

  const onSubmit = (e) => {
    e.preventDefault();
    parse(textInput.value, botSelect?.value ?? '');
  };
  form.addEventListener('submit', onSubmit);

  return {
    parse,
    destroy() {
      form.removeEventListener('submit', onSubmit);
      proposal = null;
    },
  };
}
