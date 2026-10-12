import { describe, expect, test } from 'bun:test';
import { canRelay } from '../../src/relay/policy';
import type { RelayParty } from '../../src/relay/types';

const ana: RelayParty = { displayName: 'Ana', channelKind: 'telegram', address: '1001' };
const bruno: RelayParty = { displayName: 'Bruno', channelKind: 'telegram', address: '1002' };
const op: RelayParty = {
  displayName: 'Op',
  channelKind: 'telegram',
  address: '7007',
  isOperator: true,
};

describe('canRelay', () => {
  test('the bot itself (no requester) may message anyone', () => {
    expect(canRelay(null, ana, { peerToPeer: false })).toEqual({ allowed: true });
  });

  test('anyone may message the operator', () => {
    expect(canRelay(ana, op, { peerToPeer: false })).toEqual({ allowed: true });
  });

  test('the operator may message anyone', () => {
    expect(canRelay(op, ana, { peerToPeer: false })).toEqual({ allowed: true });
  });

  test('person to person is refused unless peerToPeer is on', () => {
    const refused = canRelay(ana, bruno, { peerToPeer: false });
    expect(refused.allowed).toBe(false);
    if (!refused.allowed) expect(refused.reason).toContain('relay.peerToPeer');
    expect(canRelay(ana, bruno, { peerToPeer: true })).toEqual({ allowed: true });
  });
});
