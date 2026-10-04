import { describe, expect, it } from 'bun:test';
import {
  activityCell,
  agentMenuItems,
  agentRow,
  agentsTable,
  karmaCell,
  loopButton,
  modelSelect,
  primaryAction,
} from '../../web/pages/agents-list-helpers.js';

const running = {
  id: 'b1',
  name: 'Bot One',
  enabled: true,
  running: true,
  skills: ['reflection', 'x'],
  model: 'llama3',
};
const stopped = { id: 'b2', name: 'Bot <Two>', enabled: true, running: false, skills: [] };
const disabled = { id: 'b3', name: 'Off', enabled: false, running: false, skills: [] };
const defaults = { model: 'qwen', availableModels: ['qwen', 'llama3', 'claude-cli'] };

describe('primaryAction', () => {
  it('offers Stop for a running agent', () => {
    expect(primaryAction(running)).toEqual({ action: 'stop', label: 'Stop', danger: true });
  });
  it('offers Start for an enabled, stopped agent', () => {
    expect(primaryAction(stopped)).toEqual({ action: 'start', label: 'Start', danger: false });
  });
  it('offers Enable & Start for a disabled agent', () => {
    expect(primaryAction(disabled)).toEqual({
      action: 'enable-start',
      label: 'Enable & Start',
      danger: false,
    });
  });
});

describe('agentMenuItems', () => {
  it('includes Run loop and Reflect only while running with the reflection skill', () => {
    const actions = agentMenuItems(running)
      .filter((i) => i?.action)
      .map((i) => i.action);
    expect(actions).toContain('run-loop');
    expect(actions).toContain('reflect');
    expect(actions).not.toContain('reset');
    expect(actions).toContain('delete');
  });
  it('includes Reset but not Run loop for a stopped agent', () => {
    const actions = agentMenuItems(stopped)
      .filter((i) => i?.action)
      .map((i) => i.action);
    expect(actions).toContain('reset');
    expect(actions).not.toContain('run-loop');
    expect(actions).not.toContain('reflect');
  });
  it('states the productions toggle in its label', () => {
    const on = agentMenuItems(running).find((i) => i?.action === 'toggle-productions');
    expect(on?.label).toBe('Turn productions off');
    const off = agentMenuItems({ ...running, productions: { enabled: false } }).find(
      (i) => i?.action === 'toggle-productions'
    );
    expect(off?.label).toBe('Turn productions on');
  });
  it('stamps every action item with the agent id', () => {
    for (const i of agentMenuItems(running)) if (i?.action) expect(i.id).toBe('b1');
  });
});

describe('cells', () => {
  it('activityCell summarises calls, tokens and fallbacks', () => {
    const html = activityCell({
      totalCalls: 399,
      successCount: 357,
      fallbackCount: 52,
      modelBreakdown: { a: { promptTokens: 9_000_000, completionTokens: 900_000 } },
    });
    expect(html).toContain('357');
    expect(html).toContain('399');
    expect(html).toContain('9.9M');
    expect(html).toContain('52 fallback');
  });
  it('activityCell handles missing stats', () => {
    expect(activityCell(undefined)).toContain('--');
    expect(activityCell({ totalCalls: 0, successCount: 0 })).not.toContain('fallback');
  });
  it('karmaCell shows the score with a trend arrow and links to the karma page', () => {
    const html = karmaCell({ current: 83, trend: 'falling' }, 'b1');
    expect(html).toContain('83');
    expect(html).toContain('href="#/insights/karma/b1"');
    expect(html).toContain('↓');
    expect(karmaCell(undefined, 'b1')).toContain('--');
  });
  it('loopButton cycles labels Auto / On / Off', () => {
    expect(loopButton(running)).toContain('Auto');
    expect(loopButton({ ...running, agentLoop: { enabled: true } })).toContain('>On<');
    expect(loopButton({ ...running, agentLoop: { enabled: false } })).toContain('>Off<');
    expect(loopButton({ ...running, agentLoop: { enabled: false } })).toContain('btn-danger');
  });
  it('modelSelect marks the effective model and maps claude-cli', () => {
    const html = modelSelect({ ...running, llmBackend: 'claude-cli' }, defaults);
    expect(html).toContain('value="claude-cli" selected');
    expect(html).toContain('Global (qwen)');
    expect(modelSelect(running, defaults)).toContain('value="llama3" selected');
  });
});

describe('agentRow / agentsTable', () => {
  it('renders a compact row with avatar, name, id, status and at most one visible action button', () => {
    const row = agentRow(running, { defaults, karma: { current: 100 }, executing: true });
    const html = row.cells.join('');
    expect(row.attrs['data-id']).toBe('b1');
    expect(html).toContain('ui-avatar');
    expect(html).toContain('href="#/agents/b1"');
    expect(html).toContain('Bot One');
    expect(html).toContain('badge-running');
    expect(html).toContain('processing-pulse');
    expect(html).toContain('data-action="stop"');
    expect(html).toContain('<details class="ui-menu">');
    // Only the primary button is outside the menu.
    const outsideMenu = html.split('<details')[0];
    expect((outsideMenu.match(/<button/g) ?? []).length).toBeLessThanOrEqual(2);
  });
  it('escapes agent names', () => {
    const html = agentRow(stopped, { defaults }).cells.join('');
    expect(html).not.toContain('<Two>');
    expect(html).toContain('&lt;Two&gt;');
  });
  it('agentsTable renders one row per agent with the bulk checkbox column', () => {
    const html = agentsTable([running, stopped], { defaults, karmaMap: {}, llmStatsMap: {} });
    expect(html).toContain('id="bulk-select-all"');
    expect((html.match(/class="bulk-select"/g) ?? []).length).toBe(2);
    expect(html).toContain('<tbody id="agents-tbody">');
    expect(html).toContain('table-scroll');
  });
  it('agentsTable renders an empty state without agents', () => {
    expect(agentsTable([], { defaults })).toContain('No agents yet');
  });
});
