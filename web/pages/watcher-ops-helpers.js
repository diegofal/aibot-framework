/**
 * Watcher page, operations half (plan `docs/plans/watcher-optimizations-plan.md`,
 * O5–O7). Pure: no DOM, no fetch.
 *
 *  - "What it saw": a pass row of the log (a model call: `source`
 *    `watcher:notice|integrate|introspect|consolidate` and a `durationMs`) matched to its
 *    pass record (`GET /api/watcher/passes`) by caller, exact duration and
 *    end time — the record is written just before the row — and the fold
 *    that shows the record's prompt and response.
 *  - The embeddings status of the header (`GET /api/stats/infra`, ollama row).
 *  - The sentence for a "Clean the graph" run (`/api/hygiene/run`, routine
 *    `watcher-graph`).
 */
import { esc } from '../ui/index.js';

export const PASS_SOURCES = [
  'watcher:notice',
  'watcher:integrate',
  'watcher:introspect',
  'watcher:consolidate',
];
/** A record ends at most this long before its row is written (the rest of the pass runs between). */
const MATCH_WINDOW_MS = 10 * 60_000;
/** Clock slack: a record never ends after its row, give or take this. */
const MATCH_SLACK_MS = 1000;

export function isPassRow(row) {
  return (
    !!row &&
    PASS_SOURCES.includes(row.source) &&
    row.durationMs != null &&
    Number.isFinite(Number(row.durationMs))
  );
}

/** The pass record behind a pass row, or null. */
export function matchPassRecord(row, passes) {
  if (!isPassRow(row) || !Array.isArray(passes)) return null;
  const at = Date.parse(row.ts ?? '');
  if (!Number.isFinite(at)) return null;
  let best = null;
  let bestGap = Number.POSITIVE_INFINITY;
  for (const p of passes) {
    if (p?.caller !== row.source || Number(p.durationMs) !== Number(row.durationMs)) continue;
    const ended = Date.parse(p.endedAt ?? '');
    if (!Number.isFinite(ended)) continue;
    const gap = at - ended;
    if (gap < -MATCH_SLACK_MS || gap > MATCH_WINDOW_MS) continue;
    if (Math.abs(gap) < bestGap) {
      best = p;
      bestGap = Math.abs(gap);
    }
  }
  return best;
}

/** The fold under a pass row; `bodyHtml` non-null → open with it inside. */
export function passFoldHtml(row, bodyHtml) {
  const open = bodyHtml != null;
  return `<details class="watcher-pass"${open ? ' open' : ''}><summary data-action="watcher-pass" data-seq="${esc(
    row?.seq
  )}">What it saw</summary>${open ? `<div class="watcher-pass-body">${bodyHtml}</div>` : ''}</details>`;
}

const pre = (text) => `<pre class="watcher-pass-pre">${esc(text ?? '')}</pre>`;

/** The inside of an open fold: system, prompt, response (or the error). */
/**
 * What the log list renders, live or in a replay: the rows and the
 * `logListHtml` options. Both honour the open "What it saw" fold; only live
 * applies the neuron filter and the selected row (a replay shows every row).
 */
export function logView(page) {
  const openPass = page.openPass ?? null;
  if (page.replay) return { rows: page.replay.shown, options: { openPass } };
  return {
    rows: page.model.log,
    options: { filterId: page.filterId ?? null, selectedSeq: page.selectedSeq ?? null, openPass },
  };
}

export function passRecordBodyHtml(record) {
  if (!record) {
    return '<div class="text-dim">No record of this pass (kept 14 days; older passes and passes from before records existed have none).</div>';
  }
  const parts = [];
  if (record.prompt?.system) {
    parts.push(`<div class="watcher-pass-label">Instructions</div>${pre(record.prompt.system)}`);
  }
  parts.push(`<div class="watcher-pass-label">What it saw</div>${pre(record.prompt?.user ?? '')}`);
  if (record.ok === false) {
    parts.push(
      `<div class="watcher-pass-label">The call failed</div><div class="watcher-note is-error">${esc(
        record.error ?? 'unknown error'
      )}</div>`
    );
  } else {
    parts.push(`<div class="watcher-pass-label">What it said</div>${pre(record.response ?? '')}`);
  }
  return parts.join('');
}

function since(iso, nowMs) {
  const t = Date.parse(iso ?? '');
  if (!Number.isFinite(t)) return '';
  const diff = Math.max(0, nowMs - t);
  if (diff < 60_000) return 'just now';
  const m = Math.round(diff / 60_000);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(diff / 3_600_000);
  if (h < 48) return `${h} h ago`;
  return `${Math.round(diff / 86_400_000)} d ago`;
}

/** "embeddings: ok" / "embeddings: down since 3 h ago" for the header; '' when unknown. */
export function embeddingStatusHtml(embedding, nowMs = Date.now()) {
  if (!embedding || typeof embedding !== 'object') return '';
  if (!embedding.model) {
    return '<span class="watcher-embed-status is-warn" title="soul.search.embeddingModel is empty">embeddings: not configured</span>';
  }
  if (embedding.ok) {
    const ms = Number(embedding.latencyMs);
    return `<span class="watcher-embed-status is-ok" title="${esc(embedding.model)}">embeddings: ok${
      Number.isFinite(ms) ? ` · ${Math.round(ms)} ms` : ''
    }</span>`;
  }
  const when = since(embedding.downSince, nowMs);
  return `<span class="watcher-embed-status is-error" title="${esc(
    `${embedding.model}: ${embedding.error ?? 'down'}`
  )}">embeddings: down${when ? ` since ${esc(when)}` : ''}${
    embedding.error ? ` · ${esc(String(embedding.error).slice(0, 80))}` : ''
  }</span>`;
}

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** One sentence for a `watcher-graph` hygiene run (preview or apply). */
export function graphCleanSummary(run) {
  if (!run || run.error) return `The cleanup failed: ${run?.error ?? 'no answer'}`;
  const findings = Array.isArray(run.findings) ? run.findings : [];
  if (findings.some((f) => f.kind === 'watcher-unavailable')) {
    return 'The watcher is not enabled in this process: there is no graph to clean.';
  }
  if (run.dryRun) {
    const headers = findings.filter((f) => f.kind === 'date-header-fact').length;
    const bookkeeping = findings.filter((f) => f.kind === 'bookkeeping-fact').length;
    const groups = findings.filter((f) => f.kind === 'duplicate-facts');
    const dups = groups.reduce(
      (n, f) => n + (Array.isArray(f.data?.dropIds) ? f.data.dropIds.length : 0),
      0
    );
    const bits = [];
    if (headers + bookkeeping) {
      const what = [
        headers ? plural(headers, 'date header') : '',
        bookkeeping ? plural(bookkeeping, 'bookkeeping line') : '',
      ].filter(Boolean);
      bits.push(`archive ${plural(headers + bookkeeping, 'fact')} (${what.join(', ')})`);
    }
    if (groups.length) {
      bits.push(`merge ${plural(dups, 'near-duplicate')} in ${plural(groups.length, 'group')}`);
    }
    return bits.length ? `Would ${bits.join(' and ')}.` : 'Nothing to clean.';
  }
  const applied = Array.isArray(run.applied) ? run.applied : [];
  const archived = applied.filter((a) => a.action === 'archive').length;
  const merged = applied.filter((a) => a.action === 'merge').length;
  const skipped = Array.isArray(run.skipped) ? run.skipped.length : 0;
  const done = [
    archived ? `Archived ${plural(archived, 'fact')}` : '',
    merged ? `merged ${plural(merged, 'group')}` : '',
  ].filter(Boolean);
  const head = done.length
    ? `${done.join(', ').replace(/^./, (c) => c.toUpperCase())}.`
    : 'Nothing changed.';
  return skipped ? `${head} ${skipped} skipped (changed since the preview).` : head;
}
