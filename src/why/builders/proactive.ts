/**
 * Why for a proactive message an agent sent (`send_proactive_message`):
 * built from its tool-audit entry (recipient, message, result, success /
 * `failureKind`, `cycleId` / `goalId`) and the cycle-log row of the cycle it
 * ran in. A `policy` failure is the `ProactiveThrottle` refusing it; the
 * refusal's own text says which limit fired.
 */
import type { ToolAuditEntry } from '../../bot/tool-audit-log';
import { type CycleRow, toWhyCycle } from '../cycle-index';
import type { Why } from '../types';

export const PROACTIVE_TOOL = 'send_proactive_message';

export type ProactiveStatus = 'delivered' | 'refused' | 'failed';

/** One proactive send, as the dashboard lists it. */
export interface ProactiveSend {
  botId: string;
  sentAt: string;
  /** The `chatId` the agent asked for ("operator", a Telegram chat id, a web user id). */
  recipient: string;
  /** The recipient resolved to the operator. */
  toOperator: boolean;
  message: string;
  status: ProactiveStatus;
  /** The tool's result text: delivery confirmation, throttle refusal or error. */
  result: string;
  cycleId?: string;
  goalId?: string;
  /** The recorded cycle-log row for `cycleId`, when found. */
  cycle?: CycleRow;
}

/** A `send_proactive_message` audit entry as a send; anything else → null. */
export function proactiveFromAudit(
  e: ToolAuditEntry,
  isOperator: (recipient: string) => boolean
): ProactiveSend | null {
  if (e?.toolName !== PROACTIVE_TOOL) return null;
  const args = e.args ?? {};
  const recipient = String(args.chatId ?? '').trim();
  const status: ProactiveStatus =
    e.success !== false ? 'delivered' : e.failureKind === 'policy' ? 'refused' : 'failed';
  const s: ProactiveSend = {
    botId: e.botId,
    sentAt: e.timestamp,
    recipient,
    toOperator: recipient !== '' && isOperator(recipient),
    message: String(args.message ?? '').trim(),
    status,
    result: String(e.result ?? ''),
  };
  if (e.cycleId) s.cycleId = e.cycleId;
  if (e.goalId) s.goalId = e.goalId;
  return s;
}

/** The throttle's refusal text (`ProactiveThrottle.check`) in plain words. */
export function describeThrottle(reason: string): { rule?: string; retryAt?: string } {
  const out: { rule?: string; retryAt?: string } = {};
  const retry = /may send again at (\S+?)\.(?:\s|$)/.exec(reason);
  const cooldown = /Per-bot cooldown (\d+)m/.exec(reason);
  const cap = /Fleet cap (\d+)\/24h, used (\d+)/.exec(reason);
  if (cooldown) out.rule = `One proactive message per agent every ${cooldown[1]} min.`;
  else if (cap) {
    out.rule = `At most ${cap[1]} proactive messages per 24 h across the fleet (${cap[2]} already sent).`;
  }
  if (retry && (cooldown || cap)) out.retryAt = retry[1];
  return out;
}

/** `2026-10-11T13:00:00.000Z` → `2026-10-11 13:00 UTC`; anything else as is. */
function plainTime(iso: string): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return iso;
  return `${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

const RESULT_MAX = 200;
const clip = (s: string) => (s.length > RESULT_MAX ? `${s.slice(0, RESULT_MAX - 1)}…` : s);

function outcomeOf(s: ProactiveSend, retryAt: string | undefined): string {
  if (s.status === 'refused') {
    return `Not sent: the throttle refused it.${retryAt ? ` It could send again at ${plainTime(retryAt)}.` : ''}`;
  }
  if (s.status === 'failed') return `Not sent: ${clip(s.result || 'the delivery failed.')}`;
  if (s.toOperator) return 'Delivered to you on Telegram.';
  if (s.result.startsWith('Message queued')) {
    return `Queued in ${s.recipient}'s web chat; they see it when they reconnect.`;
  }
  return `Delivered to chat ${s.recipient} on Telegram.`;
}

export function proactiveToWhy(s: ProactiveSend): Why {
  const why: Why = {
    what: s.toOperator
      ? 'A message it chose to send you'
      : `A message it chose to send to ${s.recipient || 'an unknown recipient'}`,
    by: 'agent',
  };
  if (s.cycleId) {
    why.cycle = s.cycle
      ? toWhyCycle(s.botId, { ...s.cycle, cycleId: s.cycleId })
      : { id: s.cycleId, botId: s.botId };
    const row = s.cycle;
    if (row?.goalTitle && (!s.goalId || !row.goalId || row.goalId === s.goalId)) {
      const id = s.goalId ?? row.goalId ?? undefined;
      why.goal = { ...(id ? { id } : {}), title: row.goalTitle };
    }
  } else {
    why.missing =
      'No record of the cycle that sent it: sent outside the agent loop, or before cycles were logged.';
  }
  const throttle = s.status === 'refused' ? describeThrottle(s.result) : {};
  if (throttle.rule) why.rule = throttle.rule;
  why.outcome = outcomeOf(s, throttle.retryAt);
  return why;
}
