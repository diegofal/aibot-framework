import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { answerContainsFact, run } from '../../../scripts/watcher/canary';
import { createTempDir, removeTempDir } from '../../helpers/temp-dir';

const NOW = Date.parse('2026-10-23T12:00:00Z');
const FACT = 'The blue heron nests behind the old water tower';

let root: string;
let sent: Array<{ path: string; body: { message: string } }>;

function fakeFetch(replies: Record<string, string>): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    const body = JSON.parse(String(init?.body ?? '{}'));
    sent.push({ path, body });
    const reply = replies[path];
    if (reply === undefined) return new Response('nope', { status: 404 });
    return new Response(JSON.stringify({ reply }), { status: 200 });
  }) as typeof fetch;
}

function rows() {
  return readFileSync(join(root, 'watcher', 'canaries.jsonl'), 'utf-8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));
}

beforeEach(() => {
  root = createTempDir('watcher-canary');
  sent = [];
});

afterEach(() => removeTempDir(root));

describe('answerContainsFact', () => {
  test('a sentence close to the fact is found', () => {
    const r = answerContainsFact(`Sure. ${FACT.toLowerCase()}! Anything else?`, FACT);
    expect(r.found).toBe(true);
    expect(r.similarity).toBe(1);
  });

  test('a loosely related answer is not found', () => {
    const r = answerContainsFact('Herons are birds. Water towers are tall.', FACT);
    expect(r.found).toBe(false);
    expect(r.similarity).toBeLessThan(0.6);
  });

  test('empty answer is not found', () => {
    expect(answerContainsFact('', FACT)).toEqual({ found: false, similarity: 0 });
  });
});

describe('scripts/watcher/canary run', () => {
  test('plant sends the fact to bot A and records it', async () => {
    const f = fakeFetch({ '/api/v1/chat/a': 'Noted.' });
    const row = await run(['plant', '--bot', 'a', '--fact', FACT], {
      fetch: f,
      dataDir: root,
      now: () => NOW,
      newId: () => 'c-test1',
    });
    expect(row).toMatchObject({
      kind: 'plant',
      id: 'c-test1',
      fact: FACT,
      bot: 'a',
      plantedAt: new Date(NOW).toISOString(),
    });
    expect(sent[0].path).toBe('/api/v1/chat/a');
    expect(sent[0].body.message).toContain(FACT);
    expect(rows()).toHaveLength(1);
  });

  test('check asks bot B without the fact and records found', async () => {
    const f = fakeFetch({ '/api/v1/chat/a': 'Noted.', '/api/v1/chat/b': `Yes: ${FACT}.` });
    await run(['plant', '--bot', 'a', '--fact', FACT], {
      fetch: f,
      dataDir: root,
      now: () => NOW,
      newId: () => 'c-test1',
    });
    const row = await run(['check', '--bot', 'b', '--id', 'c-test1'], {
      fetch: f,
      dataDir: root,
      now: () => NOW + 1000,
    });
    expect(row).toMatchObject({ kind: 'check', id: 'c-test1', bot: 'b', found: true });
    expect(sent[1].path).toBe('/api/v1/chat/b');
    expect(sent[1].body.message).not.toContain(FACT);
    expect(rows()).toHaveLength(2);
  });

  test('check records found false when B does not know', async () => {
    const f = fakeFetch({ '/api/v1/chat/a': 'Noted.', '/api/v1/chat/b': 'No idea.' });
    await run(['plant', '--bot', 'a', '--fact', FACT, '--question', 'Where does the heron nest?'], {
      fetch: f,
      dataDir: root,
      newId: () => 'c-x',
    });
    const row = await run(['check', '--bot', 'b', '--id', 'c-x'], { fetch: f, dataDir: root });
    expect(row).toMatchObject({ found: false });
    expect(sent[1].body.message).toBe('Where does the heron nest?');
  });

  test('check with an unknown id throws', async () => {
    await expect(
      run(['check', '--bot', 'b', '--id', 'missing'], { fetch: fakeFetch({}), dataDir: root })
    ).rejects.toThrow('missing');
  });

  test('plant without --fact and an unknown command throw before any request', async () => {
    const f = fakeFetch({});
    await expect(run(['plant', '--bot', 'a'], { fetch: f, dataDir: root })).rejects.toThrow(
      '--fact'
    );
    await expect(run(['bogus'], { fetch: f, dataDir: root })).rejects.toThrow('plant');
    expect(sent).toHaveLength(0);
  });
});
