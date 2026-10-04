/**
 * Automations box (session S8 of docs/plans/jarvis-fleet-plan.md). Pure
 * helpers only: request building for /api/cron/parse and /api/cron, the
 * preview card markup and the cron -> human mirror for the editable field.
 */
import { describe, expect, it } from 'bun:test';
import {
  AUTOMATION_PLACEHOLDER,
  CONFIDENCE_TONE,
  agentOptions,
  automationBox,
  buildCreateRequest,
  buildParseRequest,
  cronToHuman,
  describeSource,
  isCronExpr,
  pickDefaultAgent,
  previewCard,
  targetLabel,
} from '../../web/pages/automations-helpers.js';

const TZ = 'America/Argentina/Buenos_Aires';
const AGENTS = [
  { id: 'echo', name: 'Echo', enabled: true, running: false },
  { id: 'hunter', name: 'Hunter <b>', enabled: true, running: true },
  { id: 'off', name: 'Off', enabled: false, running: false },
];
const PROPOSAL = {
  schedule: '0 */3 * * *',
  tz: TZ,
  scheduleHuman: `Every 3 hours (${TZ})`,
  nextRunAt: '2026-09-14T18:00:00.000Z',
  instruction: 'Check job boards',
  name: 'Check job boards',
  botId: 'hunter',
  chatId: 'operator',
  operatorChatId: 4242,
  confidence: 'high',
  explanation: 'Every three hours, report to you.',
  warnings: [],
  source: 'llm',
  llm: { backend: 'claude-cli', model: 'claude-opus-5' },
};

describe('isCronExpr / cronToHuman (client mirror)', () => {
  it('checks the 5-field shape without a scheduler', () => {
    expect(isCronExpr('0 */3 * * *')).toBe(true);
    expect(isCronExpr('30 9 * * 1-5')).toBe(true);
    expect(isCronExpr('0 0 9 * * *')).toBe(false);
    expect(isCronExpr('every day')).toBe(false);
    expect(isCronExpr('')).toBe(false);
    expect(isCronExpr(null)).toBe(false);
  });

  it('matches the server wording for the common shapes', () => {
    expect(cronToHuman('0 */3 * * *', TZ)).toBe(`Every 3 hours (${TZ})`);
    expect(cronToHuman('*/15 * * * *')).toBe('Every 15 minutes');
    expect(cronToHuman('0 9 * * *')).toBe('Every day at 09:00');
    expect(cronToHuman('30 18 * * 1')).toBe('Every Monday at 18:30');
    expect(cronToHuman('0 9 * * 1,3,5')).toBe('Every Monday, Wednesday and Friday at 09:00');
    expect(cronToHuman('0 9 * * 1-5')).toBe('Weekdays at 09:00');
    expect(cronToHuman('0 10 * * 6,0')).toBe('Weekends at 10:00');
    expect(cronToHuman('0 9 */2 * *')).toBe('Every 2 days at 09:00');
    expect(cronToHuman('0 8 1 * *')).toBe('On day 1 of every month at 08:00');
    expect(cronToHuman('15 * * * *')).toBe('Every hour at :15');
    expect(cronToHuman('nope')).toBe('Cron "nope"');
  });
});

describe('buildParseRequest', () => {
  it('posts text and botId to /api/cron/parse', () => {
    expect(buildParseRequest('  check boards every 3 hours ', 'hunter')).toEqual({
      path: '/api/cron/parse',
      method: 'POST',
      body: { text: 'check boards every 3 hours', botId: 'hunter' },
    });
  });

  it('refuses empty text or no agent', () => {
    expect(buildParseRequest('   ', 'hunter')).toEqual({ error: expect.stringMatching(/what/i) });
    expect(buildParseRequest('x', '')).toEqual({ error: expect.stringMatching(/agent/i) });
  });
});

describe('buildCreateRequest', () => {
  it('builds the exact POST /api/cron payload the cron page already sends', () => {
    expect(buildCreateRequest(PROPOSAL)).toEqual({
      path: '/api/cron',
      method: 'POST',
      body: {
        name: 'Check job boards',
        enabled: true,
        schedule: { kind: 'cron', expr: '0 */3 * * *', tz: TZ },
        payload: { kind: 'instruction', text: 'Check job boards', chatId: 4242, botId: 'hunter' },
      },
    });
  });

  it('takes the edited cron, instruction, name and chat id over the proposal', () => {
    const r = buildCreateRequest(PROPOSAL, {
      expr: ' 0 9 * * 1 ',
      instruction: 'Check the boards and rank the roles',
      name: 'Monday boards',
      chatId: '-100123',
    });
    expect(r.body.schedule.expr).toBe('0 9 * * 1');
    expect(r.body.payload.text).toBe('Check the boards and rank the roles');
    expect(r.body.name).toBe('Monday boards');
    expect(r.body.payload.chatId).toBe(-100123);
  });

  it('uses a numeric proposal chatId as is', () => {
    const r = buildCreateRequest({ ...PROPOSAL, chatId: -100999 });
    expect(r.body.payload.chatId).toBe(-100999);
  });

  it('refuses a bad cron, an empty instruction and a missing chat id', () => {
    expect(buildCreateRequest(PROPOSAL, { expr: '0 0 9 * * *' })).toEqual({
      error: expect.stringMatching(/cron/i),
    });
    expect(buildCreateRequest(PROPOSAL, { instruction: '   ' })).toEqual({
      error: expect.stringMatching(/instruction/i),
    });
    expect(buildCreateRequest({ ...PROPOSAL, operatorChatId: null })).toEqual({
      error: expect.stringMatching(/chat id/i),
    });
    expect(buildCreateRequest(PROPOSAL, { chatId: 'abc' })).toEqual({
      error: expect.stringMatching(/chat id/i),
    });
  });

  it('derives a name from the edited instruction when none is given', () => {
    const r = buildCreateRequest({ ...PROPOSAL, name: '' }, { instruction: 'Do the thing' });
    expect(r.body.name).toBe('Do the thing');
  });
});

describe('agent picker', () => {
  it('prefers a running agent, then an enabled one, then the first', () => {
    expect(pickDefaultAgent(AGENTS)).toBe('hunter');
    expect(pickDefaultAgent([AGENTS[2], AGENTS[0]])).toBe('echo');
    expect(pickDefaultAgent([AGENTS[2]])).toBe('off');
    expect(pickDefaultAgent([])).toBe('');
  });

  it('renders escaped options with the selected one marked', () => {
    const html = agentOptions(AGENTS, 'hunter');
    expect(html).toContain('<option value="hunter" selected>Hunter &lt;b&gt; (hunter)</option>');
    expect(html).toContain('<option value="echo">Echo (echo)</option>');
    expect(html).not.toContain('<b>');
  });
});

describe('automationBox', () => {
  it('renders the one-line box with the prompt, the picker and a Parse button', () => {
    const html = automationBox({ agents: AGENTS, selectedId: 'hunter', text: '' });
    expect(html).toContain('Tell an agent what to do and when');
    expect(html).toContain('data-automation');
    expect(html).toContain('name="text"');
    expect(html).toContain(`placeholder="${AUTOMATION_PLACEHOLDER}"`);
    expect(html).toContain('name="botId"');
    expect(html).toContain('data-automation-preview');
    expect(html).toMatch(/<button[^>]*type="submit"[^>]*>Parse<\/button>/);
  });

  it('disables the button and keeps the text while busy', () => {
    const html = automationBox({ agents: AGENTS, selectedId: 'hunter', text: 'a "b"', busy: true });
    expect(html).toContain('value="a &quot;b&quot;"');
    expect(html).toMatch(/<button[^>]*disabled[^>]*>Parsing…<\/button>/);
  });

  it('says so when there is no agent to pick', () => {
    expect(automationBox({ agents: [], selectedId: '', text: '' })).toContain('No agents yet');
  });
});

describe('previewCard', () => {
  it('shows schedule, next run, instruction, target, confidence and the editable cron', () => {
    const html = previewCard(PROPOSAL, {
      agents: AGENTS,
      nowMs: Date.parse('2026-09-14T15:00:00.000Z'),
    });
    expect(html).toContain('data-automation-card');
    expect(html).toContain(`Every 3 hours (${TZ})`);
    expect(html).toContain('data-cron-human');
    expect(html).toContain('name="expr"');
    expect(html).toContain('value="0 */3 * * *"');
    expect(html).toContain('name="instruction"');
    expect(html).toContain('Check job boards');
    expect(html).toContain('name="chatId"');
    expect(html).toContain('value="4242"');
    expect(html).toContain('ui-badge-ok');
    expect(html).toContain('in 3h');
    expect(html).toContain('Every three hours, report to you.');
    expect(html).toMatch(/<button[^>]*data-automation-create[^>]*>Create job<\/button>/);
    expect(html).toContain('data-automation-discard');
    expect(html).toContain('Hunter');
    expect(html).toContain('claude-cli');
  });

  it('lists warnings, marks low confidence and escapes everything', () => {
    const html = previewCard({
      ...PROPOSAL,
      confidence: 'low',
      instruction: '<script>alert(1)</script>',
      warnings: ['No schedule found <x>', 'Second'],
      source: 'fallback',
      llm: null,
      operatorChatId: null,
    });
    expect(html).toContain('ui-badge-danger');
    expect(html).toContain('No schedule found &lt;x&gt;');
    expect(html).toContain('Second');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('built-in parser');
    expect(html).toContain('value=""'); // chat id input empty, must be filled
  });

  it('honours edits passed back in (cron field and its human text)', () => {
    const html = previewCard(PROPOSAL, { expr: '0 9 * * 1' });
    expect(html).toContain('value="0 9 * * 1"');
    expect(html).toContain(`Every Monday at 09:00 (${TZ})`);
  });
});

describe('labels', () => {
  it('targetLabel and describeSource', () => {
    expect(targetLabel(PROPOSAL)).toBe('You (operator · chat 4242)');
    expect(targetLabel({ ...PROPOSAL, operatorChatId: null })).toBe(
      'You (operator · no chat id configured)'
    );
    expect(targetLabel({ ...PROPOSAL, chatId: -100 })).toBe('Chat -100');
    expect(describeSource(PROPOSAL, AGENTS)).toBe(
      'Read by Hunter <b> (claude-cli · claude-opus-5)'
    );
    expect(describeSource({ ...PROPOSAL, source: 'fallback', llm: null }, AGENTS)).toBe(
      'Read by the built-in parser'
    );
    expect(CONFIDENCE_TONE).toEqual({ high: 'ok', medium: 'warn', low: 'danger' });
  });
});
