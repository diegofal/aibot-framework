/**
 * Whose turn may see the watcher's "## Your current state" (the running
 * cycle's plan, goal and the fleet's focus): only the operator on a surface
 * that verified the identity, the same rule as `callerIdentity` in
 * `src/tools/operator-gate.ts`.
 */
import { describe, expect, test } from 'bun:test';
import { isOperatorTurn } from '../../src/bot/conversation-pipeline';

const op = {
  displayName: 'Ana',
  channelKind: 'telegram' as const,
  address: '42',
  isOperator: true,
};

describe('isOperatorTurn', () => {
  test('the operator in a private Telegram chat', () => {
    expect(isOperatorTurn(op, { isGroup: false })).toBe(true);
  });

  test('the dashboard thread (actor operator)', () => {
    expect(isOperatorTurn(undefined, { isGroup: false, actor: 'operator' })).toBe(true);
  });

  test('never in a group, not even the operator', () => {
    expect(isOperatorTurn(op, { isGroup: true })).toBe(false);
  });

  test('an operator claimed on web / REST (unverified) is not', () => {
    expect(isOperatorTurn({ ...op, channelKind: 'web' }, { isGroup: false })).toBe(false);
  });

  test('another user, nobody, or an operator cron run is not', () => {
    expect(isOperatorTurn({ ...op, isOperator: false }, { isGroup: false })).toBe(false);
    expect(isOperatorTurn(undefined, { isGroup: false })).toBe(false);
    expect(isOperatorTurn(undefined, { isGroup: false, actor: 'operator-cron' })).toBe(false);
  });
});
