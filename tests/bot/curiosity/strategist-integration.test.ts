import { describe, expect, it } from 'bun:test';
import { runStrategistWithRetry } from '../../../src/bot/agent-strategist';

const logger = { warn() {}, info() {}, debug() {}, error() {} } as any;

const lowAlignment = JSON.stringify({
  goal_operations: [],
  single_deliverable: 'Explore how rerankers change eval variance',
  alignment_confidence: 0.4,
  reflection: 'Stuck in harness work; time to explore.',
});

function client() {
  const temps: number[] = [];
  return {
    temps,
    c: {
      generate: async (_p: string, o: { temperature: number }) => {
        temps.push(o.temperature);
        return { text: lowAlignment };
      },
    } as any,
  };
}

describe('runStrategistWithRetry and exploration', () => {
  it('retries at temperature 0 on low alignment by default (legacy behaviour)', async () => {
    const { c, temps } = client();
    await runStrategistWithRetry(c, { system: 's', prompt: 'p' }, 'm', logger);
    expect(temps).toEqual([0.4, 0]);
  });

  it('keeps the first, divergent answer when the alignment retry is skipped', async () => {
    const { c, temps } = client();
    const r = await runStrategistWithRetry(c, { system: 's', prompt: 'p' }, 'm', logger, 1, {
      skipAlignmentRetry: true,
    });
    expect(temps).toEqual([0.4]);
    expect(r?.single_deliverable).toContain('rerankers');
  });
});
