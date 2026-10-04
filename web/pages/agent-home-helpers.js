/**
 * Presence header for an agent — the first visible sign of life.
 *
 * Pure helpers (string in, string out) live here so `tests/web/` can cover
 * them; the only DOM-touching function is `applyPresence`, which updates an
 * already-rendered header in place when a live event arrives.
 */
import { avatar, badge, emptyState, esc, kpi, radar, sparkline, tabs } from '../ui/index.js';
import { faceControl, speakButton } from './agent-face-helpers.js';

export const POSTURE_TONE = {
  active: 'ok',
  standby: 'warn',
  idle: 'warn',
  blocked: 'danger',
  dormant: 'muted',
  unknown: 'muted',
};

export function postureTone(posture) {
  return POSTURE_TONE[posture] ?? 'muted';
}

/** "next run in 5m" / "next run now" / '' when unknown. */
export function formatNext(nextRunAt, nowMs = Date.now()) {
  const ts =
    nextRunAt == null ? null : typeof nextRunAt === 'number' ? nextRunAt : Date.parse(nextRunAt);
  if (ts == null || !Number.isFinite(ts)) return '';
  const diff = ts - nowMs;
  if (diff <= 30_000) return 'next run now';
  const m = Math.round(diff / 60_000);
  if (m < 60) return `next run in ${m}m`;
  const h = Math.round(diff / 3_600_000);
  if (h < 48) return `next run in ${h}h`;
  return `next run in ${Math.round(diff / 86_400_000)}d`;
}

/** Secondary line under the now-line: backend, channel, next run. */
export function presenceMeta(identity = {}, presence = {}, nowMs = Date.now()) {
  const parts = [];
  if (identity.backend)
    parts.push(identity.model ? `${identity.backend} · ${identity.model}` : identity.backend);
  if (identity.channel?.kind) {
    const state = identity.channel.state ? ` ${identity.channel.state}` : '';
    parts.push(`${identity.channel.kind}${state}`);
  }
  if (presence.isExecuting) parts.push('cycle running');
  else {
    const next = formatNext(presence.nextRunAt, nowMs);
    if (next) parts.push(next);
  }
  return parts.join(' · ');
}

/**
 * Header markup. `home` is the `/api/agents/:id/home` payload (or at least
 * `{ identity, presence }`); `actions` is trusted HTML for the button row.
 * Session S4: `avatarSrc` decorates `identity.avatarUrl` (the page adds the
 * auth token), `face` adds the "Change face" control inside the avatar and
 * `voice` adds the play button next to the now-line.
 */
export function presenceHeader(
  home,
  {
    actions = '',
    nowMs = Date.now(),
    backHref = '#/agents',
    avatarSrc = (u) => u,
    face = false,
    voice = false,
  } = {}
) {
  const identity = home?.identity ?? {};
  const presence = home?.presence ?? {};
  const tone = postureTone(presence.posture);
  const name = identity.name ?? identity.id ?? 'Agent';
  const meta = presenceMeta(identity, presence, nowMs);
  const src = identity.avatarUrl ? avatarSrc(identity.avatarUrl) : undefined;
  return `<header class="presence-header" data-bot-id="${esc(identity.id ?? '')}">
    <a href="${esc(backHref)}" class="back presence-back" aria-label="Back">&larr;</a>
    <div class="presence-avatar" id="presence-avatar">${avatar({
      seed: identity.avatarSeed ?? identity.id,
      name,
      src,
      size: 56,
      status: tone,
    })}${face ? faceControl(identity.id ?? '', { hasAvatar: Boolean(identity.avatarUrl) }) : ''}</div>
    <div class="presence-body">
      <div class="presence-title">
        <span class="presence-name">${esc(name)}</span>
        <span id="presence-badge">${badge(presence.posture ?? 'unknown', tone, { dot: true })}</span>
        ${identity.running ? '' : badge('stopped', 'muted')}
      </div>
      <div class="presence-now-row"><div class="presence-now presence-now-${esc(
        presence.tone ?? tone
      )}" id="presence-now">${esc(presence.nowLine ?? '…')}</div>${voice ? speakButton() : ''}</div>
      <div class="presence-meta text-dim" id="presence-meta">${esc(meta)}</div>
    </div>
    <div class="presence-actions">${actions}</div>
  </header>`;
}

/** True when an activity event concerns this bot's presence. */
export function isPresenceEvent(event, botId) {
  if (!event || event.botId !== botId || typeof event.type !== 'string') return false;
  return (
    event.type.startsWith('agent:') || event.type.startsWith('tool:') || event.type === 'llm:start'
  );
}

/** Update a rendered header in place from a `/presence` payload. No-op without a DOM. */
export function applyPresence(root, presence, identity = {}, nowMs = Date.now()) {
  if (!root || typeof root.querySelector !== 'function' || !presence) return false;
  const tone = postureTone(presence.posture);
  const now = root.querySelector('#presence-now');
  if (now) {
    now.textContent = presence.nowLine ?? '…';
    now.className = `presence-now presence-now-${presence.tone ?? tone}`;
  }
  const b = root.querySelector('#presence-badge');
  if (b) b.innerHTML = badge(presence.posture ?? 'unknown', tone, { dot: true });
  const dot = root.querySelector('.ui-avatar-dot');
  if (dot) dot.className = `ui-avatar-dot ui-avatar-dot-${tone}`;
  const meta = root.querySelector('#presence-meta');
  if (meta) meta.textContent = presenceMeta(identity, presence, nowMs);
  return true;
}

// ── Agent Home page pieces (session S2) ─────────────────────────────────────

export const TIMELINE_KIND_TONE = {
  llm: 'accent',
  tool: 'info',
  production: 'ok',
  ask: 'warn',
  cycle: 'muted',
  karma: 'accent',
};

export const TIMELINE_KIND_LABEL = {
  llm: 'LLM',
  tool: 'tool',
  production: 'output',
  ask: 'ask',
  cycle: 'cycle',
  karma: 'karma',
};

/** Hour bucket label for a timeline item: "Today 14:00", "Yesterday 09:00", "Mon 12 · 08:00". */
export function hourLabel(iso, nowMs = Date.now()) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return 'Unknown time';
  const d = new Date(t);
  const now = new Date(nowMs);
  const hh = `${String(d.getHours()).padStart(2, '0')}:00`;
  const sameDay = (a, b) =>
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate();
  if (sameDay(d, now)) return `Today ${hh}`;
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (sameDay(d, yesterday)) return `Yesterday ${hh}`;
  const day = d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric' });
  return `${day} · ${hh}`;
}

/** Group newest-first timeline items into hour buckets, preserving order. */
export function groupTimelineByHour(items, nowMs = Date.now()) {
  const groups = [];
  let cur = null;
  for (const it of Array.isArray(items) ? items : []) {
    const label = hourLabel(it.ts, nowMs);
    if (!cur || cur.label !== label) {
      cur = { label, items: [] };
      groups.push(cur);
    }
    cur.items.push(it);
  }
  return groups;
}

function timeOfDay(iso) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const d = new Date(t);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** One timeline row. */
export function timelineRow(item) {
  const kind = TIMELINE_KIND_LABEL[item.kind] ? item.kind : 'cycle';
  const tone = item.ok === false ? 'danger' : TIMELINE_KIND_TONE[kind];
  const status = item.ok === false ? ' home-tl-failed' : '';
  return `<div class="home-tl-row${status}">
    <span class="home-tl-time">${esc(timeOfDay(item.ts))}</span>
    ${badge(TIMELINE_KIND_LABEL[kind], tone)}
    <span class="home-tl-title">${esc(item.title ?? '')}</span>
    ${item.detail ? `<span class="home-tl-detail text-dim">${esc(item.detail)}</span>` : ''}
  </div>`;
}

/** Whole timeline body (grouped) or an empty state. */
export function timelineBody(items, nowMs = Date.now()) {
  const groups = groupTimelineByHour(items, nowMs);
  if (groups.length === 0) {
    return emptyState({
      icon: '◷',
      title: 'Nothing happened yet',
      hint: 'LLM calls, tool runs, outputs, questions and karma changes will show up here as they happen.',
    });
  }
  return groups
    .map(
      (g) => `<div class="home-tl-group">
      <div class="home-tl-group-label">${esc(g.label)}</div>
      ${g.items.map(timelineRow).join('')}
    </div>`
    )
    .join('');
}

function goalRow(g) {
  const pr = g.priority ? `<span class="stats-chip">${esc(String(g.priority))}</span>` : '';
  const note = g.notes
    ? `<div class="home-goal-notes text-dim">${esc(String(g.notes).slice(0, 160))}${String(g.notes).length > 160 ? '…' : ''}</div>`
    : '';
  return `<div class="home-goal"><div class="home-goal-title">${esc(g.text || '(untitled)')} ${pr}</div>${note}</div>`;
}

/** Three goal columns: active, blocked, recently completed. */
export function goalsColumns(goals) {
  const active = goals?.active ?? [];
  const blocked = goals?.blocked ?? [];
  const done = goals?.completedRecently ?? [];
  if (active.length + blocked.length + done.length === 0) {
    return emptyState({
      icon: '◎',
      title: 'No goals yet',
      hint: 'Goals live in GOALS.md. Give the agent one and the planner will pick it up on the next cycle.',
    });
  }
  const col = (title, tone, list, empty) => `<div class="home-goal-col">
    <div class="home-goal-col-title">${badge(title, tone)} <span class="text-dim">${list.length}</span></div>
    ${list.length ? list.map(goalRow).join('') : `<div class="text-dim text-sm">${esc(empty)}</div>`}
  </div>`;
  return `<div class="home-goal-cols">
    ${col('active', 'ok', active, 'Nothing active')}
    ${col('blocked', 'danger', blocked, 'Nothing blocked')}
    ${col('done', 'muted', done, 'Nothing finished recently')}
  </div>`;
}

/** Radar axes from a traits record (0.1–0.9 values) — sorted by name for stability. */
export function traitAxes(current) {
  if (!current || typeof current !== 'object') return [];
  return Object.entries(current)
    .filter(([, v]) => Number.isFinite(Number(v)))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([label, v]) => ({ label, value: Number(v) }));
}

/** Score tone: >= 70 ok, >= 40 warn, else danger. */
export function karmaTone(score) {
  if (score == null || !Number.isFinite(Number(score))) return 'muted';
  const s = Number(score);
  return s >= 70 ? 'ok' : s >= 40 ? 'warn' : 'danger';
}

/** Chips for what the human owes the agent; '' when nothing is pending. */
export function needsYouStrip(needsYou, botId) {
  const n = needsYou ?? {};
  const id = encodeURIComponent(botId ?? '');
  const chips = [];
  if (n.asks > 0)
    chips.push(
      `<a class="home-need" href="#/needs/inbox">${n.asks} question${n.asks === 1 ? '' : 's'} to answer</a>`
    );
  if (n.permissions > 0)
    chips.push(
      `<a class="home-need" href="#/needs/permissions">${n.permissions} permission${n.permissions === 1 ? '' : 's'} to decide</a>`
    );
  if (n.productionsPending > 0)
    chips.push(
      `<a class="home-need" href="#/work/productions/${id}">${n.productionsPending} output${n.productionsPending === 1 ? '' : 's'} to review</a>`
    );
  if (chips.length === 0) return '';
  return `<div class="home-needs"><span class="home-needs-label">Needs you</span>${chips.join('')}</div>`;
}

/** Tab strip shared by Home and Config. */
export function homeTabs(botId, active) {
  const id = encodeURIComponent(botId ?? '');
  return tabs(
    [
      { id: 'home', label: 'Home', href: `#/agents/${id}` },
      { id: 'config', label: 'Config', href: `#/agents/${id}/config` },
      { id: 'stats', label: 'Stats', href: `#/insights/stats/bot/${id}` },
      { id: 'productions', label: 'Productions', href: `#/work/productions/${id}` },
      { id: 'conversations', label: 'Conversations', href: `#/work/conversations/${id}` },
    ],
    active
  );
}

/** "just now", "5m ago", "3h ago", "2d ago" — for timelines and event lists. */
export function ago(iso, nowMs = Date.now()) {
  const t = typeof iso === 'number' ? iso : Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const diff = Math.max(0, nowMs - t);
  if (diff < 60_000) return 'just now';
  const m = Math.round(diff / 60_000);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(diff / 3_600_000);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(diff / 86_400_000)}d ago`;
}

/** Traits card body: radar when there are at least three traits. */
export function traitsBody(traits) {
  const axes = traitAxes(traits?.current);
  if (axes.length < 3) {
    return emptyState({
      icon: '◈',
      title: 'No trait registers yet',
      hint: 'TRAITS.json appears after the first strategist pass.',
    });
  }
  const adj = traits?.adjustments != null ? `${traits.adjustments} adjustments` : '';
  const drift = traits?.drift
    ? Object.entries(traits.drift)
        .filter(([, v]) => Math.abs(Number(v)) >= 0.05)
        .map(([k, v]) => `${k} ${Number(v) > 0 ? '+' : ''}${Number(v).toFixed(2)}`)
        .join(', ')
    : '';
  const note = [adj, drift ? `drift: ${drift}` : ''].filter(Boolean).join(' · ');
  return `<div class="home-traits-radar">${radar(axes, { size: 220 })}</div>
    <div class="text-dim text-sm" style="text-align:center;margin-top:6px">${esc(
      note || 'stable since baseline'
    )}</div>`;
}

/** Karma card body: score tile, sparkline, last events. */
export function karmaBody(karma, nowMs = Date.now()) {
  const score = karma?.score ?? null;
  const tone = karmaTone(score);
  const history = (karma?.history ?? []).map((h) => h.score);
  const events = (karma?.recentEvents ?? []).slice(0, 6);
  const top = `<div class="home-karma-top">${kpi({
    label: 'Score',
    value: score ?? '--',
    delta: karma?.delta7d,
    tone,
    hint: karma?.trend ? `${karma.trend} · 7d` : '7d',
  })}${sparkline(history, { width: 180, height: 44, tone })}</div>`;
  if (events.length === 0) {
    return `${top}<div class="text-dim text-sm" style="margin-top:8px">No karma events yet. Approve an output or answer a question and it moves.</div>`;
  }
  return `${top}<div class="home-karma-events">${events
    .map(
      (e) => `<div class="home-karma-event">
        <span class="home-karma-delta" style="color:${e.delta >= 0 ? 'var(--ok)' : 'var(--danger)'}">${e.delta >= 0 ? '+' : ''}${Number(e.delta) || 0}</span>
        ${badge(e.source || 'karma', 'muted')}
        <span style="flex:1">${esc(e.reason)}</span>
        <span class="text-dim text-sm">${esc(ago(e.ts, nowMs))}</span>
      </div>`
    )
    .join('')}</div>`;
}

// ── Keyboard (UX overhaul phase 5) ──────────────────────────────────────────

const TYPING_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT']);

/** True while focus is somewhere a key press means text. */
export function isTypingTarget(target) {
  if (!target) return false;
  if (target.isContentEditable) return true;
  return TYPING_TAGS.has(String(target.tagName ?? '').toUpperCase());
}

const HOME_KEYS = { r: 'run', e: 'edit', c: 'chat' };

/** Agent Home shortcuts: `r` Run now, `e` Edit, `c` focus chat. */
export function homeKeyAction(e) {
  if (!e || e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return null;
  if (isTypingTarget(e.target)) return null;
  return HOME_KEYS[String(e.key ?? '')] ?? null;
}

/** Keys Agent Home binds, for the `?` help sheet (registerPageShortcuts). */
export const AGENT_HOME_SHORTCUTS = [
  ['r', 'Run now'],
  ['e', 'Edit'],
  ['c', 'Focus the chat'],
];
