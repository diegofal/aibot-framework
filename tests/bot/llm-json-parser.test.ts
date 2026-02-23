import { describe, it, expect, vi, beforeEach } from 'vitest';
import { parseLLMJson } from '../../src/bot/llm-json-parser';

const mockLogger = { warn: vi.fn() };

interface TestResult {
  reasoning: string;
  plan: string[];
}

const plannerOpts = {
  extractPattern: /\{[\s\S]*"plan"[\s\S]*\}/,
  validate: (parsed: any): TestResult | null => {
    if (!parsed.reasoning || !Array.isArray(parsed.plan)) return null;
    return { reasoning: String(parsed.reasoning), plan: parsed.plan.map(String) };
  },
  label: 'planner',
};

describe('parseLLMJson', () => {
  beforeEach(() => {
    mockLogger.warn.mockClear();
  });

  it('parses clean JSON', () => {
    const raw = '{"reasoning": "test", "plan": ["step1", "step2"]}';
    const result = parseLLMJson<TestResult>(raw, mockLogger, plannerOpts);
    expect(result).toEqual({ reasoning: 'test', plan: ['step1', 'step2'] });
    expect(mockLogger.warn).not.toHaveBeenCalled();
  });

  it('parses fenced JSON (```json)', () => {
    const raw = '```json\n{"reasoning": "fenced", "plan": ["a"]}\n```';
    const result = parseLLMJson<TestResult>(raw, mockLogger, plannerOpts);
    expect(result).toEqual({ reasoning: 'fenced', plan: ['a'] });
  });

  it('parses fenced JSON (``` without language tag)', () => {
    const raw = '```\n{"reasoning": "bare fence", "plan": []}\n```';
    const result = parseLLMJson<TestResult>(raw, mockLogger, plannerOpts);
    expect(result).toEqual({ reasoning: 'bare fence', plan: [] });
  });

  it('extracts JSON from surrounding prose', () => {
    const raw = 'Here is my plan:\n{"reasoning": "extracted", "plan": ["x"]}\nHope it helps!';
    const result = parseLLMJson<TestResult>(raw, mockLogger, plannerOpts);
    expect(result).toEqual({ reasoning: 'extracted', plan: ['x'] });
  });

  it('returns null for invalid JSON', () => {
    const raw = 'not json at all {broken';
    const result = parseLLMJson<TestResult>(raw, mockLogger, plannerOpts);
    expect(result).toBeNull();
    expect(mockLogger.warn).toHaveBeenCalledTimes(1);
    expect(mockLogger.warn.mock.calls[0][1]).toContain('failed to parse planner JSON');
  });

  it('returns null when validate returns null', () => {
    const raw = '{"something": "else"}';
    const result = parseLLMJson<TestResult>(raw, mockLogger, plannerOpts);
    expect(result).toBeNull();
    expect(mockLogger.warn).toHaveBeenCalledTimes(1);
    expect(mockLogger.warn.mock.calls[0][1]).toContain('missing required fields');
  });

  it('handles whitespace around JSON', () => {
    const raw = '  \n  {"reasoning": "spaced", "plan": ["b"]}  \n  ';
    const result = parseLLMJson<TestResult>(raw, mockLogger, plannerOpts);
    expect(result).toEqual({ reasoning: 'spaced', plan: ['b'] });
  });

  it('uses custom extractPattern', () => {
    const opts = {
      extractPattern: /\{[\s\S]*"focus"[\s\S]*\}/,
      validate: (parsed: any) => (parsed.focus ? { focus: parsed.focus } : null),
      label: 'strategist',
    };
    const raw = 'My analysis: {"focus": "do something", "reflection": "ok"} end';
    const result = parseLLMJson<{ focus: string }>(raw, mockLogger, opts);
    expect(result).toEqual({ focus: 'do something' });
  });

  it('handles empty string', () => {
    const result = parseLLMJson<TestResult>('', mockLogger, plannerOpts);
    expect(result).toBeNull();
  });

  it('truncates raw in log to 300 chars for validation failures', () => {
    const raw = '{"missing_fields": true, ' + '"x": "'.padEnd(400, 'a') + '"}';
    parseLLMJson<TestResult>(raw, mockLogger, plannerOpts);
    expect(mockLogger.warn).toHaveBeenCalled();
    const loggedRaw = mockLogger.warn.mock.calls[0][0].raw;
    expect(loggedRaw.length).toBeLessThanOrEqual(300);
  });

  it('truncates raw in log to 500 chars for parse failures', () => {
    const raw = '{broken json'.padEnd(600, 'x');
    parseLLMJson<TestResult>(raw, mockLogger, plannerOpts);
    expect(mockLogger.warn).toHaveBeenCalled();
    const loggedRaw = mockLogger.warn.mock.calls[0][0].raw;
    expect(loggedRaw.length).toBeLessThanOrEqual(500);
  });
});
