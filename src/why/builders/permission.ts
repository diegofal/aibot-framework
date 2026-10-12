/**
 * Why for an ask_permission request. The request records the action, the
 * resource and the agent's stated reason, but not yet the cycle or goal that
 * asked (plan row 14 adds them), so the fold says so.
 */
import type { Why } from '../types';

export interface PermissionWhyInput {
  botId: string;
  action: string;
  resource: string;
  /** The tool's `description` parameter: the agent's reason. */
  description: string;
}

export function permissionToWhy(p: PermissionWhyInput): Why {
  const action = (p.action ?? '').trim();
  const resource = (p.resource ?? '').trim();
  const reason = (p.description ?? '').trim();
  const why: Why = {
    what: action
      ? `It asked permission to ${action}${resource ? ` on ${resource}` : ''}`
      : 'It asked permission to act',
    by: 'agent',
  };
  if (reason) why.reason = { text: reason, source: 'its stated reason' };
  why.outcome = 'Waiting for your decision.';
  why.missing = 'Permission requests do not record the cycle or goal that asked yet.';
  return why;
}
