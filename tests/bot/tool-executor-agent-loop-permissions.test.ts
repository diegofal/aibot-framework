/**
 * Agent-loop tool permissions (C14): `blocked` is refused at execution, and a
 * `confirm` tool never awaits the dashboard. With
 * `enforceToolPermissions` off (default) a confirm tool runs as before; on, it
 * runs only with a recent approval, otherwise it files a request and returns
 * a non-success `approval-pending` result that charges no karma.
 *
 * Also: the abort signal (C12, loop side) refuses calls once aborted and is
 * handed to the tool as `_signal`.
 */
import { beforeEach, describe, expect, it } from 'bun:test';
import { AskPermissionStore } from '../../src/bot/ask-permission-store';
import {
  type ToolEndEvent,
  ToolExecutor,
  type ToolExecutorOptions,
} from '../../src/bot/tool-executor';
import type { BotContext } from '../../src/bot/types';
import { TOOL_ABORTED_MESSAGE } from '../../src/core/abort';
import type { Tool } from '../../src/tools/types';
import { createTempDir, removeTempDir } from '../helpers/temp-dir';

const quiet = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, trace: () => {} };

let calls: Array<{ name: string; args: Record<string, unknown> }>;
let karma: string[];

beforeEach(() => {
  calls = [];
  karma = [];
});

function tool(name: string): Tool {
  return {
    definition: {
      type: 'function',
      function: { name, description: name, parameters: { type: 'object', properties: {} } },
    },
    execute: async (args) => {
      calls.push({ name, args });
      return { success: true, content: `${name} ran` };
    },
  };
}

function setup(
  opts: Partial<ToolExecutorOptions> = {},
  toolPermissions?: Record<string, Record<string, string>>
) {
  const tools = [tool('exec'), tool('web_search'), tool('get_datetime')];
  const store = new AskPermissionStore(quiet as never);
  const ctx = {
    config: { bots: [{ id: 'b1', name: 'B', model: 'm', toolPermissions }] },
    logger: { ...quiet, child: () => quiet },
    tools,
    toolDefinitions: tools.map((t) => t.definition),
    askPermissionStore: store,
  } as unknown as BotContext;
  const karmaService = {
    recordOutcome: (_b: string, kind: string) => {
      karma.push(kind);
      return null;
    },
    addEvent: () => null,
  };
  const executor = new ToolExecutor(ctx, {
    botId: 'b1',
    chatId: 0,
    karmaService: karmaService as never,
    ...opts,
  });
  const ends: ToolEndEvent[] = [];
  executor.on('tool:end', (e) => ends.push(e));
  return { executor, store, ends };
}

describe('ToolExecutor — agent-loop blocked', () => {
  it('refuses a tool the bot blocked for the agent loop', async () => {
    const { executor } = setup(
      { permissionMode: 'agent-loop' },
      {
        web_search: { agentLoop: 'blocked' },
      }
    );
    const r = await executor.execute('web_search', { query: 'x' });
    expect(r.success).toBe(false);
    expect(r.content).toContain('not available');
    expect(calls).toHaveLength(0);
  });
});

describe('ToolExecutor — agent-loop confirm, flag off', () => {
  it('runs a confirm tool without filing a request (today behaviour)', async () => {
    const { executor, store } = setup({ permissionMode: 'agent-loop' });
    const r = await executor.execute('exec', { command: 'ls' });
    expect(r.success).toBe(true);
    expect(calls).toHaveLength(1);
    expect(store.getPendingForBot('b1')).toHaveLength(0);
  });
});

describe('ToolExecutor — agent-loop confirm, enforceToolPermissions on', () => {
  it('files a request with the cycle and returns approval-pending without waiting', async () => {
    const { executor, store, ends } = setup({
      permissionMode: 'agent-loop',
      enforceToolPermissions: true,
      attribution: { cycleId: 'c-1', goalId: 'g-1' },
    });
    const r = await executor.execute('exec', { command: 'rm -rf build' });
    expect(r.success).toBe(false);
    expect(r.failureKind).toBe('approval-pending');
    expect(calls).toHaveLength(0);
    const pending = store.getPendingForBot('b1');
    expect(pending).toHaveLength(1);
    expect(pending[0].action).toBe('exec');
    expect(pending[0]).toMatchObject({ cycleId: 'c-1', goalId: 'g-1' });
    expect(r.content).toContain(pending[0].id);
    expect(r.content).toContain('continue with other work');
    expect(ends.at(-1)?.failureKind).toBe('approval-pending');
  });

  it('does not charge karma for a pending approval', async () => {
    const { executor } = setup({ permissionMode: 'agent-loop', enforceToolPermissions: true });
    await executor.execute('exec', { command: 'ls' });
    expect(karma).not.toContain('toolError');
  });

  it('a repeated call reuses the pending request instead of filing another', async () => {
    const { executor, store } = setup({
      permissionMode: 'agent-loop',
      enforceToolPermissions: true,
    });
    const a = await executor.execute('exec', { command: 'ls' });
    const b = await executor.execute('exec', { command: 'ls' });
    expect(store.getPendingForBot('b1')).toHaveLength(1);
    expect(b.content).toBe(a.content);
  });

  it('runs the call when the same call was approved recently', async () => {
    const { executor, store } = setup({
      permissionMode: 'agent-loop',
      enforceToolPermissions: true,
    });
    const first = await executor.execute('exec', { command: 'ls' });
    expect(first.success).toBe(false);
    const [req] = store.getPendingForBot('b1');
    store.approveById(req.id);
    const second = await executor.execute('exec', { command: 'ls' });
    expect(second.success).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it('an approval for one call does not approve a different call of the same tool', async () => {
    const { executor, store } = setup({
      permissionMode: 'agent-loop',
      enforceToolPermissions: true,
    });
    await executor.execute('exec', { command: 'ls' });
    store.approveById(store.getPendingForBot('b1')[0].id);
    const other = await executor.execute('exec', { command: 'rm -rf /' });
    expect(other.success).toBe(false);
    expect(other.failureKind).toBe('approval-pending');
  });

  it('free tools are unaffected', async () => {
    const { executor } = setup({ permissionMode: 'agent-loop', enforceToolPermissions: true });
    const r = await executor.execute('get_datetime', {});
    expect(r.success).toBe(true);
  });

  it('carries a runId into the request when the attribution has one', async () => {
    const { executor, store } = setup({
      permissionMode: 'agent-loop',
      enforceToolPermissions: true,
      attribution: { goalId: null, runId: 'r-9' },
    });
    await executor.execute('exec', { command: 'ls' });
    expect(store.getPendingForBot('b1')[0]).toMatchObject({ runId: 'r-9' });
  });
});

describe('ToolExecutor — abort signal', () => {
  it('passes the signal to the tool as _signal', async () => {
    const ac = new AbortController();
    const { executor } = setup({ signal: ac.signal });
    await executor.execute('get_datetime', {});
    expect(calls[0].args._signal).toBe(ac.signal);
  });

  it('refuses every call once aborted, without charging karma', async () => {
    const ac = new AbortController();
    const { executor } = setup({ signal: ac.signal });
    ac.abort();
    const r = await executor.execute('get_datetime', {});
    expect(r.success).toBe(false);
    expect(r.failureKind).toBe('aborted');
    expect(calls).toHaveLength(0);
    expect(karma).not.toContain('toolError');
  });

  it('without a signal no _signal is injected', async () => {
    const { executor } = setup();
    await executor.execute('get_datetime', {});
    expect('_signal' in calls[0].args).toBe(false);
  });
});

describe('ToolExecutor — workDir override', () => {
  it('uses the given workDir as exec cwd instead of the bot one', async () => {
    const dir = createTempDir('exec-workdir-override');
    try {
      const { executor } = setup({ workDir: dir });
      await executor.execute('exec', { command: 'ls' });
      expect(calls[0].args._workDir).toBe(dir);
      expect(calls[0].args.workdir).toBe(dir);
    } finally {
      removeTempDir(dir);
    }
  });
});

describe('bots[].agentLoop.enforceToolPermissions', () => {
  it('is off unless set, and accepts true', async () => {
    const { BotAgentLoopOverrideSchema } = await import('../../src/config');
    expect(BotAgentLoopOverrideSchema.parse({})?.enforceToolPermissions ?? false).toBe(false);
    expect(
      BotAgentLoopOverrideSchema.parse({ enforceToolPermissions: true })?.enforceToolPermissions
    ).toBe(true);
  });
});

describe('ToolExecutor — a tool stopped by the abort', () => {
  function single(execute: Tool['execute'], signal?: AbortSignal) {
    const t: Tool = {
      definition: {
        type: 'function',
        function: {
          name: 'long',
          description: 'long',
          parameters: { type: 'object', properties: {} },
        },
      },
      execute,
    };
    const ctx = {
      config: { bots: [{ id: 'b1', name: 'B', model: 'm' }] },
      logger: { ...quiet, child: () => quiet },
      tools: [t],
      toolDefinitions: [t.definition],
    } as unknown as BotContext;
    const karmaService = {
      recordOutcome: (_b: string, kind: string) => {
        karma.push(kind);
        return null;
      },
      addEvent: () => null,
    };
    return new ToolExecutor(ctx, {
      botId: 'b1',
      chatId: 0,
      karmaService: karmaService as never,
      signal,
    });
  }

  it('a tool returning the cancelled-run message is aborted, not charged', async () => {
    const ex = single(async () => ({ success: false, content: TOOL_ABORTED_MESSAGE }));
    const r = await ex.execute('long', {});
    expect(r.failureKind).toBe('aborted');
    expect(karma).not.toContain('toolError');
  });

  it('a tool failing after the signal aborted mid-call is aborted', async () => {
    const ac = new AbortController();
    const ex = single(async () => {
      ac.abort();
      return { success: false, content: 'curl: interrupted' };
    }, ac.signal);
    const r = await ex.execute('long', {});
    expect(r.failureKind).toBe('aborted');
    expect(karma).not.toContain('toolError');
  });

  it('a tool throwing an AbortError is aborted, not retried and not charged', async () => {
    let runs = 0;
    const ex = single(async () => {
      runs++;
      const e = new Error('The operation was aborted');
      e.name = 'AbortError';
      throw e;
    });
    const r = await ex.execute('long', {});
    expect(r.failureKind).toBe('aborted');
    expect(runs).toBe(1);
    expect(karma).not.toContain('toolError');
  });
});
