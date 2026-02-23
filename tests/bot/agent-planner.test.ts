import { describe, test, expect, vi, beforeEach } from 'bun:test';
import { parsePlannerResult, runPlannerWithRetry } from '../../src/bot/agent-planner';

const mockLogger = {
  info: vi.fn(),
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

const mockClient = {
  generate: vi.fn(),
  chat: vi.fn(),
};

beforeEach(() => {
  mockLogger.info.mockReset();
  mockLogger.debug.mockReset();
  mockLogger.warn.mockReset();
  mockLogger.error.mockReset();
  mockClient.generate.mockReset();
  mockClient.chat.mockReset();
});

describe('parsePlannerResult', () => {
  test('parses valid JSON with plan, reasoning and priority', () => {
    const raw = JSON.stringify({
      reasoning: 'Time to act',
      plan: ['step1', 'step2'],
      priority: 'high',
    });
    const result = parsePlannerResult(raw, mockLogger);
    expect(result).toEqual({
      reasoning: 'Time to act',
      plan: ['step1', 'step2'],
      priority: 'high',
    });
    expect(mockLogger.warn).not.toHaveBeenCalled();
  });

  test('defaults priority to medium when invalid', () => {
    const raw = JSON.stringify({
      reasoning: 'Something to do',
      plan: ['action1'],
      priority: 'urgent',
    });
    const result = parsePlannerResult(raw, mockLogger);
    expect(result).toEqual({
      reasoning: 'Something to do',
      plan: ['action1'],
      priority: 'medium',
    });
  });

  test('defaults priority to medium when missing', () => {
    const raw = JSON.stringify({
      reasoning: 'No priority given',
      plan: ['task1'],
    });
    const result = parsePlannerResult(raw, mockLogger);
    expect(result).toEqual({
      reasoning: 'No priority given',
      plan: ['task1'],
      priority: 'medium',
    });
  });

  test('returns null when plan is empty but priority is not none', () => {
    const raw = JSON.stringify({
      reasoning: 'Nothing to do but said high',
      plan: [],
      priority: 'high',
    });
    const result = parsePlannerResult(raw, mockLogger);
    expect(result).toBeNull();
    expect(mockLogger.warn).toHaveBeenCalled();
  });

  test('returns valid result when plan is empty and priority is none', () => {
    const raw = JSON.stringify({
      reasoning: 'Nothing to do right now',
      plan: [],
      priority: 'none',
    });
    const result = parsePlannerResult(raw, mockLogger);
    expect(result).toEqual({
      reasoning: 'Nothing to do right now',
      plan: [],
      priority: 'none',
    });
  });

  test('returns null for invalid JSON', () => {
    const raw = 'this is not valid json {broken';
    const result = parsePlannerResult(raw, mockLogger);
    expect(result).toBeNull();
    expect(mockLogger.warn).toHaveBeenCalled();
  });

  test('extracts fenced JSON from markdown code block', () => {
    const raw = '```json\n{"reasoning": "fenced", "plan": ["a"], "priority": "low"}\n```';
    const result = parsePlannerResult(raw, mockLogger);
    expect(result).toEqual({
      reasoning: 'fenced',
      plan: ['a'],
      priority: 'low',
    });
  });

  test('extracts JSON from surrounding prose', () => {
    const raw =
      'Here is my analysis:\n{"reasoning": "extracted", "plan": ["x"], "priority": "high"}\nEnd of output.';
    const result = parsePlannerResult(raw, mockLogger);
    expect(result).toEqual({
      reasoning: 'extracted',
      plan: ['x'],
      priority: 'high',
    });
  });

  test('returns null when reasoning is missing', () => {
    const raw = JSON.stringify({ plan: ['step1'], priority: 'high' });
    const result = parsePlannerResult(raw, mockLogger);
    expect(result).toBeNull();
  });

  test('returns null when plan is not an array', () => {
    const raw = JSON.stringify({
      reasoning: 'has reasoning',
      plan: 'not an array',
      priority: 'high',
    });
    const result = parsePlannerResult(raw, mockLogger);
    expect(result).toBeNull();
  });
});

describe('runPlannerWithRetry', () => {
  const plannerInput = {
    system: 'You are a planner',
    prompt: 'What should I do?',
  };
  const model = 'test-model';

  test('succeeds on first attempt', async () => {
    const validResponse = JSON.stringify({
      reasoning: 'First try success',
      plan: ['do something'],
      priority: 'high',
    });
    mockClient.generate.mockResolvedValueOnce(validResponse);

    const result = await runPlannerWithRetry(
      mockClient as any,
      plannerInput,
      model,
      mockLogger as any,
    );

    expect(result).toEqual({
      reasoning: 'First try success',
      plan: ['do something'],
      priority: 'high',
    });
    expect(mockClient.generate).toHaveBeenCalledTimes(1);
    expect(mockClient.generate).toHaveBeenCalledWith(plannerInput.prompt, {
      system: plannerInput.system,
      model,
      temperature: 0.3,
    });
    expect(mockLogger.info).not.toHaveBeenCalled();
  });

  test('fails first then succeeds with temperature 0', async () => {
    const invalidResponse = 'not valid json';
    const validResponse = JSON.stringify({
      reasoning: 'Retry success',
      plan: ['retried action'],
      priority: 'medium',
    });
    mockClient.generate
      .mockResolvedValueOnce(invalidResponse)
      .mockResolvedValueOnce(validResponse);

    const result = await runPlannerWithRetry(
      mockClient as any,
      plannerInput,
      model,
      mockLogger as any,
    );

    expect(result).toEqual({
      reasoning: 'Retry success',
      plan: ['retried action'],
      priority: 'medium',
    });
    expect(mockClient.generate).toHaveBeenCalledTimes(2);
    // First attempt: temperature 0.3
    expect(mockClient.generate.mock.calls[0][1]).toEqual({
      system: plannerInput.system,
      model,
      temperature: 0.3,
    });
    // Second attempt: temperature 0
    expect(mockClient.generate.mock.calls[1][1]).toEqual({
      system: plannerInput.system,
      model,
      temperature: 0,
    });
    expect(mockLogger.warn).toHaveBeenCalled();
    expect(mockLogger.info).toHaveBeenCalledWith(
      { attempt: 1 },
      'Agent loop: planner succeeded on retry',
    );
  });

  test('returns fallback idle plan after all retries fail', async () => {
    mockClient.generate
      .mockResolvedValueOnce('garbage1')
      .mockResolvedValueOnce('garbage2');

    const result = await runPlannerWithRetry(
      mockClient as any,
      plannerInput,
      model,
      mockLogger as any,
    );

    expect(result).toEqual({
      reasoning: 'Failed to parse planner output after retries',
      plan: [],
      priority: 'none',
    });
    expect(mockClient.generate).toHaveBeenCalledTimes(2);
  });
});
