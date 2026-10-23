import { describe, expect, test } from 'bun:test';
import {
  narrateBroadcast,
  narrateIntegrateCapped,
  narrateIntegrateContradiction,
  narrateIntegrateFailed,
  narrateIntegrateInsight,
  narrateIntegratePass,
  narrateIntegratePaused,
  narrateIntegratePrediction,
  narrateIntegrateUnparsable,
  narratePredictionResolved,
} from '../../src/watcher/narration';

describe('integrate narration (phase 3)', () => {
  test('narrateIntegrateInsight quotes the model text', () => {
    expect(
      narrateIntegrateInsight({
        text: 'Jarvis and Scout chase the "same" lead',
        confidence: 'high',
        bots: ['Jarvis', 'Scout'],
      })
    ).toBe(
      `I realised: "Jarvis and Scout chase the 'same' lead" (confidence high; across Jarvis and Scout).`
    );
    expect(narrateIntegrateInsight({ text: 'x', bots: [] })).toBe('I realised: "x".');
  });

  test('narrateIntegrateContradiction', () => {
    expect(narrateIntegrateContradiction({ text: 'Two dates for one deadline' })).toBe(
      'These disagree: "Two dates for one deadline".'
    );
  });

  test('narrateIntegratePrediction', () => {
    expect(
      narrateIntegratePrediction({ text: 'Scout finishes', probability: 0.7, horizonHours: 24 })
    ).toBe('I predict, at 70 %, within 24 h: "Scout finishes".');
  });

  test('narrateIntegratePass', () => {
    expect(
      narrateIntegratePass({
        events: 4,
        insights: 1,
        contradictions: 0,
        predictions: 2,
        broadcasts: 1,
      })
    ).toBe('Integrated 4 events: 1 insight, 0 contradictions, 2 predictions, 1 broadcast.');
    expect(
      narrateIntegratePass({
        events: 1,
        insights: 0,
        contradictions: 0,
        predictions: 0,
        broadcasts: 0,
      })
    ).toBe('Integrated 1 event; no new thought.');
  });

  test('narrateIntegrateFailed / Unparsable / Capped / Paused', () => {
    expect(narrateIntegrateFailed({ error: 'boom' })).toBe(
      'Could not integrate: the model call failed ("boom"). I kept what I gathered for the next pass.'
    );
    expect(narrateIntegrateUnparsable()).toBe(
      'Could not read the integration answer as JSON. I kept what I gathered for the next pass.'
    );
    expect(narrateIntegrateCapped({ reason: 'cap', maxPerDay: 24 })).toBe(
      "Reached today's integration budget (24 calls). I keep noticing and will integrate again tomorrow."
    );
    expect(narrateIntegrateCapped({ reason: 'tokens', maxTokensPerDay: 600000 })).toBe(
      "Reached today's integration token budget (600,000 tokens). I keep noticing and will integrate again tomorrow."
    );
    expect(narrateIntegratePaused({ backend: 'claude-cli' })).toBe(
      'Claude CLI is rate-limited across the fleet (circuit open). Integration is paused until it recovers.'
    );
  });

  test('narratePredictionResolved', () => {
    expect(narratePredictionResolved({ text: 'Scout finishes', happened: true, brier: 0.09 })).toBe(
      'My prediction "Scout finishes" came true (Brier 0.09).'
    );
    expect(narratePredictionResolved({ text: 'x', happened: false, brier: 0.49 })).toBe(
      'My prediction "x" did not happen (Brier 0.49).'
    );
  });

  test('narrateBroadcast', () => {
    expect(narrateBroadcast({ kind: 'wake', bot: 'Jarvis', status: 'sent' })).toBe(
      'I woke Jarvis.'
    );
    expect(
      narrateBroadcast({ kind: 'directive', bot: 'Jarvis', status: 'sent', text: 'Check the lead' })
    ).toBe('I gave Jarvis a directive: "Check the lead".');
    expect(narrateBroadcast({ kind: 'goal', bot: 'Jarvis', status: 'sent', text: 'Merge' })).toBe(
      'I added a goal for Jarvis: "Merge".'
    );
    expect(
      narrateBroadcast({ kind: 'question', bot: 'Jarvis', status: 'sent', text: 'Who owns it?' })
    ).toBe('I asked the operator, through Jarvis: "Who owns it?".');
    expect(
      narrateBroadcast({ kind: 'question', bot: 'Jarvis', status: 'failed', error: 'throttled' })
    ).toBe('Could not ask the operator through Jarvis ("throttled").');
    expect(narrateBroadcast({ kind: 'wake', bot: 'Jarvis', status: 'capped', cap: 3 })).toBe(
      'Did not wake Jarvis: it already had 3 broadcasts today.'
    );
  });
});
