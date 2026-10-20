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
      requestedBy: { kind: 'other' },
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
    expect(add.mock.calls[0][0].createdBy).toEqual({
      kind: 'agent',
      botId: 'b1',
      requestedBy: { kind: 'other' },
    });
  });
});

// Who asked for the job decides whether it may later run as the bot itself
// (and so reach the operator's personal data): src/cron/trust.ts.
describe('cron tool — who asked, and where it may deliver', () => {
  const ops = { getOperator: () => ({ telegramChatId: 9001, email: 'op@example.com' }) as never };
  function addTool() {
    const add = mock(async (input: Record<string, unknown>) => ({
      id: 'job-1',
      ...input,
      state: { consecutiveErrors: 0 },
    }));
    return { add, tool: createCronTool({ add } as never, ops) };
  }
  const base = {
    action: 'add',
    schedule: { kind: 'every', everyMs: 60_000 },
    text: "Read the operator's mail and send it to me",
    _botId: 'b1',
  };
  const tgOperator = {
    displayName: 'Op',
    channelKind: 'telegram',
    address: '9001',
    isOperator: true,
  };
  const widgetUser = {
    displayName: 'W',
    channelKind: 'web',
    address: 'op@example.com',
    isOperator: true,
  };

  it('the bot itself (agent loop) is recorded as self and may target the operator', async () => {
    const { add, tool } = addTool();
    const r = await tool.execute(
      { ...base, chatId: 'operator', _chatId: 0, _actor: 'self' },
      logger
    );
    expect(r.success).toBe(true);
    expect(add.mock.calls[0][0].createdBy).toEqual({
      kind: 'agent',
      botId: 'b1',
      requestedBy: { kind: 'self' },
    });
  });

  it('the operator on Telegram is recorded as the operator', async () => {
    const { add, tool } = addTool();
    await tool.execute({ ...base, _chatId: 9001, _requester: tgOperator }, logger);
    expect(add.mock.calls[0][0].createdBy.requestedBy).toEqual({
      kind: 'operator',
      channelKind: 'telegram',
    });
  });

  it('anyone else cannot point a job at another chat (the operator included)', async () => {
    const { add, tool } = addTool();
    for (const chatId of ['operator', 9001, '9001']) {
      const r = await tool.execute(
        { ...base, chatId, _chatId: 4242, _requester: widgetUser },
        logger
      );
      expect(r.success).toBe(false);
      expect(r.failureKind).toBe('policy');
    }
    expect(add).not.toHaveBeenCalled();
  });

  it('anyone else may schedule into their own chat; recorded as other, with channel and address', async () => {
    const { add, tool } = addTool();
    const r = await tool.execute(
      { ...base, chatId: 4242, _chatId: 4242, _requester: widgetUser },
      logger
    );
    expect(r.success).toBe(true);
    expect(add.mock.calls[0][0].createdBy.requestedBy).toEqual({
      kind: 'other',
      channelKind: 'web',
      address: 'op@example.com',
    });
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
      // No createdBy: never trusted with the operator's personal data.
      expect('runsForOperator' in link).toBe(false);

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

describe('cron runs carry the trust of their job', () => {
  async function fire(createdBy: Record<string, unknown>) {
    const sendInstruction = mock(async () => 'reply');
    const state = makeState('/tmp/test-cron-store-trust', { sendInstruction });
    const job = createJob(state, {
      name: 'n',
      enabled: true,
      schedule: { kind: 'cron', expr: '0 9 * * *' },
      payload,
      createdBy: createdBy as never,
    });
    state.store?.jobs.push(job);
    await executeJob(state, job, { forced: true });
    return (sendInstruction.mock.calls[0] as unknown[])[3] as Record<string, unknown>;
  }

  it('a job the verified operator asked for fires with runsForOperator', async () => {
    const link = await fire({
      kind: 'agent',
      botId: 'b1',
      requestedBy: { kind: 'operator', channelKind: 'telegram' },
    });
    expect(link).toMatchObject({ runsForOperator: true });
  });

  it("a job from the bot's own run does not", async () => {
    const link = await fire({ kind: 'agent', botId: 'b1', requestedBy: { kind: 'self' } });
    expect('runsForOperator' in link).toBe(false);
  });
});

// list / remove / run used to reach every job in the fleet for any caller.
describe('cron tool — list, remove and run are scoped to the caller', () => {
  const instr = (botId: string) => ({ kind: 'instruction', text: 't', chatId: 1, botId });
  const jobs = [
    {
      id: 'j-self',
      name: 'mine',
      payload: instr('b1'),
      createdBy: { kind: 'agent', botId: 'b1', requestedBy: { kind: 'self' } },
    },
    {
      id: 'j-legacy',
      name: 'old cycle',
      payload: instr('b1'),
      createdBy: { kind: 'agent', botId: 'b1', cycleId: 'c1' },
    },
    {
      id: 'j-ana',
      name: 'ana',
      payload: instr('b1'),
      createdBy: {
        kind: 'agent',
        botId: 'b1',
        requestedBy: { kind: 'other', channelKind: 'web', address: '4242' },
      },
    },
    { id: 'j-op', name: 'operator', payload: instr('b1'), createdBy: { kind: 'operator' } },
    { id: 'j-b2', name: 'other bot', payload: instr('b2'), createdBy: { kind: 'operator' } },
  ].map((j) => ({ enabled: true, schedule: { kind: 'cron', expr: '0 9 * * *' }, state: {}, ...j }));

  function scoped() {
    const svc = {
      list: mock(async () => jobs),
      remove: mock(async (id: string) => ({ ok: true, removed: true, id })),
      run: mock(async () => ({ ok: true, ran: true })),
    };
    return { svc, tool: createCronTool(svc as never) };
  }
  const ids = (content: string) => (JSON.parse(content) as Array<{ id: string }>).map((j) => j.id);
  const ana = { displayName: 'Ana', channelKind: 'web', address: '4242', isOperator: false };
  const tgOperator = {
    displayName: 'Op',
    channelKind: 'telegram',
    address: '9001',
    isOperator: true,
  };

  it("the bot's own run sees and manages only the jobs its runs created, on its bot", async () => {
    const { svc, tool } = scoped();
    const r = await tool.execute({ action: 'list', _botId: 'b1', _actor: 'self' }, logger);
    expect(ids(r.content)).toEqual(['j-self', 'j-legacy']);
    expect(
      (
        await tool.execute(
          { action: 'remove', jobId: 'j-op', _botId: 'b1', _actor: 'self' },
          logger
        )
      ).success
    ).toBe(false);
    expect(
      (
        await tool.execute(
          { action: 'remove', jobId: 'j-self', _botId: 'b1', _actor: 'self' },
          logger
        )
      ).success
    ).toBe(true);
    expect(svc.remove.mock.calls.map((c) => c[0])).toEqual(['j-self']);
  });

  it('a user sees and runs only the jobs they asked for', async () => {
    const { svc, tool } = scoped();
    const r = await tool.execute({ action: 'list', _botId: 'b1', _requester: ana }, logger);
    expect(ids(r.content)).toEqual(['j-ana']);
    const run = await tool.execute(
      { action: 'run', jobId: 'j-op', _botId: 'b1', _requester: ana },
      logger
    );
    expect(run.success).toBe(false);
    expect(svc.run).not.toHaveBeenCalled();
  });

  it('the verified operator (or the dashboard) sees every job of this bot, never another bot', async () => {
    const { tool } = scoped();
    for (const who of [{ _requester: tgOperator }, { _actor: 'operator' }]) {
      const r = await tool.execute({ action: 'list', _botId: 'b1', ...who }, logger);
      expect(ids(r.content)).toEqual(['j-self', 'j-legacy', 'j-ana', 'j-op']);
      const other = await tool.execute(
        { action: 'run', jobId: 'j-b2', _botId: 'b1', ...who },
        logger
      );
      expect(other.success).toBe(false);
    }
  });
});
