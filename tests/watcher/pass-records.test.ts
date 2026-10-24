import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LLMClient } from '../../src/core/llm-client';
import { DailyBudget } from '../../src/watcher/budget';
import { instrumented } from '../../src/watcher/llm';
import {
  PASS_RECORD_LINE_MAX,
  PassRecords,
  isPassRecordId,
  passRecordsFor,
  passesDir,
  redactPassPrompt,
} from '../../src/watcher/pass-records';

let dir: string;
let t: number;
const DAY = 86_400_000;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'watcher-passes-'));
  t = Date.parse('2026-10-24T10:00:00Z');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const base = {
  caller: 'watcher:notice' as const,
  tier: 'notice' as const,
  model: 'claude-haiku-5-5',
  backend: 'claude-cli' as const,
  ok: true,
  durationMs: 1200,
  tokens: 900,
  prompt: { system: 'sys', user: 'user' },
  response: '{"keep":[]}',
};

describe('redactPassPrompt', () => {
  test('splits system from the rest and clips every line to the line cap', () => {
    const long = `- [i-1] from the operator · ${'x'.repeat(1000)}`;
    const out = redactPassPrompt([
      { role: 'system', content: 'You are the watcher.' },
      { role: 'user', content: `events:\n${long}` },
    ]);
    expect(out.system).toBe('You are the watcher.');
    const lines = out.user.split('\n');
    expect(lines[0]).toBe('events:');
    expect(lines[1].length).toBeLessThanOrEqual(PASS_RECORD_LINE_MAX + 1);
    expect(lines[1].endsWith('…')).toBe(true);
  });
});

describe('PassRecords', () => {
  test('write → one file with the fields; get and list read it back', () => {
    const records = new PassRecords({ dir: passesDir(dir), now: () => t });
    const id = records.write({
      ...base,
      prompt: { system: 'sys', user: 'cycle 5f0c2a1e-1111-2222-3333-444455556666 ran' },
    });
    expect(id && isPassRecordId(id)).toBe(true);
    expect(readdirSync(passesDir(dir))).toEqual([`${id}.json`]);
    const rec = records.get(id as string);
    expect(rec?.caller).toBe('watcher:notice');
    expect(rec?.response).toBe('{"keep":[]}');
    expect(rec?.endedAt).toBe(new Date(t).toISOString());
    expect(rec?.startedAt).toBe(new Date(t - 1200).toISOString());
    expect(rec?.refs?.cycleIds).toEqual(['5f0c2a1e-1111-2222-3333-444455556666']);
    const list = records.list(10);
    expect(list).toHaveLength(1);
    expect(list[0]).not.toHaveProperty('prompt');
    expect(list[0].promptChars).toBe(
      (rec?.prompt.system.length ?? 0) + (rec?.prompt.user.length ?? 0)
    );
  });

  test('get rejects an id that is not a record id (no path traversal)', () => {
    const records = new PassRecords({ dir: passesDir(dir), now: () => t });
    expect(records.get('../../config')).toBeUndefined();
    expect(isPassRecordId('notice-1761300000000-ab12')).toBe(true);
    expect(isPassRecordId('notice-1761300000000-ab12.json')).toBe(false);
  });

  test('retention: files older than 14 days and beyond the cap are pruned on write', () => {
    const records = new PassRecords({ dir: passesDir(dir), now: () => t, maxFiles: 3 });
    const old = records.write(base) as string;
    t += 15 * DAY;
    const ids: Array<string | undefined> = [];
    for (let i = 0; i < 3; i++) {
      ids.push(records.write(base));
      t += 1;
    }
    const last = records.write(base) as string;
    const files = readdirSync(passesDir(dir));
    expect(files).not.toContain(`${old}.json`);
    expect(files).toHaveLength(3);
    expect(files).toContain(`${last}.json`);
    expect(files).not.toContain(`${ids[0]}.json`);
  });

  test('list is newest first and skips unreadable files', () => {
    const records = new PassRecords({ dir: passesDir(dir), now: () => t });
    const a = records.write(base);
    t += 1000;
    const b = records.write({ ...base, caller: 'watcher:integrate', tier: 'integrate' });
    writeFileSync(join(passesDir(dir), 'notice-1-abcd.json'), 'not json');
    expect(records.list(10).map((r) => r.id)).toEqual([b, a]);
  });

  test('a write that fails never throws', () => {
    writeFileSync(join(dir, 'blocked'), 'a file where the dir should be');
    const records = new PassRecords({ dir: join(dir, 'blocked'), now: () => t });
    expect(records.write(base)).toBeUndefined();
  });
});

describe('instrumented keeps what the model saw and said', () => {
  const tier = (text: string) => ({
    client: {
      backend: 'claude-cli',
      generate: async () => ({ text: '' }),
      chat: async () => ({ text, usage: { totalTokens: 42, costUsd: 0.01, model: 'm' } }),
    } as unknown as LLMClient,
    model: 'claude-haiku-5-5',
    backend: 'claude-cli' as const,
  });
  const budget = () =>
    new DailyBudget({
      dir,
      now: () => t,
      limits: () => ({
        notice: { maxPerDay: 5 },
        integrate: { maxPerDay: 5, maxTokensPerDay: 1e6 },
      }),
    });

  test('a call writes one record next to the budget; the result carries its id', async () => {
    const client = instrumented(tier('{"keep":[]}'), {
      tier: 'notice',
      caller: 'watcher:notice',
      budget: budget(),
      now: () => t,
    });
    const res = await client.chat([
      { role: 'system', content: 'S' },
      { role: 'user', content: 'U' },
    ]);
    expect(res.ok).toBe(true);
    const id = res.ok ? res.recordId : undefined;
    expect(id && isPassRecordId(id)).toBe(true);
    const rec = passRecordsFor(dir).get(id as string);
    expect(rec?.prompt).toEqual({ system: 'S', user: 'U' });
    expect(rec?.response).toBe('{"keep":[]}');
    expect(rec?.tokens).toBe(42);
    expect(rec?.costUsd).toBe(0.01);
    expect(rec?.durationMs).toBe(res.ok ? res.durationMs : -1);
  });

  test('a failed call is kept with its error; `records: null` keeps nothing', async () => {
    const failing = {
      client: {
        chat: async () => {
          throw new Error('boom');
        },
      } as unknown as LLMClient,
      model: 'm',
      backend: 'claude-cli' as const,
    };
    const res = await instrumented(failing, {
      tier: 'notice',
      caller: 'watcher:notice',
      budget: budget(),
    }).chat([{ role: 'user', content: 'U' }]);
    expect(res.ok).toBe(false);
    const [rec] = passRecordsFor(dir).list(5);
    expect(rec.ok).toBe(false);
    expect(rec.error).toBe('boom');

    rmSync(passesDir(dir), { recursive: true, force: true });
    await instrumented(tier('x'), {
      tier: 'notice',
      caller: 'watcher:notice',
      budget: budget(),
      records: null,
    }).chat([{ role: 'user', content: 'U' }]);
    expect(existsSync(passesDir(dir))).toBe(false);
  });
});
