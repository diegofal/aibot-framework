import { describe, expect, it } from 'bun:test';
import {
  agentClaudeModel,
  claudeModelSelect,
  effectiveModelLabel,
  showClaudeModelSelect,
} from '../../web/pages/agent-form-helpers.js';

const defaults = {
  model: 'glm-5.2:cloud',
  claudeCliModel: 'claude-opus-5',
  claudeCliModels: [
    { value: '', label: 'CLI default' },
    { value: 'opus', label: 'Opus (latest)' },
    { value: 'claude-opus-5', label: 'Opus 5 (pinned)' },
  ],
};

describe('agentClaudeModel', () => {
  it('returns the pinned model only for claude-cli agents', () => {
    expect(agentClaudeModel({ llmBackend: 'claude-cli', model: 'opus' })).toBe('opus');
    expect(agentClaudeModel({ llmBackend: 'claude-cli' })).toBe('');
    expect(agentClaudeModel({ llmBackend: 'ollama', model: 'qwen' })).toBe('');
    expect(agentClaudeModel(undefined)).toBe('');
  });
});

describe('claudeModelSelect', () => {
  it('offers the global default first, skipping the empty server entry', () => {
    const html = claudeModelSelect(defaults, { llmBackend: 'claude-cli' });
    expect(html).toContain('<option value="" selected>Global default (claude-opus-5)</option>');
    expect(html.match(/<option/g)).toHaveLength(3);
    expect(html).toContain('<option value="opus">Opus (latest)</option>');
  });
  it('selects the pinned model and keeps an unknown one as custom', () => {
    expect(claudeModelSelect(defaults, { llmBackend: 'claude-cli', model: 'opus' })).toContain(
      '<option value="opus" selected>'
    );
    const custom = claudeModelSelect(defaults, { llmBackend: 'claude-cli', model: 'claude-x<1>' });
    expect(custom).toContain(
      '<option value="claude-x&lt;1&gt;" selected>claude-x&lt;1&gt; (custom)</option>'
    );
    expect(custom).toContain('<option value="">Global default');
  });
  it('says CLI default when no fleet-wide model is set', () => {
    expect(claudeModelSelect({ claudeCliModels: [] }, {})).toContain(
      'Global default (CLI default)'
    );
  });
});

describe('effectiveModelLabel', () => {
  it('describes claude-cli agents with their pinned or global model', () => {
    expect(effectiveModelLabel({ llmBackend: 'claude-cli', model: 'opus' }, defaults)).toEqual({
      text: 'claude-cli · opus',
      global: false,
    });
    expect(effectiveModelLabel({ llmBackend: 'claude-cli' }, defaults)).toEqual({
      text: 'claude-cli · claude-opus-5',
      global: true,
    });
    expect(effectiveModelLabel({ llmBackend: 'claude-cli' }, {})).toEqual({
      text: 'claude-cli · CLI default',
      global: true,
    });
  });
  it('describes ollama agents with their model or the global one', () => {
    expect(effectiveModelLabel({ model: 'qwen' }, defaults)).toEqual({
      text: 'qwen',
      global: false,
    });
    expect(effectiveModelLabel({}, defaults)).toEqual({ text: 'glm-5.2:cloud', global: true });
  });
});

describe('showClaudeModelSelect', () => {
  it('is visible only for the claude-cli choice', () => {
    expect(showClaudeModelSelect('claude-cli')).toBe(true);
    expect(showClaudeModelSelect('qwen')).toBe(false);
    expect(showClaudeModelSelect('')).toBe(false);
  });
});
