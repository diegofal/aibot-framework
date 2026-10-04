import { describe, expect, it } from 'bun:test';
import {
  applyField,
  draftFromState,
  fromAgentPicker,
  hasWizardInput,
  initialState,
  restoreDraft,
  stateFromAgent,
  stepIndicator,
} from '../../web/pages/agent-wizard-helpers.js';

describe('hasWizardInput', () => {
  it('is false for a fresh wizard and true once something is typed', () => {
    const s = initialState();
    expect(hasWizardInput(s)).toBe(false);
    expect(hasWizardInput(applyField(s, 'name', 'Ada'))).toBe(true);
    expect(hasWizardInput(applyField(s, 'purpose', 'x'))).toBe(true);
    expect(hasWizardInput(applyField(s, 'personality.warmth', 0.9))).toBe(true);
    expect(hasWizardInput(applyField(s, 'channels.telegram.enabled', true))).toBe(true);
    expect(hasWizardInput(null)).toBe(false);
  });
});

describe('draftFromState / restoreDraft', () => {
  it('round-trips the typed fields and step', () => {
    let s = initialState();
    s = applyField(s, 'name', 'Ada');
    s = applyField(s, 'purpose', 'Reads things for me');
    s = applyField(s, 'advanced.skills', 'a, b');
    s = { ...s, step: 2 };
    const back = restoreDraft(draftFromState(s));
    expect(back?.name).toBe('Ada');
    expect(back?.id).toBe('ada');
    expect(back?.purpose).toBe('Reads things for me');
    expect(back?.advanced.skills).toBe('a, b');
    expect(back?.step).toBe(2);
  });
  it('never stores channel secrets', () => {
    let s = applyField(initialState(), 'name', 'Ada');
    s = applyField(s, 'channels.telegram.enabled', true);
    s = applyField(s, 'channels.telegram.token', '123456:SECRET');
    s = applyField(s, 'channels.whatsapp.accessToken', 'wa-secret');
    s = applyField(s, 'channels.whatsapp.verifyToken', 'vt-secret');
    s = applyField(s, 'channels.discord.token', 'disc-secret');
    s = applyField(s, 'tokenChecks.telegram', { state: 'ok' });
    const raw = draftFromState(s);
    expect(raw).not.toContain('SECRET');
    expect(raw).not.toContain('wa-secret');
    expect(raw).not.toContain('vt-secret');
    expect(raw).not.toContain('disc-secret');
    const back = restoreDraft(raw);
    expect(back?.channels.telegram.enabled).toBe(true);
    expect(back?.channels.telegram.token).toBe('');
    expect(back?.tokenChecks).toEqual({});
  });
  it('returns null for garbage, empty drafts and missing input', () => {
    expect(restoreDraft(null)).toBe(null);
    expect(restoreDraft('{oops')).toBe(null);
    expect(restoreDraft('"str"')).toBe(null);
    expect(restoreDraft(draftFromState(initialState()))).toBe(null);
  });
  it('clamps the step and fills fields a newer state shape added', () => {
    const back = restoreDraft(JSON.stringify({ name: 'Ada', step: 99 }));
    expect(back?.step).toBe(2);
    expect(back?.channels.web).toBe(true);
    expect(back?.advanced.language).toBe('Spanish');
  });
});

describe('stateFromAgent', () => {
  it('prefills the reusable config but never the name, id or credentials', () => {
    const agent = {
      id: 'src',
      name: 'Source',
      token: '1234****abcd',
      llmBackend: 'claude-cli',
      model: 'opus',
      skills: ['reminders', 'quick-notes'],
      disabledTools: ['exec'],
      agentLoop: { every: '2h', mode: 'continuous' },
      preset: 'researcher',
    };
    const s = stateFromAgent(agent, initialState());
    expect(s.name).toBe('');
    expect(s.id).toBe('');
    expect(s.advanced.llmBackend).toBe('claude-cli');
    expect(s.advanced.model).toBe('opus');
    expect(s.advanced.skills).toBe('reminders, quick-notes');
    expect(s.advanced.disabledTools).toBe('exec');
    expect(s.advanced.loopEvery).toBe('2h');
    expect(s.advanced.loopMode).toBe('continuous');
    expect(s.advanced.open).toBe(true);
    expect(s.preset).toBe('researcher');
    expect(s.fromAgent).toBe('src');
    expect(JSON.stringify(s)).not.toContain('1234');
  });
  it('maps an ollama model without a backend and tolerates a bare agent', () => {
    const s = stateFromAgent({ id: 'x', model: 'llama3' }, initialState());
    expect(s.advanced.llmBackend).toBe('ollama');
    expect(s.advanced.model).toBe('llama3');
    const bare = stateFromAgent({ id: 'y' }, initialState());
    expect(bare.advanced.llmBackend).toBe('');
    expect(bare.fromAgent).toBe('y');
  });
});

describe('fromAgentPicker', () => {
  it('lists agents with a blank first option, escaped and selected', () => {
    const html = fromAgentPicker(
      [
        { id: 'a', name: 'Ada' },
        { id: 'b', name: '<Bob>' },
      ],
      'b'
    );
    expect(html).toContain('data-from-agent');
    expect(html).toContain('<option value="">');
    expect(html).toContain('&lt;Bob&gt;');
    expect(html).toMatch(/value="b" selected/);
  });
  it('renders nothing without agents', () => {
    expect(fromAgentPicker([], '')).toBe('');
    expect(fromAgentPicker(null, '')).toBe('');
  });
});

describe('stepIndicator jumps', () => {
  it('makes completed steps clickable and leaves the rest static', () => {
    const html = stepIndicator(2);
    expect(html).toContain('data-step-jump="0"');
    expect(html).toContain('data-step-jump="1"');
    expect(html).not.toContain('data-step-jump="2"');
    expect(html.match(/wizard-step-done/g)?.length).toBe(2);
  });
});
