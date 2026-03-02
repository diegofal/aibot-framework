import { beforeEach, describe, expect, test } from 'bun:test';
import {
  SignalCompletionTool,
  createSignalCompletionTool,
} from '../../src/tools/signal-completion';

function createMockLogger() {
  return {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    child: () => createMockLogger(),
    fatal: () => {},
    trace: () => {},
    level: 'info',
    silent: () => {},
  } as any;
}

const logger = createMockLogger();

describe('signal_completion tool', () => {
  beforeEach(() => {
    SignalCompletionTool.reset();
  });

  test('createSignalCompletionTool returns a tool with correct definition', () => {
    const tool = createSignalCompletionTool();
    expect(tool.definition.function.name).toBe('signal_completion');
    expect(tool.definition.type).toBe('function');
    expect(tool.definition.function.parameters.required).toEqual(['summary', 'complete']);
  });

  test('createSignalCompletionTool resets static state', () => {
    // Set some state first
    const tool = createSignalCompletionTool();
    tool.execute({ summary: 'done', complete: true }, logger);
    expect(SignalCompletionTool.isCompletionRequested()).toBe(true);

    // Creating a new tool resets state
    createSignalCompletionTool();
    expect(SignalCompletionTool.isCompletionRequested()).toBe(false);
  });

  test('isCompletionRequested returns false initially', () => {
    expect(SignalCompletionTool.isCompletionRequested()).toBe(false);
  });

  test('execute with complete=true signals completion', async () => {
    const tool = createSignalCompletionTool();
    const result = await tool.execute({ summary: 'Task finished', complete: true }, logger);

    expect(result.success).toBe(true);
    expect(result.content).toContain('Deliverable complete');
    expect(result.content).toContain('Task finished');
    expect(SignalCompletionTool.isCompletionRequested()).toBe(true);

    const status = SignalCompletionTool.getCompletionStatus();
    expect(status.summary).toBe('Task finished');
    expect(status.complete).toBe(true);
  });

  test('execute with complete=false signals partial progress', async () => {
    const tool = createSignalCompletionTool();
    const result = await tool.execute({ summary: 'Halfway there', complete: false }, logger);

    expect(result.success).toBe(true);
    expect(result.content).toContain('Partial progress');
    expect(result.content).toContain('Halfway there');
    expect(SignalCompletionTool.isCompletionRequested()).toBe(true);

    const status = SignalCompletionTool.getCompletionStatus();
    expect(status.summary).toBe('Halfway there');
    expect(status.complete).toBe(false);
  });

  test('reset clears all static state', async () => {
    const tool = createSignalCompletionTool();
    await tool.execute({ summary: 'done', complete: true }, logger);

    SignalCompletionTool.reset();

    expect(SignalCompletionTool.isCompletionRequested()).toBe(false);
    const status = SignalCompletionTool.getCompletionStatus();
    expect(status.summary).toBe('');
    expect(status.complete).toBe(false);
  });

  test('execute handles missing summary gracefully', async () => {
    const tool = createSignalCompletionTool();
    const result = await tool.execute({ complete: true }, logger);

    expect(result.success).toBe(true);
    expect(SignalCompletionTool.isCompletionRequested()).toBe(true);
    const status = SignalCompletionTool.getCompletionStatus();
    expect(status.summary).toBe('');
  });
});
