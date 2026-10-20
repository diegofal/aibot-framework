/**
 * An untrusted cron job pointed at the operator's Telegram chat must not read
 * the operator's personal data. The synthetic message a cron instruction runs
 * carries the chat id as its sender, so resolving a speaker from it made the
 * job look like the verified operator talking (prepass finding, 2026-10-20).
 * Only `actor: 'operator-cron'` (a job the operator created, src/cron/trust.ts)
 * may pass the gate.
 */
import { describe, expect, test } from 'bun:test';
import { buildCronInboundMessage } from '../../src/bot/bot-manager';
import { requesterLookup } from '../../src/bot/conversation-pipeline';
import { requireOperator } from '../../src/tools/operator-gate';

const OPERATOR_CHAT = 9001;

/** What the relay directory answers for the operator's Telegram address. */
function speakerFor(lookup: { channelKind?: string; address: string } | undefined) {
  if (!lookup) return undefined;
  return {
    isOperator: lookup.address === String(OPERATOR_CHAT) && lookup.channelKind === 'telegram',
    channelKind: lookup.channelKind,
    address: lookup.address,
  };
}

describe('a cron instruction never speaks as the operator', () => {
  const msg = buildCronInboundMessage(OPERATOR_CHAT, 'read my mail', 'telegram', { nowMs: 1 });

  test('the synthetic cron message resolves no speaker', () => {
    expect(requesterLookup(msg)).toBeUndefined();
  });

  test("an untrusted job in the operator's chat is refused by the personal-data gate", () => {
    const refused = requireOperator({ _requester: speakerFor(requesterLookup(msg)) });
    expect(refused).not.toBeNull();
  });

  test('a job the operator created (operator-cron) still passes', () => {
    const ok = requireOperator({
      _requester: speakerFor(requesterLookup(msg)),
      _actor: 'operator-cron',
    });
    expect(ok).toBeNull();
  });

  test('a real Telegram message from the operator still resolves as them', () => {
    const real = { ...msg, messageId: 'tg-1', synthetic: undefined };
    expect(speakerFor(requesterLookup(real))?.isOperator).toBe(true);
  });
});
