import { describe, expect, it, mock } from 'bun:test';
import type { CronServiceState } from '../../src/cron/service';
import { executeJob } from '../../src/cron/timer';
import type { CronJob } from '../../src/cron/types';

function makeState(overrides: Partial<CronServiceState['deps']> = {}): CronServiceState {
  return {
    deps: {
      logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as any,
      storePath: '/tmp/test-cron-store',
      cronEnabled: true,
      sendMessage: async () => {},
      sendInstruction: async () => undefined,
      resolveSkillHandler: () => undefined,
      nowMs: () => Date.now(),
      ...overrides,
    },
    store: { version: 1, jobs: [] },
    timer: null,
    running: false,
    op: Promise.resolve(),
  } as CronServiceState;
}

function makeJob(payload: CronJob['payload']): CronJob {
  return {
    id: 'test-job',
    name: 'test',
    enabled: true,
    createdAtMs: Date.now(),
    updatedAtMs: Date.now(),
    schedule: { kind: 'at', at: new Date().toISOString() },
    payload,
    state: { consecutiveErrors: 0 },
  };
}

describe('instruction payload', () => {
  it('should call sendInstruction instead of sendMessage', async () => {
    const sendMessage = mock(async () => {});
    const sendInstruction = mock(async () => 'LLM response here');

    const state = makeState({ sendMessage, sendInstruction });
    const job = makeJob({
      kind: 'instruction',
      text: 'Generate a news briefing',
      chatId: 123,
      botId: 'bot1',
    });

    state.store?.jobs.push(job);
    await executeJob(state, job, { forced: true });

    expect(sendMessage).not.toHaveBeenCalled();
    expect(sendInstruction).toHaveBeenCalledTimes(1);
    expect(sendInstruction).toHaveBeenCalledWith(123, 'Generate a news briefing', 'bot1');
    expect(job.state.lastStatus).toBe('ok');
  });

  it('should record error when sendInstruction throws', async () => {
    const sendInstruction = mock(async () => {
      throw new Error('Pipeline failed');
    });

    const state = makeState({ sendInstruction });
    const job = makeJob({
      kind: 'instruction',
      text: 'Do something',
      chatId: 456,
      botId: 'bot2',
    });

    state.store?.jobs.push(job);
    await executeJob(state, job, { forced: true });

    expect(sendInstruction).toHaveBeenCalledTimes(1);
    expect(job.state.lastStatus).toBe('error');
    expect(job.state.lastError).toContain('Pipeline failed');
    expect(job.state.consecutiveErrors).toBe(1);
  });

  it('message payload should still call sendMessage', async () => {
    const sendMessage = mock(async () => {});
    const sendInstruction = mock(async () => 'should not be called');

    const state = makeState({ sendMessage, sendInstruction });
    const job = makeJob({
      kind: 'message',
      text: 'Simple reminder',
      chatId: 789,
      botId: 'bot3',
    });

    state.store?.jobs.push(job);
    await executeJob(state, job, { forced: true });

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith(789, 'Simple reminder', 'bot3');
    expect(sendInstruction).not.toHaveBeenCalled();
    expect(job.state.lastStatus).toBe('ok');
  });
});
