import { describe, expect, it, mock } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildCronInboundMessage } from '../../src/bot/bot-manager';
import { applyJobPatch, createJob } from '../../src/cron/jobs';
import { cronJobIdFromMessageId, cronMessageId } from '../../src/cron/message-id';
import { readCronRunLogEntries, resolveCronRunLogPath } from '../../src/cron/run-log';
import type { CronServiceState } from '../../src/cron/service';
import { executeJob } from '../../src/cron/timer';
import { createCronTool } from '../../src/tools/cron';

// Row 16 of docs/plans/why-everywhere-plan.md: a job says who created it (the
// agent, in which cycle, for which goal — or you on the dashboard), and each
// run links to its job and to the synthetic message it sent the agent.

const logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as never;

function makeState(storePath = '/tmp/test-cron-store', over = {}): CronServiceState {
  return {
    deps: {
      logger,
      storePath,
      cronEnabled: true,
      sendMessage: async () => {},
      sendInstruction: async () => undefined,
      resolveSkillHandler: () => undefined,
      nowMs: () => Date.now(),
      ...over,
    },
    store: { version: 1, jobs: [] },
    timer: null,
    running: false,
    op: Promise.resolve(),
  } as CronServiceState;
}

const payload = { kind: 'instruction' as const, text: 't', chatId: 1, botId: 'b1' };

describe('CronJob.createdBy', () => {
  it('createJob keeps it; a patch cannot rewrite it', () => {
    const job = createJob(makeState(), {
      name: 'n',
      enabled: true,
      schedule: { kind: 'cron', expr: '0 9 * * *' },
      payload,
      createdBy: { kind: 'agent', botId: 'b1', cycleId: 'c1', goalId: 'g1' },
    });
    expect(job.createdBy).toEqual({ kind: 'agent', botId: 'b1', cycleId: 'c1', goalId: 'g1' });
    applyJobPatch(job, { name: 'm', createdBy: { kind: 'operator' } } as never);
    expect(job.createdBy).toEqual({ kind: 'agent', botId: 'b1', cycleId: 'c1', goalId: 'g1' });
  });

  it('the cron tool stamps the agent, its cycle and goal', async () => {
    const add = mock(async (input: Record<string, unknown>) => ({
      id: 'job-1',
      ...input,
      state: { consecutiveErrors: 0 },
    }));
    const tool = createCronTool({ add } as never);
    await tool.execute(
      {
        action: 'add',
        name: 'Brief',
        schedule: { kind: 'cron', expr: '0 9 * * *' },
        text: 'Brief me',
        _chatId: 1,
        _botId: 'b1',
        _cycleId: 'c1',
        _goalId: 'g1',
      },
      logger
    );
    expect(add.mock.calls[0][0].createdBy).toEqual({
      kind: 'agent',
      botId: 'b1',
      cycleId: 'c1',
      goalId: 'g1',
    });
  });

  it('outside a cycle (a chat) the tool records only the agent', async () => {
    const add = mock(async (input: Record<string, unknown>) => ({
      id: 'job-1',
      ...input,
      state: { consecutiveErrors: 0 },
    }));
    const tool = createCronTool({ add } as never);
    await tool.execute(
      {
        action: 'add',
        schedule: { kind: 'every', everyMs: 60_000 },
        text: 'Ping',
        _chatId: 1,
        _botId: 'b1',
      },
      logger
    );
    expect(add.mock.calls[0][0].createdBy).toEqual({ kind: 'agent', botId: 'b1' });
  });
});

describe('cron message ids', () => {
  it('carry the job id and round-trip', () => {
    const id = cronMessageId('3f2a-uuid-1', 1700000000000, 'abc123');
    expect(id).toBe('cron-3f2a-uuid-1-1700000000000-abc123');
    expect(cronJobIdFromMessageId(id)).toBe('3f2a-uuid-1');
    expect(cronJobIdFromMessageId('cron-1700000000000-abc123')).toBeNull();
    expect(cronJobIdFromMessageId('msg-1')).toBeNull();
    expect(cronMessageId('j', 1)).toMatch(/^cron-j-1-[a-z0-9]+$/);
  });

  it('the synthetic inbound message uses the id it is given', () => {
    const msg = buildCronInboundMessage(7, 'do it', 'web', { messageId: 'cron-j1-5-x', nowMs: 5 });
    expect(msg.messageId).toBe('cron-j1-5-x');
    expect(msg.chatId).toBe('7');
    expect(msg.channelKind).toBe('web');
    expect(msg.timestamp).toBe(5);
    expect(buildCronInboundMessage(7, 'x', 'web', { nowMs: 5 }).messageId).toMatch(/^cron-5-/);
  });
});

describe('cron runs link to the job and the message they sent', () => {
  it('sendInstruction gets the job id and message id; the run row keeps both', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cron-why-'));
    try {
      const storePath = join(dir, 'jobs.json');
      const sendInstruction = mock(async () => 'reply');
      const state = makeState(storePath, { sendInstruction });
      const job = createJob(state, {
        name: 'n',
        enabled: true,
        schedule: { kind: 'cron', expr: '0 9 * * *' },
        payload,
      });
      state.store?.jobs.push(job);
      await executeJob(state, job, { forced: true });
      const [chatId, text, botId, link] = sendInstruction.mock.calls[0] as unknown as [
        number,
        string,
        string,
        { jobId: string; messageId: string },
      ];
      expect([chatId, text, botId]).toEqual([1, 't', 'b1']);
      expect(link.jobId).toBe(job.id);
      expect(cronJobIdFromMessageId(link.messageId)).toBe(job.id);

      await Bun.sleep(20);
      const rows = await readCronRunLogEntries(resolveCronRunLogPath({ storePath, jobId: job.id }));
      expect(rows).toHaveLength(1);
      expect(rows[0].jobId).toBe(job.id);
      expect(rows[0].messageId).toBe(link.messageId);
      expect(rows[0].output).toBe('reply');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
