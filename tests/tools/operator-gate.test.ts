import { describe, expect, test } from 'bun:test';
import { requireOperator } from '../../src/tools/operator-gate';

describe('requireOperator', () => {
  test('no requester (agent loop, cron, collaboration) → allowed', () => {
    expect(requireOperator({})).toBeNull();
  });

  test('the operator → allowed', () => {
    expect(
      requireOperator({
        _requester: { displayName: 'Op', channelKind: 'telegram', address: '1', isOperator: true },
      })
    ).toBeNull();
  });

  test('anyone else → refused as policy, before any external call', () => {
    const r = requireOperator({
      _requester: { displayName: 'Ana', channelKind: 'telegram', address: '2', isOperator: false },
    });
    expect(r).toEqual({
      success: false,
      content: 'Not available for this user: this tool only answers the operator.',
      failureKind: 'policy',
    });
  });

  test('a requester without the flag is not the operator', () => {
    expect(
      requireOperator({ _requester: { displayName: 'W', channelKind: 'web', address: 'w' } })
        ?.success
    ).toBe(false);
  });
});
