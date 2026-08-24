import { describe, expect, it } from 'bun:test';
import { applyJobPatch, createJob } from '../../src/cron/jobs';
import type { CronServiceState } from '../../src/cron/service';
import type { CronJob, CronPayload, CronPayloadPatch } from '../../src/cron/types';

// Live bug: `mergeCronPayload` and `buildPayloadFromPatch` in src/cron/jobs.ts
// handle 'message' and 'skillJob' payloads but never 'instruction' — the third
// of three payload kinds. PATCHing an instruction job's chatId/text/botId is
// silently a no-op (200 OK, updatedAtMs bumped, payload unchanged). Found
// live trying to fix a job whose chatId pointed at a Telegram chat the fleet
// has no access to ("Bad Request: chat not found").

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

function makeInstructionJob(state: CronServiceState): CronJob {
  return createJob(state, {
    name: 'test',
    enabled: true,
    schedule: { kind: 'cron', expr: '0 18 * * *' },
    payload: {
      kind: 'instruction',
      text: 'original text',
      chatId: -1002672545061,
      botId: 'selfimprove',
    },
  });
}

describe('instruction payload merge/build', () => {
  it('updates chatId when the patch provides one', () => {
    const state = makeState();
    const job = makeInstructionJob(state);

    const patch: CronPayloadPatch = { kind: 'instruction', chatId: 796164002 };
    applyJobPatch(job, { payload: patch });

    const merged = job.payload as CronPayload & { kind: 'instruction' };
    expect(merged.chatId).toBe(796164002);
    expect(merged.text).toBe('original text'); // untouched fields preserved
    expect(merged.botId).toBe('selfimprove');
  });

  it('updates text when the patch provides one, preserving chatId/botId', () => {
    const state = makeState();
    const job = makeInstructionJob(state);

    applyJobPatch(job, { payload: { kind: 'instruction', text: 'new instruction text' } });

    const merged = job.payload as CronPayload & { kind: 'instruction' };
    expect(merged.text).toBe('new instruction text');
    expect(merged.chatId).toBe(-1002672545061);
  });

  it('updates botId when the patch provides one', () => {
    const state = makeState();
    const job = makeInstructionJob(state);

    applyJobPatch(job, { payload: { kind: 'instruction', botId: 'default' } });

    const merged = job.payload as CronPayload & { kind: 'instruction' };
    expect(merged.botId).toBe('default');
  });

  it('preserves every field when the patch supplies none of them', () => {
    const state = makeState();
    const job = makeInstructionJob(state);

    applyJobPatch(job, { payload: { kind: 'instruction' } });

    const merged = job.payload as CronPayload & { kind: 'instruction' };
    expect(merged).toEqual({
      kind: 'instruction',
      text: 'original text',
      chatId: -1002672545061,
      botId: 'selfimprove',
    });
  });

  it('a message-kind patch against an instruction job rebuilds instead of silently merging', () => {
    const state = makeState();
    const job = makeInstructionJob(state);

    applyJobPatch(job, {
      payload: { kind: 'message', text: 'switched to message', chatId: 796164002, botId: 'x' },
    });

    expect(job.payload.kind).toBe('message');
    expect((job.payload as CronPayload & { kind: 'message' }).text).toBe('switched to message');
  });

  it('switching a message job to instruction via a full patch builds a valid instruction payload', () => {
    const state = makeState();
    const job = createJob(state, {
      name: 'test',
      enabled: true,
      schedule: { kind: 'cron', expr: '0 3 * * *' },
      payload: { kind: 'message', text: 'hi', chatId: 1, botId: 'x' },
    });

    applyJobPatch(job, {
      payload: { kind: 'instruction', text: 'do the thing', chatId: 796164002, botId: 'default' },
    });

    expect(job.payload).toEqual({
      kind: 'instruction',
      text: 'do the thing',
      chatId: 796164002,
      botId: 'default',
    });
  });

  it('building a fresh instruction payload from a patch requires text, chatId and botId', () => {
    const state = makeState();
    const job = createJob(state, {
      name: 'test',
      enabled: true,
      schedule: { kind: 'cron', expr: '0 3 * * *' },
      payload: { kind: 'message', text: 'hi', chatId: 1, botId: 'x' },
    });

    expect(() =>
      applyJobPatch(job, { payload: { kind: 'instruction', text: 'no chat id' } })
    ).toThrow(/chatId/);
    expect(() =>
      applyJobPatch(job, { payload: { kind: 'instruction', chatId: 1 } })
    ).toThrow(/text/);
    expect(() =>
      applyJobPatch(job, { payload: { kind: 'instruction', text: 'x', chatId: 1 } })
    ).toThrow(/botId/);
  });
});
