import { describe, expect, it } from 'bun:test';
import { applyJobPatch, createJob } from '../../src/cron/jobs';
import type { CronServiceState } from '../../src/cron/service';
import type { CronJob, CronPayload, CronPayloadPatch } from '../../src/cron/types';

function makeState(): CronServiceState {
  return {
    deps: {
      logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as any,
      storePath: '/tmp/test-cron-store',
      cronEnabled: true,
      sendMessage: async () => {},
      sendInstruction: async () => undefined,
      resolveSkillHandler: () => undefined,
      nowMs: () => Date.now(),
    },
    store: null,
    timer: null,
    running: false,
    op: Promise.resolve(),
  } as CronServiceState;
}

describe('skillJob botId in payload merge/build', () => {
  it('mergeCronPayload preserves existing botId when patch has none', () => {
    const state = makeState();
    const job = createJob(state, {
      name: 'test',
      enabled: true,
      schedule: { kind: 'cron', expr: '0 3 * * *' },
      payload: { kind: 'skillJob', skillId: 'reflection', jobId: 'nightly', botId: 'finny' },
    });

    expect(job.payload.kind).toBe('skillJob');
    expect((job.payload as any).botId).toBe('finny');

    // Patch without botId — should preserve existing
    const patch: CronPayloadPatch = { kind: 'skillJob', llmBackend: 'claude-cli' };
    applyJobPatch(job, { payload: patch });

    expect(job.payload.kind).toBe('skillJob');
    const merged = job.payload as CronPayload & { kind: 'skillJob' };
    expect(merged.botId).toBe('finny');
    expect(merged.llmBackend).toBe('claude-cli');
  });

  it('mergeCronPayload updates botId when patch provides one', () => {
    const state = makeState();
    const job = createJob(state, {
      name: 'test',
      enabled: true,
      schedule: { kind: 'cron', expr: '0 3 * * *' },
      payload: { kind: 'skillJob', skillId: 'reflection', jobId: 'nightly', botId: 'finny' },
    });

    const patch: CronPayloadPatch = { kind: 'skillJob', botId: 'makemylifeeasier' };
    applyJobPatch(job, { payload: patch });

    const merged = job.payload as CronPayload & { kind: 'skillJob' };
    expect(merged.botId).toBe('makemylifeeasier');
  });

  it('buildPayloadFromPatch includes botId when present', () => {
    const state = makeState();
    // Create a message job first, then patch with a skillJob that has botId
    const job = createJob(state, {
      name: 'test-msg',
      enabled: true,
      schedule: { kind: 'cron', expr: '0 3 * * *' },
      payload: { kind: 'message', text: 'hello', chatId: 123, botId: 'bot1' },
    });

    // Patch with a skillJob (kind change → buildPayloadFromPatch path)
    const patch: CronPayloadPatch = {
      kind: 'skillJob',
      skillId: 'reflection',
      jobId: 'nightly',
      botId: 'finny',
    };
    applyJobPatch(job, { payload: patch });

    const built = job.payload as CronPayload & { kind: 'skillJob' };
    expect(built.kind).toBe('skillJob');
    expect(built.skillId).toBe('reflection');
    expect(built.botId).toBe('finny');
  });

  it('createJob preserves botId in skillJob payload', () => {
    const state = makeState();
    const job = createJob(state, {
      name: 'Reflection: nightly [finny]',
      enabled: true,
      schedule: { kind: 'cron', expr: '30 3 * * *' },
      payload: {
        kind: 'skillJob',
        skillId: 'reflection',
        jobId: 'nightly-reflection',
        botId: 'finny',
      },
    });

    const payload = job.payload as CronPayload & { kind: 'skillJob' };
    expect(payload.botId).toBe('finny');
    expect(payload.skillId).toBe('reflection');
    expect(payload.jobId).toBe('nightly-reflection');
  });
});

describe('improve skill per-bot lock', () => {
  it('runningBots Set allows concurrent runs for different bots', () => {
    // Test the Set-based lock pattern directly
    const runningBots = new Set<string>();

    runningBots.add('finny');
    expect(runningBots.has('finny')).toBe(true);
    expect(runningBots.has('makemylifeeasier')).toBe(false);

    runningBots.add('makemylifeeasier');
    expect(runningBots.has('finny')).toBe(true);
    expect(runningBots.has('makemylifeeasier')).toBe(true);

    runningBots.delete('finny');
    expect(runningBots.has('finny')).toBe(false);
    expect(runningBots.has('makemylifeeasier')).toBe(true);
  });
});
