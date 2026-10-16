import type { Tool, ToolResult } from './types';

/**
 * Who a tool call runs for when there is no person to judge, injected by the
 * executor as `_actor` (always overwriting what the model sent):
 * - `self`: the bot's own autonomous run — agent-loop cycle and feedback
 *   executors, task workers, and a cron instruction whose reply goes to the
 *   operator's own chat.
 * - `operator`: the authenticated dashboard (an operator thread).
 * Absent everywhere else (conversations, collaboration, MCP expose, …).
 */
export type ToolActor = 'self' | 'operator';

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
 * Who is calling, by the gate's rule: the bot's own run (`_actor: 'self'`),
 * the operator (the dashboard, `_actor: 'operator'`, or the operator on a
 * channel that verified the identity), or anyone else (with the channel and
 * address the executor knew, if any). Recorded on cron jobs (`requestedBy`).
 */
export type CallerIdentity =
  | { kind: 'self' }
  | { kind: 'operator'; channelKind: string }
  | { kind: 'other'; channelKind?: string; address?: string };

export function callerIdentity(args: Record<string, unknown>): CallerIdentity {
  if (args._actor === 'self') return { kind: 'self' };
  if (args._actor === 'operator') return { kind: 'operator', channelKind: 'dashboard' };
  const requester = args._requester as
    | { isOperator?: boolean; channelKind?: string; address?: string }
    | undefined;
  if (requester?.isOperator === true && OPERATOR_VERIFIED_CHANNELS.has(requester.channelKind)) {
    return { kind: 'operator', channelKind: String(requester.channelKind) };
  }
  return {
    kind: 'other',
    ...(typeof requester?.channelKind === 'string' ? { channelKind: requester.channelKind } : {}),
    ...(typeof requester?.address === 'string' ? { address: requester.address } : {}),
  };
}

/** The bot itself or the operator: what personal-data tools (and cron targets) require. */
export function isTrustedCaller(args: Record<string, unknown>): boolean {
  return callerIdentity(args).kind !== 'other';
}

/**
 * Personal-data tools (calendar, mail, WhatsApp exports, operator-only HTTP
 * APIs) answer only the operator. The single rule, failing closed:
 * - never in a group conversation (`_isGroup`), not even for the operator;
 * - allowed for a trusted `_actor` (the bot's own run, the dashboard);
 * - allowed for a `_requester` who is the operator on a channel that verified
 *   the identity (Telegram);
 * - refused for everything else, including a call with neither — the MCP
 *   expose server, collaboration and delegation, and any path not listed.
 */
export function requireOperator(args: Record<string, unknown>): ToolResult | null {
  if (args._isGroup === true) {
    return refuse(
      'Not available in a group chat: this tool only answers the operator, in private.'
    );
  }
  if (isTrustedCaller(args)) return null;
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
