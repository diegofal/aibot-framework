// Pure helpers for the Stats & Behaviour pages. No DOM access — unit-tested in tests/web.

export const STATS_WINDOWS = ['24h', '7d', '30d'];
export const DEFAULT_WINDOW = '7d';
export const SEVERITY_ORDER = ['critical', 'warn', 'info'];

const STALE_CONTACT_MS = 7 * 86400_000;

function isNum(n) {
  return typeof n === 'number' && Number.isFinite(n);
}

function trimZero(s) {
  return s.replace(/\.0$/, '');
}

export function formatNumber(n) {
  if (!isNum(n)) return '--';
  return Math.round(n).toLocaleString('en-US');
}

export function formatTokens(n) {
  if (!isNum(n)) return '--';
  if (n >= 1_000_000) return `${trimZero((n / 1_000_000).toFixed(1))}M`;
  if (n >= 1_000) return `${trimZero((n / 1_000).toFixed(1))}k`;
  return String(Math.round(n));
}

export function formatPct(ratio) {
  if (!isNum(ratio)) return '--';
  return `${Math.round(ratio * 100)}%`;
}

export function formatDuration(ms) {
  if (!isNum(ms)) return '--';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.floor((ms % 60_000) / 1000)}s`;
}

export function formatBytes(bytes) {
  if (!isNum(bytes)) return '--';
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

export function normalizeWindow(value) {
  return STATS_WINDOWS.includes(value) ? value : DEFAULT_WINDOW;
}

export function windowQuery(value) {
  return `?window=${normalizeWindow(value)}`;
}

export function relativeTime(iso, now = Date.now()) {
  if (iso == null) return 'never';
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return 'never';
  const diff = t - now;
  const abs = Math.abs(diff);
  if (abs < 60_000) return diff > 0 ? 'in <1m' : 'just now';
  let unit;
  if (abs < 3600_000) unit = `${Math.floor(abs / 60_000)}m`;
  else if (abs < 86400_000) unit = `${Math.floor(abs / 3600_000)}h`;
  else unit = `${Math.floor(abs / 86400_000)}d`;
  return diff > 0 ? `in ${unit}` : `${unit} ago`;
}

export function isStaleContact(iso, now = Date.now()) {
  if (iso == null) return true;
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return true;
  return now - t > STALE_CONTACT_MS;
}

const POSTURE_CLASS = {
  active: 'badge-ok',
  standby: 'stats-badge-amber',
  idle: 'stats-badge-amber',
  dormant: 'badge-disabled',
  blocked: 'badge-error',
  unknown: 'badge-disabled',
};

export function postureClass(posture) {
  return POSTURE_CLASS[posture] || 'badge-disabled';
}

const CHANNEL_CLASS = {
  ok: 'badge-ok',
  revoked: 'badge-error',
  missing: 'badge-error',
  error: 'badge-error',
  placeholder: 'stats-badge-amber',
  configured: 'badge-disabled',
  unknown: 'badge-disabled',
};

export function channelStateClass(state) {
  return CHANNEL_CLASS[state] || 'badge-disabled';
}

export function failRateClass(rate) {
  if (!isNum(rate) || rate < 0.1) return 'ok';
  if (rate < 0.3) return 'warn';
  return 'bad';
}

export function barHeights(values, max) {
  const nums = (values || []).map((v) => (isNum(v) ? v : 0));
  const top = isNum(max) && max > 0 ? max : Math.max(0, ...nums);
  if (top <= 0) return nums.map(() => 0);
  return nums.map((v) => {
    if (v <= 0) return 0;
    return Math.max(2, Math.round((v / top) * 100));
  });
}

export function sparklinePoints(values, width, height) {
  const nums = (values || []).map((v) => (isNum(v) ? v : 0));
  if (nums.length < 2) return '';
  const min = Math.min(...nums);
  const max = Math.max(...nums);
  const span = max - min;
  const stepX = width / (nums.length - 1);
  return nums
    .map((v, i) => {
      const y = span === 0 ? height / 2 : height - ((v - min) / span) * height;
      return `${round2(i * stepX)},${round2(y)}`;
    })
    .join(' ');
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

export function driftVectorData(vector) {
  if (!vector || typeof vector !== 'object') return [];
  const entries = Object.entries(vector)
    .map(([trait, value]) => ({ trait, value: isNum(value) ? value : 0 }))
    .sort((a, b) => Math.abs(b.value) - Math.abs(a.value));
  const top = entries.length ? Math.abs(entries[0].value) : 0;
  return entries.map((e) => ({
    trait: e.trait,
    value: e.value,
    pct: top > 0 ? Math.round((Math.abs(e.value) / top) * 100) : 0,
    sign: e.value > 0 ? 'pos' : e.value < 0 ? 'neg' : 'zero',
  }));
}

export function traitDeltas(current, baseline) {
  const cur = current && typeof current === 'object' ? current : {};
  const base = baseline && typeof baseline === 'object' ? baseline : {};
  const traits = [...new Set([...Object.keys(cur), ...Object.keys(base)])];
  return traits.map((trait) => {
    const c = isNum(cur[trait]) ? cur[trait] : null;
    const b = isNum(base[trait]) ? base[trait] : null;
    const delta = c != null && b != null ? Math.round((c - b) * 1000) / 1000 : null;
    return { trait, current: c, baseline: b, delta };
  });
}

export function severityRank(severity) {
  const idx = SEVERITY_ORDER.indexOf(severity);
  return idx === -1 ? SEVERITY_ORDER.length : idx;
}

export function sortFindings(findings) {
  return [...(findings || [])].sort((a, b) => {
    const s = severityRank(a.severity) - severityRank(b.severity);
    if (s !== 0) return s;
    const k = String(a.kind || '').localeCompare(String(b.kind || ''));
    if (k !== 0) return k;
    const f = String(a.file || '').localeCompare(String(b.file || ''));
    if (f !== 0) return f;
    return (a.line || 0) - (b.line || 0);
  });
}

export function groupFindings(findings) {
  const groups = [];
  for (const f of sortFindings(findings)) {
    let g = groups.find((x) => x.severity === f.severity);
    if (!g) {
      g = { severity: f.severity, count: 0, kinds: [] };
      groups.push(g);
    }
    let k = g.kinds.find((x) => x.kind === f.kind);
    if (!k) {
      k = { kind: f.kind, findings: [] };
      g.kinds.push(k);
    }
    k.findings.push(f);
    g.count++;
  }
  return groups;
}

/**
 * Comparator factory for client-side table sorting.
 * Numbers sort descending by default (biggest first is what a dashboard wants);
 * strings ascending. dir = -1 flips. Nullish values always sort last.
 */
export function compareBy(getter, dir = 1) {
  return (a, b) => {
    const va = getter(a);
    const vb = getter(b);
    const na = va == null || va === '';
    const nb = vb == null || vb === '';
    if (na && nb) return 0;
    if (na) return 1;
    if (nb) return -1;
    if (typeof va === 'number' && typeof vb === 'number') return (vb - va) * dir;
    return String(va).localeCompare(String(vb), undefined, { numeric: true }) * dir;
  };
}

/**
 * Opt-in options a routine accepts. Anything destructive stays behind an
 * explicit checkbox — the backend defaults them off and skips the finding as
 * "report only" when absent.
 */
export const ROUTINE_OPTIONS = {
  'productions-triage': [
    { key: 'archiveStale', label: 'Archive stale unreviewed files' },
    { key: 'pruneOrphans', label: 'Prune orphan changelog entries' },
  ],
  'memory-hygiene': [{ key: 'redactCustody', label: 'Also redact family/custody lines' }],
};

export function routineOptions(routineId) {
  return ROUTINE_OPTIONS[routineId] || [];
}

/**
 * Build the options payload from the keys the operator ticked. `redactCustody`
 * is sugar: the backend takes a `redactKinds` list, and custody is the only
 * kind we let the UI add to the safe default set.
 */
export function optionsFromChecked(routineId, checkedKeys) {
  const allowed = new Set(routineOptions(routineId).map((o) => o.key));
  const checked = (checkedKeys || []).filter((k) => allowed.has(k));
  if (checked.length === 0) return undefined;
  const out = {};
  for (const key of checked) {
    if (key === 'redactCustody') out.redactKinds = ['email', 'phone', 'chat-id', 'custody'];
    else out[key] = true;
  }
  return out;
}

export function answerRate(answered, sent) {
  if (!isNum(sent) || sent <= 0) return null;
  return (isNum(answered) ? answered : 0) / sent;
}

/** DOM-free HTML escape — mirrors shared.js's div-based one without needing `document`. */
function escapeHtmlPure(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function goalFlag(count, label) {
  if (!count) return '';
  return `<span class="stats-flag" title="${escapeHtmlPure(label)}">${formatNumber(count)} ${escapeHtmlPure(label)}</span>`;
}

const GOAL_STATUS_ORDER = ['active', 'in_progress', 'blocked', 'pending', 'completed', 'archived'];

const GOAL_STATUS_CLASS = {
  completed: 'badge-ok',
  blocked: 'badge-error',
  archived: 'badge-disabled',
};

/**
 * Goals board HTML for a bot's stats page. Reads `GoalDetail` as the backend
 * actually sends it (`text`, not `title`; `notes` as real text, not a length) —
 * this drifted once already when the two sides were built in parallel, so the
 * field names here are pinned by tests/web/stats-helpers-goals.test.ts against
 * the exact contract in src/stats/types.ts.
 */
export function goalsBoard(goalsDetail, goals) {
  const list = Array.isArray(goalsDetail) ? goalsDetail : [];
  const flags = [
    goalFlag(goals?.archivedInActive, 'archived in active'),
    goalFlag(goals?.duplicates, 'duplicates'),
    goalFlag(goals?.oversizedNotes, 'oversized notes'),
  ].join('');
  if (list.length === 0) return `<p class="text-dim text-sm">No goals.</p>${flags}`;

  const groups = new Map();
  for (const g of list) {
    const s = g.status || 'unknown';
    if (!groups.has(s)) groups.set(s, []);
    groups.get(s).push(g);
  }
  const order = [...groups.keys()].sort(
    (a, b) =>
      (GOAL_STATUS_ORDER.indexOf(a) === -1 ? 99 : GOAL_STATUS_ORDER.indexOf(a)) -
      (GOAL_STATUS_ORDER.indexOf(b) === -1 ? 99 : GOAL_STATUS_ORDER.indexOf(b))
  );
  const statusCls = (s) => GOAL_STATUS_CLASS[s] || 'badge-mcp';

  const card = (g) => `<div class="stats-goal">
          <div class="stats-goal-title">${escapeHtmlPure(g.text || '(untitled)')}${
            g.priority
              ? ` <span class="stats-chip">${escapeHtmlPure(String(g.priority))}</span>`
              : ''
          }${g.completed ? ` <span class="text-dim text-sm">${escapeHtmlPure(relativeTime(g.completed))}</span>` : ''}</div>
          ${g.notes ? `<div class="stats-goal-notes text-dim">${escapeHtmlPure(String(g.notes).slice(0, 240))}${String(g.notes).length > 240 ? '…' : ''}</div>` : ''}
          ${g.outcome ? `<div class="stats-goal-notes"><span class="text-dim">outcome:</span> ${escapeHtmlPure(String(g.outcome).slice(0, 240))}</div>` : ''}
        </div>`;

  const group = (s) => `<div class="stats-goal-group">
      <div class="stats-goal-group-title"><span class="badge ${statusCls(s)}">${escapeHtmlPure(s)}</span> <span class="count">${groups.get(s).length}</span></div>
      ${groups
        .get(s)
        .map(card)
        .join('')}
    </div>`;

  return `${flags ? `<div class="stats-flags">${flags}</div>` : ''}
  <div class="stats-goal-groups">${order.map(group).join('')}</div>`;
}
