import { describe, expect, test } from 'bun:test';
import {
  BROADCAST_KINDS,
  type IntegratePromptInput,
  buildIntegratePrompt,
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

function input(over: Partial<IntegratePromptInput> = {}): IntegratePromptInput {
  return {
    events: [
      {
        id: 'b-11111111',
        botId: 'b1',
        bot: 'Jarvis',
        at: '2026-10-23T10:00:00.000Z',
        what: 'web_fetch failed in Jarvis',
        salience: 0.8,
        reasons: ['tool error'],
        fromOperator: false,
      },
    ],
    fresh: [neuron('n-fresh001', 'pattern', 'wiley.com blocks the fetcher', ['b1'])],
    neighbourhood: [neuron('n-near0001', 'topic', 'Publisher research', ['b2'])],
    goals: [{ id: 'n-goal0001', botId: 'b2', bot: 'Scout', text: 'Map the publishers' }],
    insights: [neuron('n-ins00001', 'insight', 'Two bots chase the same publishers')],
    predictions: [
      {
        id: 'n-pred0001',
        text: 'The operator replies within a day',
        dueAt: '2026-10-22T12:00:00.000Z',
        resolved: { happened: false, brier: 0.49 },
      },
      { id: 'n-pred0002', text: 'Scout finishes the map', dueAt: '2026-10-25T00:00:00.000Z' },
    ],
    bots: [
      { id: 'b1', name: 'Jarvis' },
      { id: 'b2', name: 'Scout' },
    ],
    ...over,
  };
}

describe('buildIntegratePrompt', () => {
  test('has every section with ids', () => {
    const { system, user } = buildIntegratePrompt(input());
    expect(system).toContain('integration layer');
    expect(user).toContain('## What happened since my last thought');
    expect(user).toContain('- [b-11111111] 2026-10-23T10:00:00.000Z · Jarvis');
    expect(user).toContain('## What I just learned');
    expect(user).toContain('- [n-fresh001] pattern: wiley.com blocks the fetcher (bots: b1)');
    expect(user).toContain('## Related knowledge');
    expect(user).toContain('- [n-near0001] topic: Publisher research (bots: b2)');
    expect(user).toContain('## Open goals per bot');
    expect(user).toContain('- Scout (b2): [n-goal0001] Map the publishers');
    expect(user).toContain('## My last insights');
    expect(user).toContain('- [n-ins00001] Two bots chase the same publishers');
    expect(user).toContain('## My predictions');
    expect(user).toContain(
      '- [n-pred0001] The operator replies within a day (due 2026-10-22T12:00:00.000Z) · resolved: did not happen, Brier 0.49'
    );
    expect(user).toContain(
      '- [n-pred0002] Scout finishes the map (due 2026-10-25T00:00:00.000Z) · open'
    );
    expect(user).toContain('## The bots');
    expect(user).toContain('- b1: Jarvis');
    expect(user).toContain('## Answer');
  });

  test('the JSON contract names every output field and broadcast kind', () => {
    const { user } = buildIntegratePrompt(input());
    for (const field of ['insights', 'contradictions', 'predictions', 'broadcasts', 'attending']) {
      expect(user).toContain(`"${field}"`);
    }
    expect(user).toContain(BROADCAST_KINDS.join(' | '));
    expect(user).toContain('"probability"');
    expect(user).toContain('"insightIndex"');
  });

  test('empty sections say so', () => {
    const { user } = buildIntegratePrompt(
      input({ events: [], fresh: [], neighbourhood: [], goals: [], insights: [], predictions: [] })
    );
    expect(user).toContain('## What happened since my last thought\n(nothing new)');
    expect(user).toContain('## My predictions\n(none)');
  });

  test('"How I am" appears only with an interoception record', () => {
    expect(buildIntegratePrompt(input()).user).not.toContain('## How I am');
    expect(buildIntegratePrompt(input({ interoception: {} })).user).not.toContain('## How I am');
    const { user } = buildIntegratePrompt(input({ interoception: { fleetKarmaAvg: 61 } }));
    expect(user).toContain('## How I am\n- fleetKarmaAvg: 61');
  });

  test('"What I am attending to" shows the phase, the focus and the top items', () => {
    expect(buildIntegratePrompt(input()).user).not.toContain('## What I am attending to');
    const { user } = buildIntegratePrompt(
      input({
        attention: {
          phase: 'integrate',
          items: [
            {
              id: 'b-11111111',
              botId: 'b1',
              what: 'web_fetch failed in Jarvis',
              salience: 0.8,
              reasons: [],
              touched: [],
            },
          ],
          focusNeuronIds: ['n-ins00001'],
          focus: [
            { id: 'n-ins00001', kind: 'insight', text: 'Two bots chase the same publishers' },
          ],
        },
      })
    );
    expect(user).toContain('## What I am attending to\n- phase: integrate');
    expect(user).toContain('- focus: [n-ins00001] insight: Two bots chase the same publishers');
    expect(user).toContain('- event: [b-11111111] web_fetch failed in Jarvis (salience 0.8)');
    expect(user.indexOf('## What I am attending to')).toBeLessThan(user.indexOf('## Answer'));
  });

  test('the contract asks for drivenBy', () => {
    expect(buildIntegratePrompt(input()).user).toContain('"drivenBy"');
  });

  test('operator events are marked', () => {
    const { user } = buildIntegratePrompt(
      input({
        events: [{ ...input().events[0], fromOperator: true }],
      })
    );
    expect(user).toContain('· from the operator');
  });
});
