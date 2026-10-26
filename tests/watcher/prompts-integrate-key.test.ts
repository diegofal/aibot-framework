import { describe, expect, test } from 'bun:test';
import {
  type IntegratePromptInput,
  buildIntegratePrompt,
  integratePromptKey,
} from '../../src/watcher/prompts';
import type { Neuron } from '../../src/watcher/types';

const neuron = (id: string, kind: Neuron['kind'], text: string, bots = ['b1']): Neuron => ({
  id,
  kind,
  text,
  support: { bots },
  createdBy: 'watcher',
  createdAt: '2026-10-22T00:00:00.000Z',
  lastActivatedAt: '2026-10-22T00:00:00.000Z',
  activations: 2,
});

const event = (id: string, at: string, salience: number, what = 'web_fetch failed in Jarvis') => ({
  id,
  botId: 'b1',
  bot: 'Jarvis',
  at,
  what,
  salience,
  reasons: ['tool error'],
  fromOperator: false,
});

function input(over: Partial<IntegratePromptInput> = {}): IntegratePromptInput {
  return {
    events: [event('b-11111111', '2026-10-23T10:00:00.000Z', 0.8)],
    fresh: [neuron('n-fresh001', 'pattern', 'wiley.com blocks the fetcher')],
    neighbourhood: [neuron('n-near0001', 'topic', 'Publisher research', ['b2'])],
    goals: [{ id: 'n-goal0001', botId: 'b2', bot: 'Scout', text: 'Map the publishers' }],
    insights: [neuron('n-ins00001', 'insight', 'Two bots chase the same publishers')],
    predictions: [
      { id: 'n-pred0002', text: 'Scout finishes the map', dueAt: '2026-10-25T00:00:00.000Z' },
    ],
    bots: [
      { id: 'b1', name: 'Jarvis', broadcastsToday: 1 },
      { id: 'b2', name: 'Scout', broadcastsToday: 0 },
    ],
    broadcastCap: 3,
    interoception: {
      fleetKarmaAvg: 51.2,
      breakerOpen: [],
      budgetUsedToday: { notice: 4, integrate: 1, tokens: 9000, usd: 0.31 },
      operatorSilenceHours: 2.5,
      bufferSalience: 1.4,
      lastIntegrateAgoMs: 3_600_000,
    },
    attention: {
      phase: 'integrate',
      focusNeuronIds: ['n-fresh001'],
      focus: [{ id: 'n-fresh001', kind: 'pattern', text: 'wiley.com blocks the fetcher' }],
      items: [
        {
          id: 'b-22222222',
          botId: 'b1',
          reasons: ['tool error'],
          what: 'web_fetch failed in Jarvis',
          salience: 0.8,
          touched: [],
        },
      ],
    },
    ...over,
  };
}

const key = (i: IntegratePromptInput) => integratePromptKey(buildIntegratePrompt(i));

describe('integratePromptKey', () => {
  test('ignores what changes without the content changing', () => {
    const base = key(input());
    // A re-occurrence of the same event: new buffer id, new time, new salience.
    expect(key(input({ events: [event('b-99999999', '2026-10-24T03:00:00.000Z', 0.6)] }))).toBe(
      base
    );
    // "How I am" numbers drift with every call and every minute.
    expect(
      key(
        input({
          interoception: {
            fleetKarmaAvg: 49.9,
            breakerOpen: [],
            budgetUsedToday: { notice: 12, integrate: 3, tokens: 31000, usd: 1.02 },
            operatorSilenceHours: 7.1,
            bufferSalience: 0.2,
            lastIntegrateAgoMs: 9_000_000,
          },
        })
      )
    ).toBe(base);
    // What I am attending to: the phase and the buffer items' ids and salience.
    expect(
      key(
        input({
          attention: {
            phase: 'sense',
            focusNeuronIds: ['n-fresh001'],
            focus: [{ id: 'n-fresh001', kind: 'pattern', text: 'wiley.com blocks the fetcher' }],
            items: [
              {
                id: 'b-33333333',
                botId: 'b1',
                reasons: ['tool error'],
                what: 'web_fetch failed in Jarvis',
                salience: 0.3,
                touched: [],
              },
            ],
          },
        })
      )
    ).toBe(base);
    // "Something is wrong" figures drift; its presence is what matters.
    const wrong = (s: string) => key(input({ somethingWrong: s }));
    expect(wrong("The fleet's mean karma fell from 60 to 52 within 24 h.")).toBe(
      wrong("The fleet's mean karma fell from 61.5 to 50 within 24 h.")
    );
  });

  test('changes when anything the model reasons on changes', () => {
    const base = key(input());
    const changed: Array<Partial<IntegratePromptInput>> = [
      { events: [event('b-11111111', '2026-10-23T10:00:00.000Z', 0.8, 'exec failed in Jarvis')] },
      {
        events: [
          event('b-11111111', '2026-10-23T10:00:00.000Z', 0.8),
          event('b-11111112', '2026-10-23T10:00:00.000Z', 0.8),
        ],
      },
      { fresh: [] },
      { neighbourhood: [neuron('n-near0002', 'topic', 'Publisher research', ['b2'])] },
      { goals: [] },
      { insights: [neuron('n-ins00002', 'insight', 'A newer insight')] },
      { predictions: [] },
      {
        bots: [
          { id: 'b1', name: 'Jarvis', broadcastsToday: 3 },
          { id: 'b2', name: 'Scout', broadcastsToday: 0 },
        ],
      },
      {
        interoception: {
          fleetKarmaAvg: 51.2,
          breakerOpen: ['claude-cli'],
          budgetUsedToday: { notice: 4, integrate: 1, tokens: 9000, usd: 0.31 },
          operatorSilenceHours: 2.5,
          bufferSalience: 1.4,
          lastIntegrateAgoMs: 3_600_000,
        },
      },
      { somethingWrong: "The fleet's mean karma fell from 60 to 52 within 24 h." },
      {
        insightBroadcasts: { 'n-ins00001': [{ bot: 'Scout', kind: 'wake', status: 'delivered' }] },
      },
    ];
    for (const over of changed) expect(key(input(over))).not.toBe(base);
  });

  test('a stable hex digest', () => {
    const k = key(input());
    expect(k).toMatch(/^[0-9a-f]{64}$/);
    expect(key(input())).toBe(k);
  });
});
