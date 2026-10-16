import type { ToolResult } from './types';

/**
 * Personal-data tools (calendar, mail, finance) answer only the operator.
 * `_requester` is injected by the executor from the inbound speaker; it is
 * absent for the agent loop, cron and collaboration, which act for the bot
 * itself. Present and not the operator: refuse before any external call.
 */
export function requireOperator(args: Record<string, unknown>): ToolResult | null {
  const requester = args._requester as { isOperator?: boolean } | undefined;
  if (!requester || requester.isOperator) return null;
  return {
    success: false,
    content: 'Not available for this user: this tool only answers the operator.',
    failureKind: 'policy',
  };
}
