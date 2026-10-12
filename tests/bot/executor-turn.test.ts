/**
 * runExecutorTurn (src/bot/executor-turn.ts): one executor turn — system
 * prompt, tool definitions, ToolExecutor, audit, timeout + abort, llm:*
 * events, query log, breaker. Shared by the cycle executor and (later) task
 * worker steps.
 */
import { describe, expect, mock, test } from 'bun:test';
import { BackendCircuitBreaker, classifyError } from '../../src/bot/agent-retry-engine';
import { type ExecutorTurnInput, runExecutorTurn } from '../../src/bot/executor-turn';
import type { BotContext } from '../../src/bot/types';
import type { Tool, ToolDefinition } from '../../src/tools/types';

const quiet: any = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
quiet.child = () => quiet;

function tool(name: string, run?: (args: Record<string, unknown>) => void): Tool {
  return {
    definition: {
      type: 'function',
      function: { name, description: name, parameters: { type: 'object', properties: {} } },
    },
    execute: async (args) => {
      run?.(args);
      return { success: true, content: `${name} ok` };
    },
  };
}

const def = (t: Tool): ToolDefinition => t.definition;

function makeCtx(tools: Tool[], extra: Record<string, unknown> = {}) {
  const events: any[] = [];
  const audit: any[] = [];
  const ctx = {
    config: { bots: [{ id: 'b1', name: 'B' }] },
    logger: quiet,
    tools,
    toolDefinitions: tools.map(def),
    activityStream: { publish: (e: any) => events.push(e) },
    toolAuditLog: { append: (e: any) => audit.push(e) },
    askPermissionStore: undefined,
    askHumanStore: { getPendingForBot: () => [] },
    ...extra,
  } as unknown as BotContext;
  return { ctx, events, audit };
}

/** An LLM whose chat calls the given tools through the executor callback. */
function llmCalling(toolNames: string[], text = 'done') {
  const seen: any[] = [];
  const client: any = {
    backend: 'ollama',
    chat: mock(async (messages: any[], opts: any) => {
      seen.push({ messages, opts });
      for (const n of toolNames) await opts.toolExecutor(n, {});
      return { text, usage: { model: 'm1', promptTokens: 1, completionTokens: 2, totalTokens: 3 } };
    }),
  };
  return { client, seen };
}

function input(over: Partial<ExecutorTurnInput> & Pick<ExecutorTurnInput, 'ctx' | 'llmClient'>) {
  return {
    botId: 'b1',
    botConfig: { id: 'b1', name: 'B' } as any,
    model: 'm',
    prompt: { system: 'SYS', user: 'USER' },
    tools: { definitions: over.ctx.toolDefinitions, disabled: new Set<string>() },
    temperature: 0.4,
    maxToolRounds: 7,
    timeoutMs: 5_000,
    logger: quiet,
    ...over,
  } as ExecutorTurnInput;
}

describe('runExecutorTurn', () => {
  test('runs the turn: prompts, options, tool log, usage, completed', async () => {
    const tools = [tool('a'), tool('b')];
    const { ctx, events, audit } = makeCtx(tools);
    const { client, seen } = llmCalling(['a']);
    const queries: any[] = [];
    const r = await runExecutorTurn(
      input({ ctx, llmClient: client, queryLog: (e) => queries.push(e) })
    );
    expect(r.ok).toBe(true);
    expect(r.stopReason).toBe('completed');
    expect(r.text).toBe('done');
    expect(r.usage?.totalTokens).toBe(3);
    expect(r.toolCalls.map((t) => t.name)).toEqual(['a']);
    expect(seen[0].messages).toEqual([
      { role: 'system', content: 'SYS' },
      { role: 'user', content: 'USER' },
    ]);
    expect(seen[0].opts).toMatchObject({ model: 'm', temperature: 0.4, maxToolRounds: 7 });
    expect(seen[0].opts.signal).toBeInstanceOf(AbortSignal);
    expect(seen[0].opts.tools.map((d: any) => d.function.name)).toEqual(['a', 'b']);
    expect(events.map((e) => e.type)).toEqual(
      expect.arrayContaining(['llm:start', 'tool:start', 'tool:end', 'llm:end'])
    );
    expect(audit).toHaveLength(1);
    expect(queries[0]).toMatchObject({
      caller: 'executor',
      success: true,
      model: 'm1',
      toolCount: 2,
      temperature: 0.4,
    });
  });

  test('builds the autonomous system prompt when none is given', async () => {
    const { ctx } = makeCtx([]);
    const { client, seen } = llmCalling([]);
    const build = mock(() => 'BUILT');
    await runExecutorTurn(
      input({
        ctx,
        llmClient: client,
        prompt: { user: 'U' },
        systemPromptBuilder: { build } as any,
      })
    );
    expect(build.mock.calls[0][0]).toMatchObject({ mode: 'autonomous', memoryViewer: null });
    expect(seen[0].messages[0].content).toBe('BUILT');
  });

  test('tools: denied names are dropped and refused; extra tools are offered and run', async () => {
    const extraRan: string[] = [];
    const base = [tool('a'), tool('b')];
    const { ctx } = makeCtx(base);
    const extra = tool('task_progress', () => extraRan.push('x'));
    const { client, seen } = llmCalling(['b', 'task_progress']);
    const r = await runExecutorTurn(
      input({
        ctx,
        llmClient: client,
        tools: { definitions: base.map(def), disabled: new Set(), denied: ['b'], extra: [extra] },
      })
    );
    expect(seen[0].opts.tools.map((d: any) => d.function.name)).toEqual(['a', 'task_progress']);
    expect(r.toolCalls.find((t) => t.name === 'b')?.success).toBe(false);
    expect(extraRan).toEqual(['x']);
  });

  test('tools: pre-selection narrows by category and keeps the disabled filter', async () => {
    const base = [tool('a'), tool('b'), tool('c')];
    const { ctx } = makeCtx(base);
    const { client, seen } = llmCalling([]);
    const getDefinitionsByCategories = mock(() => [def(base[1]), def(base[2])]);
    await runExecutorTurn(
      input({
        ctx,
        llmClient: client,
        tools: {
          definitions: base.map(def),
          disabled: new Set(['c']),
          preSelect: { categories: ['web'], registry: { getDefinitionsByCategories } as any },
        },
      })
    );
    expect(getDefinitionsByCategories.mock.calls[0]).toEqual([['web'], 'b1', 'agent-loop']);
    expect(seen[0].opts.tools.map((d: any) => d.function.name)).toEqual(['b']);
  });

  test('attribution, workDir and onToolEnd reach the tool and the caller', async () => {
    let seenArgs: Record<string, unknown> = {};
    const t = tool('a', (args) => {
      seenArgs = args;
    });
    const { ctx } = makeCtx([t]);
    const { client } = llmCalling(['a']);
    const ends: any[] = [];
    const { createTempDir, removeTempDir } = await import('../helpers/temp-dir');
    const dir = createTempDir('turn-workdir');
    try {
      await runExecutorTurn(
        input({
          ctx,
          llmClient: client,
          attribution: { goalId: 'g-1', runId: 'r-1', taskId: 't-1', dispatchCycleId: 'c-0' },
          workDir: dir,
          onToolEnd: (e) => ends.push(e),
        })
      );
    } finally {
      removeTempDir(dir);
    }
    expect(seenArgs).toMatchObject({
      _runId: 'r-1',
      _taskId: 't-1',
      _goalId: 'g-1',
      _workDir: dir,
    });
    expect(seenArgs._cycleId).toBeUndefined();
    expect(ends).toHaveLength(1);
  });

  test('blocked tools are refused at execution (agent-loop permission mode)', async () => {
    const t = tool('web_fetch');
    const { ctx } = makeCtx([t]);
    (ctx.config.bots[0] as any).toolPermissions = { web_fetch: { agentLoop: 'blocked' } };
    const { client } = llmCalling(['web_fetch']);
    const r = await runExecutorTurn(input({ ctx, llmClient: client }));
    expect(r.toolCalls[0].success).toBe(false);
  });

  test('timeout aborts the turn: the chat signal fires and later tool calls are refused', async () => {
    const t = tool('a');
    const { ctx } = makeCtx([t]);
    let chatSignal: AbortSignal | undefined;
    let lateCall: any;
    const client: any = {
      backend: 'ollama',
      chat: async (_m: any, opts: any) => {
        chatSignal = opts.signal;
        await new Promise((r) => setTimeout(r, 80));
        lateCall = await opts.toolExecutor('a', {});
        return { text: 'late' };
      },
    };
    const queries: any[] = [];
    const r = await runExecutorTurn(
      input({ ctx, llmClient: client, timeoutMs: 20, queryLog: (e) => queries.push(e) })
    );
    expect(r.ok).toBe(false);
    expect(r.stopReason).toBe('timeout');
    expect(String((r.error as Error).message)).toBe(
      'Executor phase timed out after 20ms (session timeout guard)'
    );
    expect(chatSignal?.aborted).toBe(true);
    expect(queries[0]).toMatchObject({ success: false });
    await new Promise((res) => setTimeout(res, 120));
    expect(lateCall?.success).toBe(false);
  });

  test('an external abort stops the turn with stopReason aborted', async () => {
    const { ctx } = makeCtx([]);
    const ac = new AbortController();
    const client: any = {
      backend: 'ollama',
      chat: () => new Promise(() => {}),
    };
    setTimeout(() => ac.abort(new Error('cycle over')), 10);
    const r = await runExecutorTurn(input({ ctx, llmClient: client, signal: ac.signal }));
    expect(r.stopReason).toBe('aborted');
    expect(r.ok).toBe(false);
    // named AbortError: the retry engine never retries a cancelled run
    expect((r.error as Error).name).toBe('AbortError');
    expect(classifyError(r.error).code).toBe('aborted');
  });

  test('an LLM error returns error with the tool calls made so far', async () => {
    const { ctx, events } = makeCtx([tool('a')]);
    const client: any = {
      backend: 'ollama',
      chat: async (_m: any, opts: any) => {
        await opts.toolExecutor('a', {});
        throw new Error('backend exploded');
      },
    };
    const r = await runExecutorTurn(input({ ctx, llmClient: client }));
    expect(r.stopReason).toBe('error');
    expect((r.error as Error).message).toBe('backend exploded');
    expect(r.toolCalls).toHaveLength(1);
    expect(events.some((e) => e.type === 'llm:error')).toBe(true);
  });

  test('feeds the shared breaker: quota errors open it, success closes it', async () => {
    const breaker = new BackendCircuitBreaker({
      enabled: true,
      threshold: 2,
      cooldownMs: 60_000,
      weeklyQuotaCooldownMs: 120_000,
    });
    const { ctx } = makeCtx([]);
    const failing: any = {
      backend: 'claude-cli',
      chat: async () => {
        throw new Error('Ollama API error: 429 Too Many Requests');
      },
    };
    await runExecutorTurn(input({ ctx, llmClient: failing, breaker }));
    expect(breaker.isOpen('claude-cli')).toBe(false);
    await runExecutorTurn(input({ ctx, llmClient: failing, breaker }));
    expect(breaker.isOpen('claude-cli')).toBe(true);

    const ok = llmCalling([]).client;
    ok.backend = 'claude-cli';
    await runExecutorTurn(input({ ctx, llmClient: ok, breaker }));
    expect(breaker.isOpen('claude-cli')).toBe(false);
  });

  test('a timeout or abort is not fed to the breaker', async () => {
    const breaker = new BackendCircuitBreaker();
    const spy = mock(breaker.recordFailure.bind(breaker));
    breaker.recordFailure = spy;
    const { ctx } = makeCtx([]);
    const client: any = { backend: 'ollama', chat: () => new Promise(() => {}) };
    await runExecutorTurn(input({ ctx, llmClient: client, timeoutMs: 10, breaker }));
    expect(spy).not.toHaveBeenCalled();
  });

  test('onStart reports the offered tool count before the LLM call', async () => {
    const { ctx } = makeCtx([tool('a'), tool('b')]);
    const { client } = llmCalling([]);
    const starts: number[] = [];
    await runExecutorTurn(
      input({ ctx, llmClient: client, onStart: (i) => starts.push(i.toolCount) })
    );
    expect(starts).toEqual([2]);
  });
});
