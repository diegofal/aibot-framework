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

const TRUSTED_ACTORS: ReadonlySet<unknown> = new Set<ToolActor>(['self', 'operator']);

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
  if (TRUSTED_ACTORS.has(args._actor)) return null;
  const requester = args._requester as { isOperator?: boolean; channelKind?: string } | undefined;
  if (requester?.isOperator === true && OPERATOR_VERIFIED_CHANNELS.has(requester.channelKind)) {
    return null;
  }
  return refuse('Not available for this user: this tool only answers the operator.');
}

/**
 * A personal-data tool (`ToolDefinition.sensitive`): never exposed over MCP,
 * never handed to another bot in a collaboration, and its args and results
 * stay out of the tool audit and the activity stream.
 */
export function isSensitiveTool(tool: Pick<Tool, 'definition'>): boolean {
  return tool.definition.sensitive === true;
}
