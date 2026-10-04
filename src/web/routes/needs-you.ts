/**
 * Needs You queue (docs/plans/jarvis-fleet-plan.md, session S5).
 *
 *   GET /api/needs-you        every pending item a human must act on, merged from
 *                             five sources, most urgent first then newest first
 *   GET /api/needs-you/count  { count, byKind } for the sidebar badge
 *   POST /api/needs-you/bulk  { ids[], action, note? } → { results: [{ id, ok, error? }] }
 *   POST /api/needs-you/act   { id, action, note? } → { ok } (one item, same path as bulk)
 *   POST /api/needs-you/clear-stale { olderThanHours>=1, kinds?, botId? }
 *                             → { cleared, byKind, results } — neutral action per kind
 *
 * Write side (docs/plans/ux-overhaul-plan.md, Phase 1): bulk/act/clear-stale
 * rebuild the viewer's queue (so tenant scoping is exactly GET's) and apply
 * the action through `NeedsYouActionHandlers`, the same store/service calls
 * the per-item routes make. Neutral per kind: ask dismiss, permission deny,
 * proposal reject, feedback dismiss, production archive (no karma), tool reject.
 *
 * Sources and what "pending" means for each:
 *   ask         an inbox conversation in `inboxStatus: 'pending'` (the same rule
 *               the badge used), enriched with the live `AskHumanStore` entry
 *               when the process still holds it; a live question with no
 *               conversation is listed from the store alone
 *   permission  every pending `ask_permission` request
 *   proposal    every `status: 'pending'` agent proposal
 *   tool        a pending dynamic tool (admin / single-tenant only)
 *   production  one item per production file that is still active (not
 *               archived or deleted since) and has no `evaluation.status`
 *   feedback    a pending feedback entry whose thread ends with the bot's
 *               message (the bot answered, the human has not) — "feedback
 *               replies" in the plan's words; a thread waiting on the bot is not
 *               waiting on you
 *
 * Read-only and tenant-scoped like `/api/stats`. Actions stay on the routes
 * that own them; each item lists the requests the page must send
 * (`actions[]`), so the page never learns the five APIs. A source that throws
 * is logged and skipped, a row that fails to map is skipped: the queue must
 * render with whatever is left.
 */
import { Hono } from 'hono';
import type { AgentFeedback } from '../../bot/agent-feedback-store';
import type { PendingQuestionInfo } from '../../bot/ask-human-store';
import type { PermissionRequestInfo } from '../../bot/ask-permission-store';
import type { Config } from '../../config';
import type { Conversation } from '../../conversations/service';
import type { Logger } from '../../logger';
import type { ProductionEntry } from '../../productions/types';
import { getTenantId, isAdminOrSingleTenant, scopeBots } from '../../tenant/tenant-scoping';
import type { AgentProposal } from '../../tools/agent-proposal-store';
import type { DynamicToolMeta } from '../../tools/dynamic-tool-store';
import type { ThreadMessage } from '../../types/thread';

export type NeedsYouKind = 'ask' | 'permission' | 'proposal' | 'production' | 'feedback' | 'tool';
export type NeedsYouUrgency = 'high' | 'normal' | 'low';
export type NeedsYouActionId =
  | 'answer'
  | 'approve'
  | 'deny'
  | 'reject'
  | 'dismiss'
  | 'reply'
  | 'archive'
  | 'delete';

export const NEEDS_YOU_KINDS: readonly NeedsYouKind[] = [
  'ask',
  'permission',
  'proposal',
  'production',
  'feedback',
  'tool',
];

export interface NeedsYouAction {
  id: NeedsYouActionId;
  label: string;
  method: 'POST' | 'DELETE';
  path: string;
  /** Fixed body fields; the page merges the reply box into `input.field`. */
  body?: Record<string, unknown>;
  input?: { field: string; required: boolean; placeholder: string };
  tone: 'ok' | 'danger' | 'muted';
  /** `a` fires the primary action, `d` the negative one. */
  hotkey?: 'a' | 'd';
  /** When set the page asks this question (confirm dialog) before sending. */
  confirm?: string;
}

export interface NeedsYouItem {
  /** Unique across sources: `<kind>:<source id>` (prefixed with the bot for per-bot stores). */
  id: string;
  kind: NeedsYouKind;
  botId: string;
  botName: string;
  title: string;
  body: string;
  /** Quick-reply choices (ask_human `options`); null for the other kinds. */
  options: string[] | null;
  /** ISO timestamp of the moment the item started waiting on a human. */
  createdAt: string;
  urgency: NeedsYouUrgency;
  actions: NeedsYouAction[];
  /** Where the item lives in the old pages (history view, full thread). */
  href: string;
  meta: Record<string, string | number | boolean | string[] | null>;
}

export interface NeedsYouResponse {
  generatedAt: string;
  count: number;
  byKind: Record<NeedsYouKind, number>;
  items: NeedsYouItem[];
}

export interface NeedsYouCountResponse {
  count: number;
  byKind: Record<NeedsYouKind, number>;
}

/** The slice of `ConversationsService` the ask source reads. */
export interface NeedsYouConversations {
  getBotIds(): string[];
  listConversations(botId: string, opts?: { type?: string; limit?: number }): Conversation[];
  getMessages(botId: string, conversationId: string, opts?: { limit?: number }): ThreadMessage[];
}

/**
 * Every source is optional and lazily read, so a disabled feature (no
 * proposal store, productions off) is a missing key rather than a stub.
 */
export interface NeedsYouSources {
  asks?: () => PendingQuestionInfo[];
  conversations?: NeedsYouConversations | null;
  permissions?: () => PermissionRequestInfo[];
  proposals?: () => AgentProposal[];
  productions?: () => ProductionEntry[];
  feedback?: { botIds(): string[]; list(botId: string): AgentFeedback[] };
  /** Dynamic tools (admin-only queue kind `tool`); only `status: 'pending'` are listed. */
  tools?: () => DynamicToolMeta[];
}

/**
 * Write side for `POST /bulk`, `/act` and `/clear-stale`: the same store and
 * service calls the per-item routes make, so a bulk dismiss is exactly N
 * single dismisses (karma included where the single route applies it). Every
 * handler returns `false` for "not found / already resolved".
 */
export interface NeedsYouActionHandlers {
  /** Live ask_human question → dismissed (the store's onDismiss marks the conversation). */
  dismissAsk?(questionId: string): boolean;
  /** Inbox conversation with no live question → `inboxStatus: 'dismissed'` (never deleted). */
  closeInboxConversation?(botId: string, conversationId: string): boolean;
  denyPermission?(id: string, note?: string): boolean;
  rejectProposal?(id: string, note?: string): boolean;
  dismissFeedback?(botId: string, id: string): boolean;
  /** The productions evaluate path (karma + feedback-to-memory). */
  evaluateProduction?(botId: string, id: string, status: 'approved' | 'rejected'): boolean;
  /** Neutral: archive the file, no evaluation, no karma. */
  archiveProduction?(botId: string, id: string, reason: string): boolean;
  approveTool?(id: string): boolean;
  rejectTool?(id: string, note?: string): boolean;
}

/** What `/bulk` and `/act` accept. `neutral` = the no-karma negative action of each kind. */
export type NeedsYouBulkAction = 'dismiss' | 'archive' | 'approve' | 'reject' | 'deny' | 'neutral';
export const NEEDS_YOU_BULK_ACTIONS: readonly NeedsYouBulkAction[] = [
  'dismiss',
  'archive',
  'approve',
  'reject',
  'deny',
  'neutral',
];

/** Actions each kind supports in bulk. Asks and proposals are never bulk-approved. */
export const NEEDS_YOU_SUPPORTED_ACTIONS: Record<NeedsYouKind, readonly NeedsYouBulkAction[]> = {
  ask: ['dismiss'],
  permission: ['deny'],
  proposal: ['reject'],
  production: ['approve', 'reject', 'archive'],
  feedback: ['dismiss'],
  tool: ['approve', 'reject'],
};

type ConcreteAction = Exclude<NeedsYouBulkAction, 'neutral'>;

/** The neutral action per kind — what `clear-stale` and `neutral` apply. Never approves. */
export const NEEDS_YOU_NEUTRAL_ACTION: Record<NeedsYouKind, ConcreteAction> = {
  ask: 'dismiss',
  permission: 'deny',
  proposal: 'reject',
  production: 'archive',
  feedback: 'dismiss',
  tool: 'reject',
};

/** `clear-stale` without `kinds`: everything but tools (rejecting code is a review, not upkeep). */
export const CLEAR_STALE_DEFAULT_KINDS: readonly NeedsYouKind[] = [
  'ask',
  'permission',
  'proposal',
  'production',
  'feedback',
];

export const BULK_MAX_IDS = 500;
const CLEARED_NOTE = 'Cleared from Needs You';

export interface NeedsYouBulkResult {
  id: string;
  ok: boolean;
  error?: string;
}

export interface NeedsYouRouteDeps {
  config: Config;
  logger: Logger;
  sources: NeedsYouSources;
  /** Write side for bulk/act/clear-stale; omitted = every write answers ok:false. */
  actions?: NeedsYouActionHandlers;
  /** Injectable clock (tests). */
  now?: () => number;
}

const URGENCY_RANK: Record<NeedsYouUrgency, number> = { high: 0, normal: 1, low: 2 };
const URGENCIES = new Set<string>(['high', 'normal', 'low']);
const TITLE_MAX = 90;
const INBOX_PAGE = 200;

function str(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback;
}

function truncate(text: string, max = TITLE_MAX): string {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

function toIso(value: unknown, fallbackMs: number): string {
  const ms =
    typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : Number.NaN;
  return new Date(Number.isFinite(ms) ? ms : fallbackMs).toISOString();
}

function urgencyOf(value: unknown, fallback: NeedsYouUrgency): NeedsYouUrgency {
  return typeof value === 'string' && URGENCIES.has(value) ? (value as NeedsYouUrgency) : fallback;
}

function stringList(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const out = value.filter((v): v is string => typeof v === 'string' && v.trim().length > 0);
  return out.length > 0 ? out : null;
}

function emptyByKind(): Record<NeedsYouKind, number> {
  return { ask: 0, permission: 0, proposal: 0, production: 0, feedback: 0, tool: 0 };
}

/** Most urgent first, then newest first; ties keep their input order. */
export function sortNeedsYou(items: NeedsYouItem[]): NeedsYouItem[] {
  return items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => {
      const u = URGENCY_RANK[a.item.urgency] - URGENCY_RANK[b.item.urgency];
      if (u !== 0) return u;
      const t = Date.parse(b.item.createdAt) - Date.parse(a.item.createdAt);
      if (t !== 0 && Number.isFinite(t)) return t;
      return a.index - b.index;
    })
    .map((x) => x.item);
}

interface BuildContext {
  allowed: Set<string> | undefined;
  /** Admin or single-tenant: may see admin-only kinds (`tool`). */
  admin: boolean;
  nameOf: (botId: string) => string;
  nowMs: number;
  logger: Logger;
}

function allowedBot(ctx: BuildContext, botId: string): boolean {
  return !ctx.allowed || ctx.allowed.has(botId);
}

/** Run one source; a throw yields an empty list and a warn line, never a 500. */
function safeRead<T>(ctx: BuildContext, name: string, read: (() => T[]) | undefined): T[] {
  if (!read) return [];
  try {
    const rows = read();
    return Array.isArray(rows) ? rows : [];
  } catch (err) {
    ctx.logger.warn({ err, source: name }, 'needs-you: source failed, skipping');
    return [];
  }
}

/** Map one row; a throw or a null result drops the row. */
function safeMap<T>(
  ctx: BuildContext,
  name: string,
  rows: T[],
  map: (row: T) => NeedsYouItem | null
): NeedsYouItem[] {
  const out: NeedsYouItem[] = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    try {
      const item = map(row);
      if (item) out.push(item);
    } catch (err) {
      ctx.logger.warn({ err, source: name }, 'needs-you: row failed to map, skipping');
    }
  }
  return out;
}

// ─── asks ───

function askActionsFromStore(questionId: string): NeedsYouAction[] {
  const q = encodeURIComponent(questionId);
  return [
    {
      id: 'answer',
      label: 'Answer',
      method: 'POST',
      path: `/api/ask-human/${q}/answer`,
      input: { field: 'answer', required: true, placeholder: 'Your answer…' },
      tone: 'ok',
      hotkey: 'a',
    },
    {
      id: 'dismiss',
      label: 'Dismiss',
      method: 'DELETE',
      path: `/api/ask-human/${q}`,
      tone: 'muted',
      hotkey: 'd',
    },
  ];
}

function askActionsFromConversation(
  botId: string,
  conversationId: string,
  liveQuestionId: string | null
): NeedsYouAction[] {
  const b = encodeURIComponent(botId);
  const c = encodeURIComponent(conversationId);
  return [
    {
      id: 'answer',
      label: 'Answer',
      method: 'POST',
      path: `/api/conversations/${b}/${c}/messages`,
      input: { field: 'message', required: true, placeholder: 'Your answer…' },
      tone: 'ok',
      hotkey: 'a',
    },
    liveQuestionId
      ? {
          id: 'dismiss',
          label: 'Dismiss',
          method: 'DELETE',
          path: `/api/ask-human/${encodeURIComponent(liveQuestionId)}`,
          tone: 'muted',
          hotkey: 'd',
        }
      : {
          // No live question: close the conversation (kept in history, not deleted).
          id: 'dismiss',
          label: 'Dismiss',
          method: 'POST',
          path: '/api/needs-you/act',
          body: { id: `ask:${conversationId}`, action: 'dismiss' },
          tone: 'muted',
          hotkey: 'd',
        },
    ...(liveQuestionId
      ? []
      : [
          {
            id: 'delete' as const,
            label: 'Delete conversation',
            method: 'DELETE' as const,
            path: `/api/conversations/${b}/${c}`,
            tone: 'danger' as const,
            confirm: 'Delete this conversation and its whole thread? This cannot be undone.',
          },
        ]),
  ];
}

function buildAsks(ctx: BuildContext, sources: NeedsYouSources): NeedsYouItem[] {
  const live = new Map<string, PendingQuestionInfo>();
  for (const q of safeRead(ctx, 'asks', sources.asks)) {
    if (q && typeof q === 'object' && typeof q.id === 'string' && typeof q.botId === 'string') {
      live.set(q.id, q);
    }
  }
  const consumed = new Set<string>();
  const items: NeedsYouItem[] = [];

  const conversations = sources.conversations;
  if (conversations) {
    const botIds = safeRead(ctx, 'conversations', () => conversations.getBotIds());
    for (const botId of botIds) {
      if (typeof botId !== 'string' || !allowedBot(ctx, botId)) continue;
      const convos = safeRead(ctx, 'conversations', () =>
        conversations.listConversations(botId, { type: 'inbox', limit: INBOX_PAGE })
      );
      items.push(
        ...safeMap(ctx, 'conversations', convos, (conv) => {
          if (conv.inboxStatus !== 'pending' || typeof conv.id !== 'string') return null;
          const questionId = str(conv.askHumanQuestionId) || null;
          const q = questionId ? live.get(questionId) : undefined;
          if (q) consumed.add(q.id);
          let messages: ThreadMessage[] = [];
          try {
            messages = conversations.getMessages(botId, conv.id) ?? [];
          } catch (err) {
            ctx.logger.warn(
              { err, botId, conversationId: conv.id },
              'needs-you: messages unreadable'
            );
          }
          const firstBot = Array.isArray(messages)
            ? messages.find((m) => m && m.role === 'bot' && typeof m.content === 'string')
            : undefined;
          const title = str(conv.title) || truncate(str(q?.question) || 'Question');
          const body = firstBot?.content ?? str(q?.question) ?? title;
          const files = firstBot?.files
            ?.map((f) => (f && typeof f.path === 'string' ? f.path : null))
            .filter((p): p is string => !!p);
          return {
            id: `ask:${conv.id}`,
            kind: 'ask',
            botId,
            botName: ctx.nameOf(botId),
            title: truncate(title),
            body: body || title,
            options: stringList(q?.options) ?? stringList(conv.askOptions),
            createdAt: toIso(conv.createdAt, q?.createdAt ?? ctx.nowMs),
            urgency: 'normal',
            actions: askActionsFromConversation(botId, conv.id, q ? q.id : null),
            href: `#/needs/inbox/${encodeURIComponent(botId)}/${encodeURIComponent(conv.id)}`,
            meta: {
              live: !!q,
              conversationId: conv.id,
              questionId: questionId,
              files: files && files.length > 0 ? files : null,
            },
          };
        })
      );
    }
  }

  items.push(
    ...safeMap(ctx, 'asks', [...live.values()], (q) => {
      if (consumed.has(q.id) || !allowedBot(ctx, q.botId)) return null;
      const question = str(q.question) || 'Question';
      return {
        id: `ask:${q.id}`,
        kind: 'ask',
        botId: q.botId,
        botName: ctx.nameOf(q.botId),
        title: truncate(question),
        body: question,
        options: stringList(q.options),
        createdAt: toIso(q.createdAt, ctx.nowMs),
        urgency: 'normal',
        actions: askActionsFromStore(q.id),
        href: '#/needs/inbox',
        meta: {
          live: true,
          conversationId: str(q.conversationId) || null,
          questionId: q.id,
          files: null,
        },
      };
    })
  );
  return items;
}

// ─── permissions ───

function buildPermissions(ctx: BuildContext, sources: NeedsYouSources): NeedsYouItem[] {
  const rows = safeRead(ctx, 'permissions', sources.permissions);
  return safeMap(ctx, 'permissions', rows, (r) => {
    if (typeof r.id !== 'string' || typeof r.botId !== 'string') return null;
    if (!allowedBot(ctx, r.botId)) return null;
    const id = encodeURIComponent(r.id);
    const action = str(r.action, 'action');
    const resource = str(r.resource);
    return {
      id: `permission:${r.id}`,
      kind: 'permission',
      botId: r.botId,
      botName: ctx.nameOf(r.botId),
      title: truncate(resource ? `${action} → ${resource}` : action),
      body: str(r.description) || `${action} ${resource}`.trim(),
      options: null,
      createdAt: toIso(r.createdAt, ctx.nowMs),
      urgency: urgencyOf(r.urgency, 'normal'),
      actions: [
        {
          id: 'approve',
          label: 'Approve',
          method: 'POST',
          path: `/api/ask-permission/${id}/approve`,
          input: { field: 'note', required: false, placeholder: 'Optional note…' },
          tone: 'ok',
          hotkey: 'a',
        },
        {
          id: 'deny',
          label: 'Deny',
          method: 'POST',
          path: `/api/ask-permission/${id}/deny`,
          input: { field: 'note', required: false, placeholder: 'Optional note…' },
          tone: 'danger',
          hotkey: 'd',
        },
      ],
      href: '#/needs/permissions',
      meta: { action, resource, requestId: r.id },
    };
  });
}

// ─── proposals ───

function buildProposals(ctx: BuildContext, sources: NeedsYouSources): NeedsYouItem[] {
  const rows = safeRead(ctx, 'proposals', sources.proposals);
  return safeMap(ctx, 'proposals', rows, (p) => {
    if (p.status !== 'pending' || typeof p.id !== 'string') return null;
    const botId = str(p.proposedBy);
    if (!allowedBot(ctx, botId)) return null;
    const id = encodeURIComponent(p.id);
    const name = str(p.agentName) || str(p.agentId) || p.id;
    const emoji = str(p.emoji);
    const lines = [
      p.role ? `Role: ${str(p.role)}` : '',
      str(p.personalityDescription),
      p.justification ? `Why: ${str(p.justification)}` : '',
      Array.isArray(p.skills) && p.skills.length > 0 ? `Skills: ${p.skills.join(', ')}` : '',
      p.model || p.llmBackend
        ? `Model: ${[str(p.llmBackend), str(p.model)].filter(Boolean).join(' · ')}`
        : '',
    ].filter(Boolean);
    return {
      id: `proposal:${p.id}`,
      kind: 'proposal',
      botId,
      botName: ctx.nameOf(botId),
      title: truncate(`New agent: ${emoji ? `${emoji} ` : ''}${name}`),
      body: lines.join('\n\n') || name,
      options: null,
      createdAt: toIso(p.createdAt, ctx.nowMs),
      urgency: 'low',
      actions: [
        {
          id: 'approve',
          label: 'Approve & create',
          method: 'POST',
          path: `/api/agent-proposals/${id}/approve`,
          tone: 'ok',
          hotkey: 'a',
        },
        {
          id: 'reject',
          label: 'Reject',
          method: 'POST',
          path: `/api/agent-proposals/${id}/reject`,
          input: { field: 'note', required: false, placeholder: 'Rejection note (optional)…' },
          tone: 'danger',
          hotkey: 'd',
        },
      ],
      href: '#/needs/proposals',
      meta: { agentId: str(p.agentId) || null, role: str(p.role) || null, proposalId: p.id },
    };
  });
}

// ─── productions ───

function timestampMs(entry: ProductionEntry): number {
  const ms = Date.parse(str(entry.timestamp));
  return Number.isFinite(ms) ? ms : 0;
}

/**
 * Replay a bot's changelog in time order: the latest `create`/`edit` per path
 * wins, an `archive`/`delete` afterwards removes the path. What is left and
 * still lacks `evaluation.status` is what a human has not looked at.
 */
export function pendingProductionFiles(entries: ProductionEntry[]): ProductionEntry[] {
  const valid = entries.filter(
    (e) => e && typeof e === 'object' && typeof e.path === 'string' && typeof e.id === 'string'
  );
  const sorted = [...valid].sort((a, b) => timestampMs(a) - timestampMs(b));
  const active = new Map<string, ProductionEntry>();
  for (const e of sorted) {
    switch (e.action) {
      case 'create':
      case 'edit':
        active.set(e.path, e);
        break;
      case 'archive':
        active.delete(typeof e.archivedFrom === 'string' ? e.archivedFrom : e.path);
        break;
      case 'delete':
        active.delete(e.path);
        break;
      default:
        break;
    }
  }
  return [...active.values()].filter((e) => !e.evaluation?.status);
}

function buildProductions(ctx: BuildContext, sources: NeedsYouSources): NeedsYouItem[] {
  const rows = safeRead(ctx, 'productions', sources.productions);
  const byBot = new Map<string, ProductionEntry[]>();
  for (const e of rows) {
    if (!e || typeof e !== 'object' || typeof e.botId !== 'string') continue;
    if (!allowedBot(ctx, e.botId)) continue;
    const list = byBot.get(e.botId) ?? [];
    list.push(e);
    byBot.set(e.botId, list);
  }
  const items: NeedsYouItem[] = [];
  for (const [botId, entries] of byBot) {
    const pending = pendingProductionFiles(entries);
    items.push(
      ...safeMap(ctx, 'productions', pending, (e) => {
        const b = encodeURIComponent(botId);
        const id = encodeURIComponent(e.id);
        const description = str(e.description);
        const details = [e.path, typeof e.size === 'number' ? `${e.size} bytes` : '', str(e.tool)]
          .filter(Boolean)
          .join(' · ');
        return {
          id: `production:${botId}:${e.id}`,
          kind: 'production',
          botId,
          botName: ctx.nameOf(botId),
          title: truncate(e.path),
          body: description ? `${description}\n\n${details}` : details,
          options: null,
          createdAt: toIso(e.timestamp, ctx.nowMs),
          urgency: 'low',
          actions: [
            {
              id: 'approve',
              label: 'Approve',
              method: 'POST',
              path: `/api/productions/${b}/${id}/evaluate`,
              body: { status: 'approved' },
              input: { field: 'feedback', required: false, placeholder: 'Feedback (optional)…' },
              tone: 'ok',
              hotkey: 'a',
            },
            {
              id: 'reject',
              label: 'Reject',
              method: 'POST',
              path: `/api/productions/${b}/${id}/evaluate`,
              body: { status: 'rejected' },
              input: { field: 'feedback', required: false, placeholder: 'Feedback (optional)…' },
              tone: 'danger',
              hotkey: 'd',
            },
            {
              id: 'archive',
              label: 'Archive',
              method: 'POST',
              path: `/api/productions/${b}/${id}/archive`,
              body: { reason: 'Archived from Needs You' },
              tone: 'muted',
            },
          ],
          // productions.js restores the selected file from `?file=`.
          href: `#/work/productions/${b}?file=${encodeURIComponent(e.path)}`,
          meta: {
            productionId: e.id,
            path: e.path,
            tool: str(e.tool) || null,
            size: typeof e.size === 'number' ? e.size : null,
            action: str(e.action) || null,
          },
        };
      })
    );
  }
  return items;
}

// ─── feedback ───

/** The bot's last word in a pending feedback thread, or null when the human spoke last. */
export function lastBotReply(entry: AgentFeedback): { content: string; createdAt: string } | null {
  if (entry.status !== 'pending') return null;
  const thread = Array.isArray(entry.thread) ? entry.thread : [];
  const last = thread.length > 0 ? thread[thread.length - 1] : undefined;
  if (last) {
    if (last.role !== 'bot' || typeof last.content !== 'string') return null;
    return { content: last.content, createdAt: str(last.createdAt) || str(entry.createdAt) };
  }
  if (typeof entry.response === 'string' && entry.response.trim()) {
    return { content: entry.response, createdAt: str(entry.createdAt) };
  }
  return null;
}

function buildFeedback(ctx: BuildContext, sources: NeedsYouSources): NeedsYouItem[] {
  const fb = sources.feedback;
  if (!fb) return [];
  const botIds = safeRead(ctx, 'feedback', () => fb.botIds());
  const items: NeedsYouItem[] = [];
  for (const botId of botIds) {
    if (typeof botId !== 'string' || !allowedBot(ctx, botId)) continue;
    const rows = safeRead(ctx, 'feedback', () => fb.list(botId));
    items.push(
      ...safeMap(ctx, 'feedback', rows, (e) => {
        if (typeof e.id !== 'string') return null;
        const reply = lastBotReply(e);
        if (!reply) return null;
        const b = encodeURIComponent(botId);
        const id = encodeURIComponent(e.id);
        return {
          id: `feedback:${botId}:${e.id}`,
          kind: 'feedback',
          botId,
          botName: ctx.nameOf(botId),
          title: truncate(`Replied to your feedback: ${str(e.content)}`),
          body: reply.content,
          options: null,
          createdAt: toIso(reply.createdAt, ctx.nowMs),
          urgency: 'normal',
          actions: [
            {
              id: 'reply',
              label: 'Reply',
              method: 'POST',
              path: `/api/agent-feedback/${b}/${id}/reply`,
              input: { field: 'message', required: true, placeholder: 'Your reply…' },
              tone: 'ok',
              hotkey: 'a',
            },
            {
              id: 'dismiss',
              label: 'Dismiss',
              method: 'DELETE',
              path: `/api/agent-feedback/${b}/${id}`,
              tone: 'muted',
              hotkey: 'd',
            },
          ],
          href: `#/needs/feedback/${b}`,
          meta: { feedback: truncate(str(e.content), 200), feedbackId: e.id },
        };
      })
    );
  }
  return items;
}

// ─── tools ───

function buildTools(ctx: BuildContext, sources: NeedsYouSources): NeedsYouItem[] {
  // Tool management is global and admin-only (src/web/routes/tools.ts).
  if (!ctx.admin) return [];
  const rows = safeRead(ctx, 'tools', sources.tools);
  return safeMap(ctx, 'tools', rows, (t) => {
    if (t.status !== 'pending' || typeof t.id !== 'string') return null;
    const id = encodeURIComponent(t.id);
    const botId = str(t.createdBy);
    const params = Object.entries(t.parameters ?? {})
      .map(([k, v]) => `${k}${v?.required ? '' : '?'}: ${str(v?.type, 'any')}`)
      .join(', ');
    const lines = [
      str(t.description),
      `Type: ${str(t.type, '?')} · scope: ${str(t.scope, 'all')}`,
      params ? `Parameters: ${params}` : '',
    ].filter(Boolean);
    return {
      id: `tool:${t.id}`,
      kind: 'tool',
      botId,
      botName: ctx.nameOf(botId),
      title: truncate(`New tool: ${str(t.name) || t.id}`),
      body: lines.join('\n\n'),
      options: null,
      createdAt: toIso(t.createdAt, ctx.nowMs),
      urgency: 'low',
      actions: [
        {
          id: 'approve',
          label: 'Approve & load',
          method: 'POST',
          path: `/api/tools/${id}/approve`,
          tone: 'ok',
          hotkey: 'a',
        },
        {
          id: 'reject',
          label: 'Reject',
          method: 'POST',
          path: `/api/tools/${id}/reject`,
          input: { field: 'note', required: false, placeholder: 'Rejection note (optional)…' },
          tone: 'danger',
          hotkey: 'd',
        },
      ],
      href: '#/automations/tools',
      meta: { toolId: t.id, name: str(t.name) || null, type: str(t.type) || null },
    };
  });
}

// ─── composition ───

/**
 * The whole queue for one viewer. `allowed` is the set of bot ids the viewer
 * may see (undefined = everything); `opts.admin` unlocks admin-only kinds
 * (defaults to `allowed === undefined`). Exported so tests and future callers
 * (S9 web push) can build the list without HTTP.
 */
export function buildNeedsYou(
  deps: Pick<NeedsYouRouteDeps, 'config' | 'logger' | 'sources'>,
  allowed: Set<string> | undefined,
  nowMs: number,
  opts: { admin?: boolean } = {}
): NeedsYouItem[] {
  const names = new Map(deps.config.bots.map((b) => [b.id, b.name ?? b.id]));
  const ctx: BuildContext = {
    allowed,
    admin: opts.admin ?? allowed === undefined,
    nameOf: (id) => names.get(id) ?? id,
    nowMs,
    logger: deps.logger,
  };
  const s = deps.sources;
  return sortNeedsYou([
    ...buildAsks(ctx, s),
    ...buildPermissions(ctx, s),
    ...buildProposals(ctx, s),
    ...buildProductions(ctx, s),
    ...buildFeedback(ctx, s),
    ...buildTools(ctx, s),
  ]);
}

// ─── write side ───

function metaStr(item: NeedsYouItem, key: string): string | null {
  const v = item.meta?.[key];
  return typeof v === 'string' && v ? v : null;
}

/** Resolve `neutral` and check the kind supports the action; returns the concrete action or an error. */
export function resolveBulkAction(
  kind: NeedsYouKind,
  action: NeedsYouBulkAction
): { action: ConcreteAction } | { error: string } {
  const concrete = action === 'neutral' ? NEEDS_YOU_NEUTRAL_ACTION[kind] : action;
  if (!NEEDS_YOU_SUPPORTED_ACTIONS[kind].includes(concrete)) {
    return { error: `"${concrete}" is not supported for ${kind} items` };
  }
  return { action: concrete };
}

const UNAVAILABLE = 'Action not available';

/**
 * Apply one action to one queue item through the handlers. Never throws:
 * a handler that throws or returns false is a per-item failure.
 */
export function applyNeedsYouAction(
  handlers: NeedsYouActionHandlers | undefined,
  item: NeedsYouItem,
  requested: NeedsYouBulkAction,
  note?: string
): NeedsYouBulkResult {
  const resolved = resolveBulkAction(item.kind, requested);
  if ('error' in resolved) return { id: item.id, ok: false, error: resolved.error };
  const action = resolved.action;
  const h = handlers ?? {};
  const fail = (error: string): NeedsYouBulkResult => ({ id: item.id, ok: false, error });
  try {
    let ok: boolean | undefined;
    switch (item.kind) {
      case 'ask': {
        const questionId = item.meta?.live ? metaStr(item, 'questionId') : null;
        const conversationId = metaStr(item, 'conversationId');
        if (questionId && h.dismissAsk) ok = h.dismissAsk(questionId);
        // A live question that vanished between the read and now still leaves a
        // pending conversation behind: close that instead.
        if (!ok && conversationId && h.closeInboxConversation) {
          ok = h.closeInboxConversation(item.botId, conversationId);
        }
        if (ok === undefined) return fail(UNAVAILABLE);
        break;
      }
      case 'permission': {
        const id = metaStr(item, 'requestId');
        if (!id || !h.denyPermission) return fail(UNAVAILABLE);
        ok = h.denyPermission(id, note);
        break;
      }
      case 'proposal': {
        const id = metaStr(item, 'proposalId');
        if (!id || !h.rejectProposal) return fail(UNAVAILABLE);
        ok = h.rejectProposal(id, note);
        break;
      }
      case 'feedback': {
        const id = metaStr(item, 'feedbackId');
        if (!id || !h.dismissFeedback) return fail(UNAVAILABLE);
        ok = h.dismissFeedback(item.botId, id);
        break;
      }
      case 'production': {
        const id = metaStr(item, 'productionId');
        if (!id) return fail(UNAVAILABLE);
        if (action === 'archive') {
          if (!h.archiveProduction) return fail(UNAVAILABLE);
          ok = h.archiveProduction(item.botId, id, note || CLEARED_NOTE);
        } else {
          if (!h.evaluateProduction) return fail(UNAVAILABLE);
          ok = h.evaluateProduction(item.botId, id, action === 'approve' ? 'approved' : 'rejected');
        }
        break;
      }
      case 'tool': {
        const id = metaStr(item, 'toolId');
        if (!id) return fail(UNAVAILABLE);
        if (action === 'approve') {
          if (!h.approveTool) return fail(UNAVAILABLE);
          ok = h.approveTool(id);
        } else {
          if (!h.rejectTool) return fail(UNAVAILABLE);
          ok = h.rejectTool(id, note);
        }
        break;
      }
      default:
        return fail('Unknown kind');
    }
    return ok ? { id: item.id, ok: true } : fail('Not found or already resolved');
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}

export function countByKind(items: NeedsYouItem[]): Record<NeedsYouKind, number> {
  const byKind = emptyByKind();
  for (const item of items) byKind[item.kind] += 1;
  return byKind;
}

export function needsYouRoutes(deps: NeedsYouRouteDeps) {
  const app = new Hono();
  const now = deps.now ?? Date.now;

  function allowedFor(c: import('hono').Context): Set<string> | undefined {
    const tenantId = getTenantId(c);
    if (!tenantId) return undefined;
    return new Set(scopeBots(deps.config.bots, tenantId).map((b) => b.id));
  }

  function build(c: import('hono').Context): NeedsYouItem[] {
    try {
      return buildNeedsYou(deps, allowedFor(c), now(), {
        admin: isAdminOrSingleTenant(getTenantId(c)),
      });
    } catch (err) {
      deps.logger.error({ err }, 'needs-you: queue aggregation failed');
      return [];
    }
  }

  async function readBody(c: import('hono').Context): Promise<Record<string, unknown>> {
    const body = await c.req.json().catch(() => null);
    return body && typeof body === 'object' && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : {};
  }

  function isBulkAction(v: unknown): v is NeedsYouBulkAction {
    return typeof v === 'string' && (NEEDS_YOU_BULK_ACTIONS as readonly string[]).includes(v);
  }

  function runMany(
    items: NeedsYouItem[],
    ids: string[],
    action: NeedsYouBulkAction | ((item: NeedsYouItem) => NeedsYouBulkAction),
    note?: string
  ): NeedsYouBulkResult[] {
    const byId = new Map(items.map((i) => [i.id, i]));
    return ids.map((id) => {
      const item = byId.get(id);
      if (!item) return { id, ok: false, error: 'Not found' };
      const a = typeof action === 'function' ? action(item) : action;
      return applyNeedsYouAction(deps.actions, item, a, note);
    });
  }

  // POST /bulk { ids, action, note? } → { results: [{ id, ok, error? }] }
  app.post('/bulk', async (c) => {
    const body = await readBody(c);
    const ids = body.ids;
    if (
      !Array.isArray(ids) ||
      ids.length === 0 ||
      ids.length > BULK_MAX_IDS ||
      !ids.every((i) => typeof i === 'string' && i.length > 0)
    ) {
      return c.json({ error: `"ids" must be 1-${BULK_MAX_IDS} item ids` }, 400);
    }
    if (!isBulkAction(body.action)) {
      return c.json({ error: `"action" must be one of ${NEEDS_YOU_BULK_ACTIONS.join(', ')}` }, 400);
    }
    const note = typeof body.note === 'string' && body.note.trim() ? body.note.trim() : undefined;
    const results = runMany(build(c), [...new Set(ids as string[])], body.action, note);
    deps.logger.info(
      {
        action: body.action,
        requested: ids.length,
        ok: results.filter((r) => r.ok).length,
      },
      'needs-you: bulk action'
    );
    return c.json({ results });
  });

  // POST /act { id, action, note? } → { ok: true } | { ok: false, error } (404/400/409)
  app.post('/act', async (c) => {
    const body = await readBody(c);
    if (typeof body.id !== 'string' || !body.id) {
      return c.json({ ok: false, error: '"id" is required' }, 400);
    }
    if (!isBulkAction(body.action)) {
      return c.json({ ok: false, error: '"action" is invalid' }, 400);
    }
    const item = build(c).find((i) => i.id === body.id);
    if (!item) return c.json({ ok: false, error: 'Item not found or already resolved' }, 404);
    const resolved = resolveBulkAction(item.kind, body.action);
    if ('error' in resolved) return c.json({ ok: false, error: resolved.error }, 400);
    const note = typeof body.note === 'string' && body.note.trim() ? body.note.trim() : undefined;
    const result = applyNeedsYouAction(deps.actions, item, body.action, note);
    if (!result.ok) return c.json({ ok: false, error: result.error }, 409);
    return c.json({ ok: true });
  });

  // POST /clear-stale { olderThanHours, kinds?, botId? } → { cleared, byKind, results }
  app.post('/clear-stale', async (c) => {
    const body = await readBody(c);
    const hours = body.olderThanHours;
    if (typeof hours !== 'number' || !Number.isFinite(hours) || hours < 1) {
      return c.json({ error: '"olderThanHours" must be a number >= 1' }, 400);
    }
    let kinds: readonly NeedsYouKind[] = CLEAR_STALE_DEFAULT_KINDS;
    if (body.kinds !== undefined) {
      if (
        !Array.isArray(body.kinds) ||
        !body.kinds.every((k) => (NEEDS_YOU_KINDS as readonly unknown[]).includes(k))
      ) {
        return c.json({ error: `"kinds" must be a subset of ${NEEDS_YOU_KINDS.join(', ')}` }, 400);
      }
      kinds = body.kinds as NeedsYouKind[];
    }
    const botId = typeof body.botId === 'string' && body.botId ? body.botId : null;
    const cutoff = now() - hours * 3_600_000;
    const items = build(c).filter((i) => {
      if (!kinds.includes(i.kind)) return false;
      if (botId && i.botId !== botId) return false;
      const t = Date.parse(i.createdAt);
      return Number.isFinite(t) && t < cutoff;
    });
    const results = runMany(
      items,
      items.map((i) => i.id),
      (item) => NEEDS_YOU_NEUTRAL_ACTION[item.kind],
      CLEARED_NOTE
    );
    const byKind = emptyByKind();
    const kindOf = new Map(items.map((i) => [i.id, i.kind]));
    for (const r of results) {
      const k = kindOf.get(r.id);
      if (r.ok && k) byKind[k] += 1;
    }
    const cleared = results.filter((r) => r.ok).length;
    deps.logger.info(
      { olderThanHours: hours, kinds, botId, matched: items.length, cleared },
      'needs-you: cleared stale items'
    );
    return c.json({ cleared, byKind, results });
  });

  app.get('/', (c) => {
    const items = build(c);
    const body: NeedsYouResponse = {
      generatedAt: new Date(now()).toISOString(),
      count: items.length,
      byKind: countByKind(items),
      items,
    };
    return c.json(body);
  });

  app.get('/count', (c) => {
    const items = build(c);
    const body: NeedsYouCountResponse = { count: items.length, byKind: countByKind(items) };
    return c.json(body);
  });

  return app;
}

/**
 * Sources wired from a BotManager (server.ts). Structural so tests can pass a
 * stub; every accessor is optional because the proposal store and the
 * productions service only exist when their features are on.
 */
export interface NeedsYouBotManager {
  getAskHumanPending(): PendingQuestionInfo[];
  getPermissionsPending(): PermissionRequestInfo[];
  getAgentFeedbackBotIds(): string[];
  getAgentFeedback(botId: string, opts?: { status?: string; limit?: number }): AgentFeedback[];
  getAgentProposalStore?(): { list(): AgentProposal[] } | null | undefined;
  getConversationsService?(): NeedsYouConversations | null | undefined;
  getProductionsService?():
    | { getAllEntries(opts?: { limit?: number }): { entries: ProductionEntry[] } }
    | null
    | undefined;
  getDynamicToolStore?(): { list(): DynamicToolMeta[] } | null | undefined;
}

export const PRODUCTIONS_SCAN_LIMIT = 5_000;

/**
 * The write-side slice of BotManager. Kept structural (and every member
 * optional where the feature may be off) so tests pass a stub.
 */
export interface NeedsYouActionsBotManager {
  dismissAskHuman(id: string): boolean;
  denyPermission(id: string, note?: string): boolean;
  dismissAgentFeedback(botId: string, id: string): boolean;
  getConversationsService?():
    | {
        markInboxStatus(botId: string, conversationId: string, status: 'dismissed'): unknown;
      }
    | null
    | undefined;
  getAgentProposalStore?():
    | {
        get(id: string): AgentProposal | null | undefined;
        updateStatus(id: string, status: 'rejected', note?: string): unknown;
      }
    | null
    | undefined;
  getProductionsService?():
    | {
        getEntry(botId: string, id: string): ProductionEntry | null | undefined;
        archiveFile(botId: string, path: string, reason: string): boolean;
        evaluate(
          botId: string,
          id: string,
          body: { status: 'approved' | 'rejected' },
          soulLoader?: unknown,
          karma?: unknown,
          activity?: unknown
        ): unknown;
      }
    | null
    | undefined;
  getDynamicToolRegistry?():
    | { approve(id: string): unknown; reject(id: string, note?: string): unknown }
    | null
    | undefined;
  findSoulLoader?(botId: string): unknown;
  getKarmaService?(): unknown;
  getActivityStream?(): unknown;
}

/**
 * Handlers wired from a BotManager (server.ts). Each one is the call the
 * owning route makes: `DELETE /api/ask-human/:id`, `POST /api/ask-permission/:id/deny`,
 * `POST /api/agent-proposals/:id/reject`, `DELETE /api/agent-feedback/:botId/:id`,
 * `POST /api/productions/:botId/:id/evaluate|archive`, `POST /api/tools/:id/approve|reject`.
 */
export function needsYouActionsFromBotManager(bm: NeedsYouActionsBotManager): NeedsYouActionHandlers {
  return {
    dismissAsk: (questionId) => bm.dismissAskHuman(questionId),
    closeInboxConversation: (botId, conversationId) =>
      !!bm.getConversationsService?.()?.markInboxStatus(botId, conversationId, 'dismissed'),
    denyPermission: (id, note) => bm.denyPermission(id, note),
    rejectProposal: (id, note) => {
      const store = bm.getAgentProposalStore?.();
      const proposal = store?.get(id);
      if (!store || !proposal || proposal.status !== 'pending') return false;
      return !!store.updateStatus(id, 'rejected', note);
    },
    dismissFeedback: (botId, id) => bm.dismissAgentFeedback(botId, id),
    evaluateProduction: (botId, id, status) => {
      const productions = bm.getProductionsService?.();
      if (!productions) return false;
      return !!productions.evaluate(
        botId,
        id,
        { status },
        bm.findSoulLoader?.(botId),
        bm.getKarmaService?.(),
        bm.getActivityStream?.()
      );
    },
    archiveProduction: (botId, id, reason) => {
      const productions = bm.getProductionsService?.();
      const entry = productions?.getEntry(botId, id);
      if (!productions || !entry) return false;
      return productions.archiveFile(botId, entry.path, reason);
    },
    approveTool: (id) => !!bm.getDynamicToolRegistry?.()?.approve(id),
    rejectTool: (id, note) => !!bm.getDynamicToolRegistry?.()?.reject(id, note),
  };
}

export function needsYouSourcesFromBotManager(bm: NeedsYouBotManager): NeedsYouSources {
  const proposalStore = bm.getAgentProposalStore?.();
  const productions = bm.getProductionsService?.();
  const toolStore = bm.getDynamicToolStore?.();
  return {
    tools: toolStore ? () => toolStore.list() : undefined,
    asks: () => bm.getAskHumanPending(),
    conversations: bm.getConversationsService?.() ?? null,
    permissions: () => bm.getPermissionsPending(),
    proposals: proposalStore ? () => proposalStore.list() : undefined,
    productions: productions
      ? () => productions.getAllEntries({ limit: PRODUCTIONS_SCAN_LIMIT }).entries
      : undefined,
    feedback: {
      botIds: () => bm.getAgentFeedbackBotIds(),
      list: (botId) => bm.getAgentFeedback(botId, { status: 'pending', limit: 500 }),
    },
  };
}
