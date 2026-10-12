import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RELAY_PROMPT_MAX_ITEMS, renderRelaySections } from '../../src/relay/prompt';
import { RelayStore } from '../../src/relay/store';
import type { NewRelayRecord, RelayParty } from '../../src/relay/types';
import { silentLogger } from './fixture';

const ana: RelayParty = { displayName: 'Ana', channelKind: 'telegram', address: '1001' };
const op: RelayParty = {
  displayName: 'Op',
  channelKind: 'telegram',
  address: '9001',
  isOperator: true,
};

let dir: string;
let store: RelayStore;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'relay-prompt-'));
  store = new RelayStore(dir, silentLogger);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function relay(over: Partial<NewRelayRecord>) {
  return store.create({
    botId: 'bot1',
    from: ana,
    to: op,
    text: 'Q',
    expectsReply: true,
    status: 'delivered',
    delivery: { status: 'delivered', channel: 'telegram', attempts: [] },
    dedupeKey: Math.random().toString(),
    ...over,
  });
}

describe('renderRelaySections', () => {
  test('nothing to show → empty string', () => {
    expect(renderRelaySections(store, 'bot1', op)).toBe('');
  });

  test('relays waiting on the speaker list id, sender, text and age with the replyTo instruction', () => {
    const r = relay({ text: '¿Quién soy?' });
    const out = renderRelaySections(store, 'bot1', op, r.createdAt + 2 * 3_600_000);
    expect(out).toContain("## Messages waiting for this person's answer");
    expect(out).toContain(`- ${r.id} · from Ana · 2h ago: "¿Quién soy?"`);
    expect(out).toContain('call send_message with replyTo=<id>');
    expect(out).not.toContain('asked you to pass on');
    expect(out).toContain('Delivery facts come only from these records');
  });

  test("the speaker's own relays show their status and the answer when there is one", () => {
    const a = relay({ text: 'Primera' });
    const answer = store.create({
      botId: 'bot1',
      from: op,
      to: ana,
      text: 'Sos Ana',
      expectsReply: false,
      replyToRelayId: a.id,
      status: 'delivered',
      delivery: { status: 'delivered', attempts: [] },
      dedupeKey: 'x',
    });
    store.update('bot1', a.id, {
      status: 'answered',
      answeredAt: Date.now(),
      answerRelayId: answer.id,
    });
    const q = relay({ text: 'Segunda', status: 'queued' });
    const f = relay({ text: 'Tercera', status: 'failed', expectsReply: false });
    const out = renderRelaySections(store, 'bot1', ana, Date.now());
    expect(out).toContain('## Messages this person asked you to pass on (last 7 days)');
    expect(out).toContain(`- ${a.id} → Op · just now · answered: "Sos Ana"`);
    expect(out).toContain(`- ${q.id} → Op · just now · NOT delivered (stored, nobody notified)`);
    expect(out).toContain(`- ${f.id} → Op · just now · FAILED, nothing was sent`);
    // The answer relay is addressed to Ana but expects no reply: not "waiting".
    expect(out).not.toContain("waiting for this person's answer");
  });

  test('caps the lists and truncates long texts', () => {
    for (let i = 0; i < RELAY_PROMPT_MAX_ITEMS + 3; i++) relay({ text: `${'x'.repeat(200)}${i}` });
    const out = renderRelaySections(store, 'bot1', op);
    expect(out.match(/^- r-/gm)).toHaveLength(RELAY_PROMPT_MAX_ITEMS);
    expect(out).toContain('…"');
  });

  test('older than 7 days is left out of the sent list', () => {
    const r = relay({ expectsReply: false });
    expect(renderRelaySections(store, 'bot1', ana, r.createdAt + 8 * 86_400_000)).toBe('');
  });
});
