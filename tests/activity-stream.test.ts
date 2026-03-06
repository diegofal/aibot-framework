import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ActivityEvent, ActivityStream, type LlmBotStats } from '../src/bot/activity-stream';

describe('ActivityStream', () => {
  let stream: ActivityStream;

  beforeEach(() => {
    stream = new ActivityStream();
  });

  test('starts empty', () => {
    expect(stream.size).toBe(0);
    expect(stream.getRecent()).toEqual([]);
  });

  test('publish() stores events and emits', () => {
    const listener = mock(() => {});
    stream.on('activity', listener);

    const event: ActivityEvent = {
      type: 'tool:start',
      botId: 'bot1',
      timestamp: Date.now(),
      data: { toolName: 'web_search' },
    };
    stream.publish(event);

    expect(stream.size).toBe(1);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(event);
  });

  test('getRecent() returns latest N events', () => {
    for (let i = 0; i < 10; i++) {
      stream.publish({
        type: 'agent:phase',
        botId: 'bot1',
        timestamp: Date.now(),
        data: { index: i },
      });
    }

    expect(stream.getRecent(3)).toHaveLength(3);
    expect(stream.getRecent(3)[0].data?.index).toBe(7);
    expect(stream.getRecent(3)[2].data?.index).toBe(9);
  });

  test('getRecent() default count is 50', () => {
    for (let i = 0; i < 100; i++) {
      stream.publish({
        type: 'agent:phase',
        botId: 'bot1',
        timestamp: i,
      });
    }

    expect(stream.getRecent()).toHaveLength(50);
  });

  test('buffer respects max size', () => {
    const small = new ActivityStream(5);

    for (let i = 0; i < 10; i++) {
      small.publish({
        type: 'tool:end',
        botId: 'bot1',
        timestamp: i,
        data: { index: i },
      });
    }

    expect(small.size).toBe(5);
    // Oldest events should be evicted
    const recent = small.getRecent(10);
    expect(recent).toHaveLength(5);
    expect(recent[0].data?.index).toBe(5);
    expect(recent[4].data?.index).toBe(9);
  });

  test('clear() empties the buffer', () => {
    stream.publish({ type: 'agent:idle', botId: 'bot1', timestamp: Date.now() });
    stream.publish({ type: 'agent:idle', botId: 'bot1', timestamp: Date.now() });
    expect(stream.size).toBe(2);

    stream.clear();
    expect(stream.size).toBe(0);
    expect(stream.getRecent()).toEqual([]);
  });

  test('multiple listeners receive events', () => {
    const l1 = mock(() => {});
    const l2 = mock(() => {});
    stream.on('activity', l1);
    stream.on('activity', l2);

    stream.publish({ type: 'llm:start', botId: 'bot1', timestamp: Date.now() });

    expect(l1).toHaveBeenCalledTimes(1);
    expect(l2).toHaveBeenCalledTimes(1);
  });

  test('getSlice() returns events from end with offset', () => {
    for (let i = 0; i < 20; i++) {
      stream.publish({
        type: 'agent:phase',
        botId: 'bot1',
        timestamp: i,
        data: { index: i },
      });
    }

    // Most recent 5 (offset 0)
    const page0 = stream.getSlice(5, 0);
    expect(page0.total).toBe(20);
    expect(page0.events).toHaveLength(5);
    expect(page0.events[0].data?.index).toBe(15);
    expect(page0.events[4].data?.index).toBe(19);

    // Next 5 (offset 5)
    const page1 = stream.getSlice(5, 5);
    expect(page1.total).toBe(20);
    expect(page1.events).toHaveLength(5);
    expect(page1.events[0].data?.index).toBe(10);
    expect(page1.events[4].data?.index).toBe(14);

    // Last page (offset 18 → only 2 events left)
    const pageLast = stream.getSlice(5, 18);
    expect(pageLast.events).toHaveLength(2);
    expect(pageLast.events[0].data?.index).toBe(0);
    expect(pageLast.events[1].data?.index).toBe(1);
  });

  test('getSlice() returns empty when offset exceeds buffer', () => {
    for (let i = 0; i < 5; i++) {
      stream.publish({ type: 'agent:idle', botId: 'bot1', timestamp: i });
    }
    const result = stream.getSlice(10, 100);
    expect(result.events).toEqual([]);
    expect(result.total).toBe(5);
  });

  test('getSlice() default params return last 50', () => {
    for (let i = 0; i < 100; i++) {
      stream.publish({ type: 'agent:phase', botId: 'bot1', timestamp: i });
    }
    const result = stream.getSlice();
    expect(result.events).toHaveLength(50);
    expect(result.total).toBe(100);
    expect(result.events[0].timestamp).toBe(50);
    expect(result.events[49].timestamp).toBe(99);
  });

  test('getSlice() on empty buffer', () => {
    const result = stream.getSlice(10, 0);
    expect(result.events).toEqual([]);
    expect(result.total).toBe(0);
  });

  test('events preserve all fields', () => {
    const event: ActivityEvent = {
      type: 'memory:flush',
      botId: 'finny',
      timestamp: 1234567890,
      phase: 'start',
      data: { messageCount: 42 },
    };
    stream.publish(event);

    const stored = stream.getRecent(1)[0];
    expect(stored.type).toBe('memory:flush');
    expect(stored.botId).toBe('finny');
    expect(stored.timestamp).toBe(1234567890);
    expect(stored.phase).toBe('start');
    expect(stored.data).toEqual({ messageCount: 42 });
  });
});

describe('LlmStatsTracker', () => {
  let stream: ActivityStream;

  beforeEach(() => {
    stream = new ActivityStream();
  });

  test('tracks successful LLM calls', () => {
    stream.publish({
      type: 'llm:end',
      botId: 'bot1',
      timestamp: 1000,
      data: { durationMs: 500, caller: 'planner' },
    });

    const stats = stream.llmStats.getStats('bot1')!;
    expect(stats.totalCalls).toBe(1);
    expect(stats.successCount).toBe(1);
    expect(stats.failCount).toBe(0);
    expect(stats.totalDurationMs).toBe(500);
    expect(stats.avgDurationMs).toBe(500);
    expect(stats.lastCallAt).toBe(1000);
    expect(stats.lastError).toBeNull();
  });

  test('tracks multiple success calls with correct avg', () => {
    stream.publish({
      type: 'llm:end',
      botId: 'bot1',
      timestamp: 1000,
      data: { durationMs: 200, caller: 'planner' },
    });
    stream.publish({
      type: 'llm:end',
      botId: 'bot1',
      timestamp: 2000,
      data: { durationMs: 400, caller: 'executor' },
    });

    const stats = stream.llmStats.getStats('bot1')!;
    expect(stats.totalCalls).toBe(2);
    expect(stats.successCount).toBe(2);
    expect(stats.totalDurationMs).toBe(600);
    expect(stats.avgDurationMs).toBe(300);
    expect(stats.lastCallAt).toBe(2000);
  });

  test('tracks error calls', () => {
    stream.publish({
      type: 'llm:error',
      botId: 'bot1',
      timestamp: 1000,
      data: { durationMs: 100, caller: 'executor', error: 'timeout' },
    });

    const stats = stream.llmStats.getStats('bot1')!;
    expect(stats.totalCalls).toBe(1);
    expect(stats.successCount).toBe(0);
    expect(stats.failCount).toBe(1);
    expect(stats.lastError).toBe('timeout');
    expect(stats.totalDurationMs).toBe(100);
  });

  test('tracks fallback count', () => {
    stream.publish({
      type: 'llm:fallback',
      botId: 'bot1',
      timestamp: 1000,
      data: { primaryBackend: 'claude-cli', fallbackBackend: 'ollama' },
    });
    stream.publish({
      type: 'llm:fallback',
      botId: 'bot1',
      timestamp: 2000,
      data: { primaryBackend: 'claude-cli', fallbackBackend: 'ollama' },
    });

    const stats = stream.llmStats.getStats('bot1')!;
    expect(stats.fallbackCount).toBe(2);
    // Fallbacks don't count as calls (they just tag that a fallback happened)
    expect(stats.totalCalls).toBe(0);
  });

  test('tracks caller breakdown', () => {
    stream.publish({
      type: 'llm:end',
      botId: 'bot1',
      timestamp: 1000,
      data: { durationMs: 200, caller: 'planner' },
    });
    stream.publish({
      type: 'llm:end',
      botId: 'bot1',
      timestamp: 2000,
      data: { durationMs: 300, caller: 'planner' },
    });
    stream.publish({
      type: 'llm:error',
      botId: 'bot1',
      timestamp: 3000,
      data: { durationMs: 50, caller: 'executor', error: 'fail' },
    });
    stream.publish({
      type: 'llm:end',
      botId: 'bot1',
      timestamp: 4000,
      data: { durationMs: 1000, caller: 'executor' },
    });

    const stats = stream.llmStats.getStats('bot1')!;
    expect(stats.callerBreakdown.planner).toEqual({
      calls: 2,
      totalDurationMs: 500,
      errors: 0,
    });
    expect(stats.callerBreakdown.executor).toEqual({
      calls: 2,
      totalDurationMs: 1050,
      errors: 1,
    });
  });

  test('clearForBot removes stats for that bot', () => {
    stream.publish({
      type: 'llm:end',
      botId: 'bot1',
      timestamp: 1000,
      data: { durationMs: 100, caller: 'planner' },
    });
    stream.publish({
      type: 'llm:end',
      botId: 'bot2',
      timestamp: 2000,
      data: { durationMs: 200, caller: 'planner' },
    });

    stream.clearForBot('bot1');

    expect(stream.llmStats.getStats('bot1')).toBeUndefined();
    expect(stream.llmStats.getStats('bot2')).toBeDefined();
  });

  test('getAllStats returns stats for all bots', () => {
    stream.publish({
      type: 'llm:end',
      botId: 'bot1',
      timestamp: 1000,
      data: { durationMs: 100, caller: 'planner' },
    });
    stream.publish({
      type: 'llm:end',
      botId: 'bot2',
      timestamp: 2000,
      data: { durationMs: 200, caller: 'executor' },
    });

    const all = stream.llmStats.getAllStats();
    expect(all).toHaveLength(2);
    expect(all.map((s) => s.botId).sort()).toEqual(['bot1', 'bot2']);
  });

  test('getStats returns undefined for unknown bot', () => {
    expect(stream.llmStats.getStats('nonexistent')).toBeUndefined();
  });

  test('keeps separate stats per bot', () => {
    stream.publish({
      type: 'llm:end',
      botId: 'bot1',
      timestamp: 1000,
      data: { durationMs: 100, caller: 'planner' },
    });
    stream.publish({
      type: 'llm:error',
      botId: 'bot2',
      timestamp: 2000,
      data: { durationMs: 50, caller: 'executor', error: 'err' },
    });

    const s1 = stream.llmStats.getStats('bot1')!;
    const s2 = stream.llmStats.getStats('bot2')!;

    expect(s1.successCount).toBe(1);
    expect(s1.failCount).toBe(0);
    expect(s2.successCount).toBe(0);
    expect(s2.failCount).toBe(1);
  });

  test('tracks token usage from llm:end events', () => {
    stream.publish({
      type: 'llm:end',
      botId: 'bot1',
      timestamp: 1000,
      data: { durationMs: 300, caller: 'planner', model: 'llama3', tokensIn: 100, tokensOut: 50 },
    });

    const stats = stream.llmStats.getStats('bot1')!;
    expect(stats.totalPromptTokens).toBe(100);
    expect(stats.totalCompletionTokens).toBe(50);
    expect(stats.modelBreakdown).toEqual({
      llama3: {
        model: 'llama3',
        promptTokens: 100,
        completionTokens: 50,
        totalTokens: 150,
        calls: 1,
      },
    });
  });

  test('accumulates tokens across multiple calls', () => {
    stream.publish({
      type: 'llm:end',
      botId: 'bot1',
      timestamp: 1000,
      data: { durationMs: 200, caller: 'planner', model: 'llama3', tokensIn: 100, tokensOut: 50 },
    });
    stream.publish({
      type: 'llm:end',
      botId: 'bot1',
      timestamp: 2000,
      data: { durationMs: 400, caller: 'executor', model: 'llama3', tokensIn: 200, tokensOut: 80 },
    });

    const stats = stream.llmStats.getStats('bot1')!;
    expect(stats.totalPromptTokens).toBe(300);
    expect(stats.totalCompletionTokens).toBe(130);
    expect(stats.modelBreakdown.llama3.calls).toBe(2);
    expect(stats.modelBreakdown.llama3.totalTokens).toBe(430);
  });

  test('tracks per-model breakdown with multiple models', () => {
    stream.publish({
      type: 'llm:end',
      botId: 'bot1',
      timestamp: 1000,
      data: { durationMs: 200, caller: 'planner', model: 'llama3', tokensIn: 100, tokensOut: 50 },
    });
    stream.publish({
      type: 'llm:end',
      botId: 'bot1',
      timestamp: 2000,
      data: { durationMs: 500, caller: 'executor', model: 'claude', tokensIn: 500, tokensOut: 200 },
    });
    stream.publish({
      type: 'llm:end',
      botId: 'bot1',
      timestamp: 3000,
      data: {
        durationMs: 300,
        caller: 'strategist',
        model: 'llama3',
        tokensIn: 150,
        tokensOut: 60,
      },
    });

    const stats = stream.llmStats.getStats('bot1')!;
    expect(stats.totalPromptTokens).toBe(750);
    expect(stats.totalCompletionTokens).toBe(310);

    expect(Object.keys(stats.modelBreakdown)).toHaveLength(2);

    expect(stats.modelBreakdown.llama3).toEqual({
      model: 'llama3',
      promptTokens: 250,
      completionTokens: 110,
      totalTokens: 360,
      calls: 2,
    });
    expect(stats.modelBreakdown.claude).toEqual({
      model: 'claude',
      promptTokens: 500,
      completionTokens: 200,
      totalTokens: 700,
      calls: 1,
    });
  });

  test('ignores token data when model is missing', () => {
    stream.publish({
      type: 'llm:end',
      botId: 'bot1',
      timestamp: 1000,
      data: { durationMs: 200, caller: 'planner', tokensIn: 100, tokensOut: 50 },
    });

    const stats = stream.llmStats.getStats('bot1')!;
    expect(stats.totalPromptTokens).toBe(0);
    expect(stats.totalCompletionTokens).toBe(0);
    expect(Object.keys(stats.modelBreakdown)).toHaveLength(0);
  });

  test('tracks tokens from llm:error events too', () => {
    stream.publish({
      type: 'llm:error',
      botId: 'bot1',
      timestamp: 1000,
      data: {
        durationMs: 100,
        caller: 'executor',
        error: 'timeout',
        model: 'llama3',
        tokensIn: 80,
        tokensOut: 10,
      },
    });

    const stats = stream.llmStats.getStats('bot1')!;
    expect(stats.totalPromptTokens).toBe(80);
    expect(stats.totalCompletionTokens).toBe(10);
    expect(stats.modelBreakdown.llama3.calls).toBe(1);
  });

  test('initializes token fields to zero for new bots', () => {
    stream.publish({
      type: 'llm:end',
      botId: 'bot1',
      timestamp: 1000,
      data: { durationMs: 100, caller: 'planner' },
    });

    const stats = stream.llmStats.getStats('bot1')!;
    expect(stats.totalPromptTokens).toBe(0);
    expect(stats.totalCompletionTokens).toBe(0);
    expect(stats.modelBreakdown).toEqual({});
  });
});

describe('LlmStatsTracker persistence', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `llm-stats-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('flushToDisk writes per-bot JSON files', () => {
    const stream = new ActivityStream(undefined, tmpDir);
    stream.publish({
      type: 'llm:end',
      botId: 'bot1',
      timestamp: 1000,
      data: { durationMs: 200, caller: 'planner', model: 'llama3', tokensIn: 100, tokensOut: 50 },
    });

    stream.llmStats.flushToDisk();

    const filePath = join(tmpDir, 'bot1.json');
    expect(existsSync(filePath)).toBe(true);
    const data = JSON.parse(readFileSync(filePath, 'utf-8'));
    expect(data.botId).toBe('bot1');
    expect(data.totalPromptTokens).toBe(100);
    expect(data.totalCompletionTokens).toBe(50);
    expect(data.modelBreakdown.llama3.calls).toBe(1);
  });

  test('loads persisted stats on construction', () => {
    const stats: LlmBotStats = {
      botId: 'bot1',
      totalCalls: 5,
      successCount: 4,
      failCount: 1,
      fallbackCount: 0,
      totalDurationMs: 2000,
      avgDurationMs: 400,
      lastCallAt: 9999,
      lastError: null,
      callerBreakdown: {},
      totalPromptTokens: 500,
      totalCompletionTokens: 200,
      modelBreakdown: {
        llama3: {
          model: 'llama3',
          promptTokens: 500,
          completionTokens: 200,
          totalTokens: 700,
          calls: 5,
        },
      },
    };
    writeFileSync(join(tmpDir, 'bot1.json'), JSON.stringify(stats), 'utf-8');

    const stream = new ActivityStream(undefined, tmpDir);
    const loaded = stream.llmStats.getStats('bot1')!;
    expect(loaded.totalCalls).toBe(5);
    expect(loaded.totalPromptTokens).toBe(500);
    expect(loaded.modelBreakdown.llama3.calls).toBe(5);
  });

  test('new events accumulate on top of loaded stats', () => {
    const stats: LlmBotStats = {
      botId: 'bot1',
      totalCalls: 2,
      successCount: 2,
      failCount: 0,
      fallbackCount: 0,
      totalDurationMs: 1000,
      avgDurationMs: 500,
      lastCallAt: 5000,
      lastError: null,
      callerBreakdown: {},
      totalPromptTokens: 300,
      totalCompletionTokens: 100,
      modelBreakdown: {
        llama3: {
          model: 'llama3',
          promptTokens: 300,
          completionTokens: 100,
          totalTokens: 400,
          calls: 2,
        },
      },
    };
    writeFileSync(join(tmpDir, 'bot1.json'), JSON.stringify(stats), 'utf-8');

    const stream = new ActivityStream(undefined, tmpDir);
    stream.publish({
      type: 'llm:end',
      botId: 'bot1',
      timestamp: 6000,
      data: { durationMs: 400, caller: 'executor', model: 'llama3', tokensIn: 150, tokensOut: 60 },
    });

    const updated = stream.llmStats.getStats('bot1')!;
    expect(updated.totalCalls).toBe(3);
    expect(updated.totalPromptTokens).toBe(450);
    expect(updated.totalCompletionTokens).toBe(160);
    expect(updated.modelBreakdown.llama3.calls).toBe(3);
  });

  test('clearForBot removes the persisted file', () => {
    const stream = new ActivityStream(undefined, tmpDir);
    stream.publish({
      type: 'llm:end',
      botId: 'bot1',
      timestamp: 1000,
      data: { durationMs: 100, caller: 'planner', model: 'llama3', tokensIn: 50, tokensOut: 20 },
    });
    stream.llmStats.flushToDisk();

    expect(existsSync(join(tmpDir, 'bot1.json'))).toBe(true);

    stream.clearForBot('bot1');
    expect(existsSync(join(tmpDir, 'bot1.json'))).toBe(false);
    expect(stream.llmStats.getStats('bot1')).toBeUndefined();
  });

  test('handles missing dataDir gracefully (no persistence)', () => {
    const stream = new ActivityStream();
    stream.publish({
      type: 'llm:end',
      botId: 'bot1',
      timestamp: 1000,
      data: { durationMs: 100, caller: 'planner', model: 'llama3', tokensIn: 50, tokensOut: 20 },
    });
    stream.llmStats.flushToDisk();
    expect(stream.llmStats.getStats('bot1')!.totalPromptTokens).toBe(50);
  });

  test('skips malformed JSON files during load', () => {
    writeFileSync(join(tmpDir, 'bad.json'), 'not valid json', 'utf-8');
    writeFileSync(join(tmpDir, 'nobotid.json'), JSON.stringify({ totalCalls: 1 }), 'utf-8');

    const stream = new ActivityStream(undefined, tmpDir);
    expect(stream.llmStats.getAllStats()).toHaveLength(0);
  });
});
