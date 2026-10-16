import type { Tool, ToolResult } from './types';

/**
 * Who a tool call runs for when there is no person to judge, injected by the
 * executor as `_actor` (always overwriting what the model sent):
 * - `self`: the bot's own autonomous run (agent-loop cycle and feedback
 *   executors, task workers). Not trusted with personal data: anyone who
 *   talks to the bot can plant goals and tasks that such a run then works on.
 *   Used only to let the bot manage its own cron jobs.
 * - `operator`: the authenticated dashboard (an admin / single-tenant thread).
 * - `operator-cron`: a cron instruction of a job the operator created
 *   (`cronJobRunsForOperator`, `src/cron/trust.ts`), firing in the operator's
 *   own chat.
 * Absent everywhere else (conversations, collaboration, MCP expose, ...).
 */
export type ToolActor = 'self' | 'operator' | 'operator-cron';

/** The actors personal-data tools answer. */
const OPERATOR_ACTORS: ReadonlySet<unknown> = new Set<ToolActor>(['operator', 'operator-cron']);

/**
 * Channels whose sender id the channel itself authenticates *and* where the
 * operator is matched on that id (`operator.telegramChatId`). On web / REST the
 * sender id is client-supplied and the operator is matched by email, so anyone
 * can claim it; WhatsApp / Discord have no operator address of their own (the
 * match would come from the directory), so they are not trusted here.
 */
const OPERATOR_VERIFIED_CHANNELS: ReadonlySet<unknown> = new Set(['telegram']);

const refuse = (content: string): ToolResult => ({
  success: false,
  content,
  failureKind: 'policy',
});

/**
 * Who is calling, recorded on cron jobs (`requestedBy`) and used to scope the
 * cron tool: the bot's own run (`self`; an `operator-cron` run too, so what it
 * creates is the bot's, not the operator's), the operator (the dashboard, or
 * the operator on a channel that verified the identity, in private), or anyone
 * else (with the channel and address the executor knew). A group call is
 * always `other`.
 */
export type CallerIdentity =
  | { kind: 'self' }
  | { kind: 'operator'; channelKind: string }
  | { kind: 'other'; channelKind?: string; address?: string };

export function callerIdentity(args: Record<string, unknown>): CallerIdentity {
  const requester = args._requester as
    | { isOperator?: boolean; channelKind?: string; address?: string }
    | undefined;
  const other = (): CallerIdentity => ({
    kind: 'other',
    ...(typeof requester?.channelKind === 'string' ? { channelKind: requester.channelKind } : {}),
    ...(typeof requester?.address === 'string' ? { address: requester.address } : {}),
  });
  if (args._isGroup === true) return other();
  if (args._actor === 'self' || args._actor === 'operator-cron') return { kind: 'self' };
  if (args._actor === 'operator') return { kind: 'operator', channelKind: 'dashboard' };
  if (requester?.isOperator === true && OPERATOR_VERIFIED_CHANNELS.has(requester.channelKind)) {
    return { kind: 'operator', channelKind: String(requester.channelKind) };
  }
  return other();
}

/** The bot itself or the operator: who may point a cron job at another chat. */
export function isTrustedCaller(args: Record<string, unknown>): boolean {
  return callerIdentity(args).kind !== 'other';
}

/**
 * Personal-data tools (calendar, mail, WhatsApp exports, operator-only HTTP
 * APIs) answer only the operator. The single rule, failing closed:
 * - never in a group conversation (`_isGroup`), not even for the operator;
 * - allowed for `_actor` `operator` (dashboard) or `operator-cron` (a job the
 *   operator created, in the operator's chat);
 * - allowed for a `_requester` who is the operator on a channel that verified
 *   the identity (Telegram);
 * - refused for everything else: the bot's own runs (`self`: cycles, feedback,
 *   workers), the MCP expose server, collaboration and delegation, any call
 *   without requester or actor.
 */
export function requireOperator(args: Record<string, unknown>): ToolResult | null {
  if (args._isGroup === true) {
    return refuse(
      'Not available in a group chat: this tool only answers the operator, in private.'
    );
  }
  if (OPERATOR_ACTORS.has(args._actor)) return null;
  if (callerIdentity(args).kind === 'operator') return null;
  return refuse('Not available for this user: this tool only answers the operator.');
}

/**
 * Args without the internal `_` keys (`_actor`, `_requester`, `_isGroup`, …),
 * for routes that call `tool.execute` directly with client or model args: only
 * the executor may set those.
 */
export function stripInternalArgs(args: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(args).filter(([k]) => !k.startsWith('_')));
}

/**
 * A personal-data tool (`ToolDefinition.sensitive`): never exposed over MCP,
 * never handed to another bot in a collaboration, and its args and results
 * stay out of the tool audit and the activity stream.
 */
export function isSensitiveTool(tool: Pick<Tool, 'definition'>): boolean {
  return tool.definition.sensitive === true;
}

/** A sensitive tool's args as stored anywhere: the keys, values `[redacted]`; `_` args dropped. */
export function redactArgs(args: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.keys(args)
      .filter((k) => !k.startsWith('_'))
      .map((k) => [k, '[redacted]'])
  );
}

/** A sensitive tool's result as stored anywhere: its length only. */
export function redactResult(result: string): string {
  return `[redacted: ${result.length} chars]`;
}
