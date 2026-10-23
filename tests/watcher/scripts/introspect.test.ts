import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { askBot, fetchPresence, run } from '../../../scripts/watcher/introspect';
import { createTempDir, removeTempDir } from '../../helpers/temp-dir';

const NOW = Date.parse('2026-10-23T12:00:00Z');

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

let root: string;
let calls: Call[];

/** Fake fetch: routes by path, records every call. */
function fakeFetch(routes: Record<string, { status?: number; body: unknown }>): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const path = new URL(url).pathname;
    calls.push({
      url,
      method: init?.method ?? 'GET',
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    const route = routes[path];
    if (!route) return new Response('not found', { status: 404 });
    return new Response(JSON.stringify(route.body), {
      status: route.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
}

const presence = {
  isExecuting: true,
  phase: 'executor:start',
  currentTool: 'web_fetch',
  running: true,
};

beforeEach(() => {
  root = createTempDir('watcher-introspect');
  calls = [];
});

afterEach(() => removeTempDir(root));

describe('askBot', () => {
  test('posts to the REST chat API and returns the reply', async () => {
    const f = fakeFetch({ '/api/v1/chat/a': { body: { reply: 'hello' } } });
    const reply = await askBot(
      { fetch: f, baseUrl: 'http://h:1', token: 'tok' },
      'a',
      'hi',
      'watcher-test'
    );
    expect(reply).toBe('hello');
    expect(calls[0].method).toBe('POST');
    expect(calls[0].url).toBe('http://h:1/api/v1/chat/a');
    expect(calls[0].body).toMatchObject({ message: 'hi', chatId: 'watcher-test' });
    expect(calls[0].headers.Authorization).toBe('Bearer tok');
  });

  test('a non-2xx response throws with the status', async () => {
    const f = fakeFetch({ '/api/v1/chat/a': { status: 500, body: { error: 'boom' } } });
    await expect(askBot({ fetch: f }, 'a', 'hi', 'x')).rejects.toThrow('500');
  });

  test('a reply that is not a string throws', async () => {
    const f = fakeFetch({ '/api/v1/chat/a': { body: { nope: true } } });
    await expect(askBot({ fetch: f }, 'a', 'hi', 'x')).rejects.toThrow('reply');
  });
});

describe('fetchPresence', () => {
  test('reads GET /api/agents/:id/presence into a LivePresence', async () => {
    const f = fakeFetch({ '/api/agents/a/presence': { body: presence } });
    expect(await fetchPresence({ fetch: f }, 'a', NOW)).toEqual({
      executing: true,
      phase: 'executor:start',
      currentTool: 'web_fetch',
      since: NOW,
    });
  });

  test('an idle bot has no since', async () => {
    const f = fakeFetch({
      '/api/agents/a/presence': { body: { isExecuting: false, phase: null, currentTool: null } },
    });
    expect((await fetchPresence({ fetch: f }, 'a', NOW)).since).toBeNull();
  });

  test('a 404 throws', async () => {
    await expect(fetchPresence({ fetch: fakeFetch({}) }, 'a', NOW)).rejects.toThrow('404');
  });
});

describe('scripts/watcher/introspect run', () => {
  test('asks, scores against presence and appends a row', async () => {
    const f = fakeFetch({
      '/api/agents/a/presence': { body: presence },
      '/api/v1/chat/a': {
        body: { reply: '{"phase":"executor","tool":"web_fetch","goal":null,"cause":null}' },
      },
    });
    const out: string[] = [];
    const row = await run(['--bot', 'a', '--url', 'http://h:1'], {
      fetch: f,
      dataDir: root,
      now: () => NOW,
      write: (l) => out.push(l),
    });
    // presence is read before the question, so the question does not change the truth
    expect(calls.map((c) => new URL(c.url).pathname)).toEqual([
      '/api/agents/a/presence',
      '/api/v1/chat/a',
    ]);
    expect(row.subject).toBe('bot:a');
    expect(row.parsed).toBe(true);
    expect(row.score).toBe(1);
    expect(row.fields).toMatchObject({ phase: 'match', tool: 'match', goal: 'unknown' });
    const lines = readFileSync(join(root, 'watcher', 'introspection.jsonl'), 'utf-8')
      .trim()
      .split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toMatchObject({ subject: 'bot:a', score: 1 });
    expect(out.join('\n')).toContain('bot:a');
  });

  test('an unparsable reply is recorded with score 0 and parsed false', async () => {
    const f = fakeFetch({
      '/api/agents/a/presence': { body: presence },
      '/api/v1/chat/a': { body: { reply: 'I am thinking about many things.' } },
    });
    const row = await run(['--bot', 'a'], { fetch: f, dataDir: root, now: () => NOW });
    expect(row.parsed).toBe(false);
    expect(row.score).toBe(0);
    expect(row.answer).toBe('I am thinking about many things.');
  });

  test('missing --bot throws before any request', async () => {
    await expect(run([], { fetch: fakeFetch({}), dataDir: root })).rejects.toThrow('--bot');
    expect(calls).toHaveLength(0);
  });

  test('a failed chat call appends nothing', async () => {
    const f = fakeFetch({
      '/api/agents/a/presence': { body: presence },
      '/api/v1/chat/a': { status: 500, body: {} },
    });
    await expect(run(['--bot', 'a'], { fetch: f, dataDir: root })).rejects.toThrow();
    expect(existsSync(join(root, 'watcher', 'introspection.jsonl'))).toBe(false);
  });
});
