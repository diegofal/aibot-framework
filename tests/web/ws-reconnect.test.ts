import { describe, expect, it } from 'bun:test';
import {
  dashboardSocketUrl,
  openReconnectingSocket,
  reconnectDelay,
} from '../../web/pages/ws-reconnect.js';

describe('reconnectDelay', () => {
  it('doubles from the base and caps at the max', () => {
    const o = { baseMs: 1000, maxMs: 8000 };
    expect([0, 1, 2, 3, 4, 10].map((a) => reconnectDelay(a, o))).toEqual([
      1000, 2000, 4000, 8000, 8000, 8000,
    ]);
  });
});

describe('dashboardSocketUrl', () => {
  it('builds ws/wss urls with optional token and botId', () => {
    expect(dashboardSocketUrl({ protocol: 'http:', host: 'h:3000' }, '/ws/activity')).toBe(
      'ws://h:3000/ws/activity'
    );
    expect(
      dashboardSocketUrl({ protocol: 'https:', host: 'h' }, '/ws/activity', {
        token: 'a b',
        botId: 'bot/1',
      })
    ).toBe('wss://h/ws/activity?token=a+b&botId=bot%2F1');
  });
});

class FakeSocket {
  static all: FakeSocket[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  constructor(public url: string) {
    FakeSocket.all.push(this);
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.onclose?.();
  }
}

function harness() {
  FakeSocket.all = [];
  const timers: { fn: () => void; ms: number }[] = [];
  const messages: string[] = [];
  let n = 0;
  const link = openReconnectingSocket({
    url: () => `ws://x/${n++}`,
    onMessage: (e: { data: string }) => messages.push(e.data),
    createSocket: (u: string) => new FakeSocket(u),
    schedule: (fn: () => void, ms: number) => {
      timers.push({ fn, ms });
      return timers.length;
    },
    cancel: () => {},
    baseMs: 100,
    maxMs: 400,
  });
  return { link, timers, messages };
}

describe('openReconnectingSocket', () => {
  it('reconnects with backoff after a close, re-reading the url', () => {
    const { timers } = harness();
    expect(FakeSocket.all.length).toBe(1);
    FakeSocket.all[0].close();
    expect(timers.map((t) => t.ms)).toEqual([100]);
    timers[0].fn();
    expect(FakeSocket.all.length).toBe(2);
    expect(FakeSocket.all[1].url).toBe('ws://x/1');
    FakeSocket.all[1].onerror?.();
    expect(timers.map((t) => t.ms)).toEqual([100, 200]);
  });

  it('resets the backoff once a connection opens', () => {
    const { timers } = harness();
    FakeSocket.all[0].close();
    timers[0].fn();
    FakeSocket.all[1].close();
    timers[1].fn();
    FakeSocket.all[2].onopen?.();
    FakeSocket.all[2].close();
    expect(timers.map((t) => t.ms)).toEqual([100, 200, 100]);
  });

  it('delivers messages and stops reconnecting after close()', () => {
    const { link, timers, messages } = harness();
    FakeSocket.all[0].onmessage?.({ data: 'hi' });
    expect(messages).toEqual(['hi']);
    link.close();
    expect(FakeSocket.all[0].closed).toBe(true);
    expect(timers).toEqual([]);
  });

  it('a failing constructor still schedules a retry', () => {
    const timers: number[] = [];
    openReconnectingSocket({
      url: () => 'ws://x',
      onMessage: () => {},
      createSocket: () => {
        throw new Error('nope');
      },
      schedule: (_fn: () => void, ms: number) => {
        timers.push(ms);
        return 1;
      },
      cancel: () => {},
      baseMs: 50,
    });
    expect(timers).toEqual([50]);
  });
});
