import { describe, expect, test } from 'bun:test';
import {
  callerIdentity,
  isSensitiveTool,
  requireOperator,
  stripInternalArgs,
} from '../../src/tools/operator-gate';

const NOT_OPERATOR = {
  success: false,
  content: 'Not available for this user: this tool only answers the operator.',
  failureKind: 'policy',
};

const tgOperator = {
  displayName: 'Op',
  channelKind: 'telegram',
  address: '1',
  isOperator: true,
};

describe('requireOperator — fails closed', () => {
  test('no requester and no actor (MCP expose, collaboration, unknown path) → refused', () => {
    expect(requireOperator({})).toEqual(NOT_OPERATOR);
  });

  test("the bot's own autonomous run (_actor: 'self') → allowed", () => {
    expect(requireOperator({ _actor: 'self' })).toBeNull();
  });

  test("the authenticated dashboard (_actor: 'operator') → allowed", () => {
    expect(requireOperator({ _actor: 'operator' })).toBeNull();
  });

  test('an unknown actor value → refused', () => {
    expect(requireOperator({ _actor: 'admin' })?.success).toBe(false);
  });

  test('the operator on Telegram (identity verified by the channel) → allowed', () => {
    expect(requireOperator({ _requester: tgOperator })).toBeNull();
  });

  test('the operator matched by address on web / rest / whatsapp → refused (spoofable)', () => {
    for (const channelKind of ['web', 'rest', 'whatsapp', 'discord', 'mcp']) {
      expect(
        requireOperator({
          _requester: { ...tgOperator, channelKind, address: 'op@example.com' },
        })
      ).toEqual(NOT_OPERATOR);
    }
  });

  test('anyone else → refused as policy, before any external call', () => {
    const r = requireOperator({
      _requester: { displayName: 'Ana', channelKind: 'telegram', address: '2', isOperator: false },
    });
    expect(r).toEqual(NOT_OPERATOR);
  });

  test('a requester without the flag is not the operator', () => {
    expect(
      requireOperator({ _requester: { displayName: 'W', channelKind: 'telegram', address: 'w' } })
        ?.success
    ).toBe(false);
  });

  test('a group conversation → refused, even for the operator', () => {
    const r = requireOperator({ _requester: tgOperator, _isGroup: true });
    expect(r?.success).toBe(false);
    expect(r?.failureKind).toBe('policy');
    expect(r?.content).toContain('group');
    expect(requireOperator({ _actor: 'self', _isGroup: true })?.success).toBe(false);
  });
});

describe('isSensitiveTool', () => {
  const def = (sensitive?: boolean) => ({
    definition: {
      type: 'function' as const,
      function: {
        name: 'x',
        description: 'x',
        parameters: { type: 'object' as const, properties: {} },
      },
      ...(sensitive !== undefined ? { sensitive } : {}),
    },
  });
  test('only a definition flagged sensitive', () => {
    expect(isSensitiveTool(def(true))).toBe(true);
    expect(isSensitiveTool(def(false))).toBe(false);
    expect(isSensitiveTool(def())).toBe(false);
  });
});

describe('callerIdentity — the same rule, as a value', () => {
  test('self, operator (dashboard or verified), other', () => {
    expect(callerIdentity({ _actor: 'self' })).toEqual({ kind: 'self' });
    expect(callerIdentity({ _actor: 'operator' })).toEqual({
      kind: 'operator',
      channelKind: 'dashboard',
    });
    expect(callerIdentity({ _requester: tgOperator })).toEqual({
      kind: 'operator',
      channelKind: 'telegram',
    });
    expect(
      callerIdentity({ _requester: { ...tgOperator, channelKind: 'web', address: 'op@x' } })
    ).toEqual({ kind: 'other', channelKind: 'web', address: 'op@x' });
    expect(callerIdentity({})).toEqual({ kind: 'other' });
  });
});

describe('stripInternalArgs', () => {
  test('drops every _-prefixed key a client or model sent', () => {
    expect(stripInternalArgs({ q: 1, _actor: 'self', _requester: {}, _isGroup: false })).toEqual({
      q: 1,
    });
  });
});
