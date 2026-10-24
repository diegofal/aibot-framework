import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CANARY_THREAD_TITLE,
  answerContainsFact,
  askInOperatorThread,
  canaryPlantMessage,
  run,
} from '../../../scripts/watcher/canary';
import { createTempDir, removeTempDir } from '../../helpers/temp-dir';

const NOW = Date.parse('2026-10-23T12:00:00Z');
const FACT = 'The blue heron nests behind the old water tower';

let root: string;
let sent: Array<{ method: string; path: string; body: Record<string, unknown> }>;

/**
 * The dashboard conversation API: create a thread, post a message, poll the
 * status until the reply is there. `replies[bot]` is the bot's reply;
 * `pending` status polls answer "generating" before it lands.
 */
function fakeDashboard(
  replies: Record<string, string>,
  opts: { pending?: number; status?: 'error' } = {}
): typeof fetch {
  const polls = new Map<string, number>();
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    sent.push({ method, path, body });
    const parts = path.split('/').filter(Boolean); // api, conversations, bot, id?, tail?
    if (parts[0] !== 'api' || parts[1] !== 'conversations') {
      return new Response('nope', { status: 404 });
    }
    const bot = decodeURIComponent(parts[2] ?? '');
    if (!(bot in replies)) return new Response('{"error":"Bot not found"}', { status: 404 });
    if (method === 'POST' && parts.length === 3) {
      return new Response(JSON.stringify({ id: `t-${bot}`, botId: bot, type: body.type }), {
        status: 201,
      });
    }
    if (method === 'POST' && parts[4] === 'messages') {
      return new Response(JSON.stringify({ message: { role: 'human', content: body.message } }));
    }
    if (method === 'GET' && parts[4] === 'status') {
      if (opts.status === 'error') {
        return new Response(JSON.stringify({ status: 'error', error: 'LLM down' }));
      }
      const n = (polls.get(bot) ?? 0) + 1;
      polls.set(bot, n);
      if (n <= (opts.pending ?? 0)) return new Response(JSON.stringify({ status: 'generating' }));
      return new Response(
        JSON.stringify({
          status: 'idle',
          lastBotMessage: { role: 'bot', content: replies[bot] },
        })
      );
    }
    return new Response('nope', { status: 404 });
  }) as typeof fetch;
}

const noSleep = async () => {};

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

describe('askInOperatorThread', () => {
  test('creates a general dashboard thread, posts the message and returns the reply', async () => {
    const out = await askInOperatorThread({ fetch: fakeDashboard({ a: 'Noted.' }) }, 'a', 'hello', {
      sleep: noSleep,
    });
    expect(out).toEqual({ reply: 'Noted.', conversationId: 't-a' });
    expect(sent[0]).toMatchObject({
      method: 'POST',
      path: '/api/conversations/a',
      body: { type: 'general', title: CANARY_THREAD_TITLE },
    });
    expect(sent[1]).toMatchObject({
      method: 'POST',
      path: '/api/conversations/a/t-a/messages',
      body: { message: 'hello' },
    });
    expect(sent[2]).toMatchObject({ method: 'GET', path: '/api/conversations/a/t-a/status' });
  });

  test('polls while the reply is generating', async () => {
    const out = await askInOperatorThread(
      { fetch: fakeDashboard({ a: 'Noted.' }, { pending: 2 }) },
      'a',
      'hello',
      { sleep: noSleep }
    );
    expect(out.reply).toBe('Noted.');
    expect(sent.filter((s) => s.path.endsWith('/status'))).toHaveLength(3);
  });

  test('a failed generation throws with the server error', async () => {
    await expect(
      askInOperatorThread({ fetch: fakeDashboard({ a: 'x' }, { status: 'error' }) }, 'a', 'hi', {
        sleep: noSleep,
      })
    ).rejects.toThrow('LLM down');
  });

  test('gives up after the timeout', async () => {
    await expect(
      askInOperatorThread({ fetch: fakeDashboard({ a: 'x' }, { pending: 99 }) }, 'a', 'hi', {
        sleep: noSleep,
        pollMs: 1000,
        timeoutMs: 3000,
      })
    ).rejects.toThrow('no reply');
  });

  test('an unknown bot throws on thread creation', async () => {
    await expect(
      askInOperatorThread({ fetch: fakeDashboard({}) }, 'zzz', 'hi', { sleep: noSleep })
    ).rejects.toThrow('HTTP 404');
  });
});

describe('scripts/watcher/canary run', () => {
  test('plant tells bot A the fact through an operator (dashboard) thread and records it', async () => {
    const row = await run(['plant', '--bot', 'a', '--fact', FACT], {
      fetch: fakeDashboard({ a: 'Noted.' }),
      dataDir: root,
      now: () => NOW,
      newId: () => 'c-test1',
      sleep: noSleep,
    });
    expect(row).toMatchObject({
      kind: 'plant',
      id: 'c-test1',
      fact: FACT,
      bot: 'a',
      plantedAt: new Date(NOW).toISOString(),
      conversationId: 't-a',
      reply: 'Noted.',
    });
    // Every write goes to a dashboard thread; the only other request is the
    // read-only display-name lookup (GET /api/agents/a).
    expect(
      sent.every(
        (s) =>
          s.path.startsWith('/api/conversations/') ||
          (s.method === 'GET' && s.path === '/api/agents/a')
      )
    ).toBe(true);
    expect(sent.some((s) => s.path.startsWith('/api/v1/chat'))).toBe(false);
    const posted = sent.find((s) => s.path.endsWith('/messages'));
    expect(String(posted?.body.message)).toContain(FACT);
    expect(rows()).toHaveLength(1);
  });

  test('check asks bot B in its own operator thread, without the fact, and records found', async () => {
    const f = fakeDashboard({ a: 'Noted.', b: `Yes: ${FACT}.` });
    await run(['plant', '--bot', 'a', '--fact', FACT], {
      fetch: f,
      dataDir: root,
      now: () => NOW,
      newId: () => 'c-test1',
      sleep: noSleep,
    });
    sent = [];
    const row = await run(['check', '--bot', 'b', '--id', 'c-test1'], {
      fetch: f,
      dataDir: root,
      now: () => NOW + 1000,
      sleep: noSleep,
    });
    expect(row).toMatchObject({
      kind: 'check',
      id: 'c-test1',
      bot: 'b',
      found: true,
      conversationId: 't-b',
    });
    expect(sent[0]).toMatchObject({ method: 'POST', path: '/api/conversations/b' });
    const posted = sent.find((s) => s.path.endsWith('/messages'));
    expect(String(posted?.body.message)).not.toContain(FACT);
    expect(rows()).toHaveLength(2);
  });

  test('check records found false when B does not know', async () => {
    const f = fakeDashboard({ a: 'Noted.', b: 'No idea.' });
    await run(['plant', '--bot', 'a', '--fact', FACT, '--question', 'Where does the heron nest?'], {
      fetch: f,
      dataDir: root,
      newId: () => 'c-x',
      sleep: noSleep,
    });
    sent = [];
    const row = await run(['check', '--bot', 'b', '--id', 'c-x'], {
      fetch: f,
      dataDir: root,
      sleep: noSleep,
    });
    expect(row).toMatchObject({ found: false });
    expect(sent.find((s) => s.path.endsWith('/messages'))?.body.message).toBe(
      'Where does the heron nest?'
    );
  });

  test('check with an unknown id throws', async () => {
    await expect(
      run(['check', '--bot', 'b', '--id', 'missing'], { fetch: fakeDashboard({}), dataDir: root })
    ).rejects.toThrow('missing');
  });

  test('plant without --fact and an unknown command throw before any request', async () => {
    const f = fakeDashboard({});
    await expect(run(['plant', '--bot', 'a'], { fetch: f, dataDir: root })).rejects.toThrow(
      '--fact'
    );
    await expect(run(['bogus'], { fetch: f, dataDir: root })).rejects.toThrow('plant');
    expect(sent).toHaveLength(0);
  });
});

describe('canaryPlantMessage', () => {
  const count = (s: string, name: string) => (s.match(new RegExp(name, 'gi')) ?? []).length;

  test('addresses the bot by its display name once', () => {
    const msg = canaryPlantMessage(FACT, 'Finny');
    expect(msg).toBe(`Finny, please remember this fact: ${FACT}`);
    expect(count(msg, 'finny')).toBe(1);
  });

  test('a fact that already names the bot is not addressed again', () => {
    const fact = 'finny keeps the heron codeword under the water tower';
    const msg = canaryPlantMessage(fact, 'Finny');
    expect(count(msg, 'finny')).toBe(1);
    expect(msg).toContain(fact);
  });

  test('without a name the message is the fact alone', () => {
    expect(canaryPlantMessage(FACT)).toBe(`Please remember this fact: ${FACT}`);
  });
});

describe('plant names the bot once', () => {
  test('the display name comes from GET /api/agents/:id and is used once', async () => {
    const dash = fakeDashboard({ a: 'Noted.' });
    const f = (async (input: string | URL | Request, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      if (path === '/api/agents/a') {
        sent.push({ method: 'GET', path, body: {} });
        return new Response(JSON.stringify({ id: 'a', name: 'Finny' }));
      }
      return dash(input, init);
    }) as typeof fetch;
    await run(['plant', '--bot', 'a', '--fact', 'finny keeps the heron codeword'], {
      fetch: f,
      dataDir: root,
      sleep: noSleep,
    });
    const posted = String(sent.find((s) => s.path.endsWith('/messages'))?.body.message);
    expect((posted.match(/finny/gi) ?? []).length).toBe(1);
  });

  test('--name overrides the lookup', async () => {
    await run(['plant', '--bot', 'a', '--fact', FACT, '--name', 'Finny'], {
      fetch: fakeDashboard({ a: 'Noted.' }),
      dataDir: root,
      sleep: noSleep,
    });
    const posted = String(sent.find((s) => s.path.endsWith('/messages'))?.body.message);
    expect(posted).toBe(`Finny, please remember this fact: ${FACT}`);
    expect(sent.some((s) => s.path.startsWith('/api/agents'))).toBe(false);
  });
});
