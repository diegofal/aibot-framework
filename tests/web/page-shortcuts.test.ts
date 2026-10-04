// Pages register their own `?` help-sheet keys (registerPageShortcuts) instead
// of a static map in shortcuts-helpers.js keyed by route handler name.
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AGENT_EDIT_SHORTCUTS } from '../../web/pages/agent-form-helpers.js';
import { AGENT_HOME_SHORTCUTS } from '../../web/pages/agent-home-helpers.js';
import { AGENTS_SHORTCUTS } from '../../web/pages/agents-list-helpers.js';
import { SHORTCUTS as NEEDS_SHORTCUTS } from '../../web/pages/needs-you-helpers.js';
import { SETTINGS_SHORTCUTS } from '../../web/pages/settings-helpers.js';
import { DISPATCH_SHORTCUTS, WORK_SHORTCUTS } from '../../web/pages/work-helpers.js';
import * as shortcutsHelpers from '../../web/ui/shortcuts-helpers.js';

const keys = (list: string[][]) => list.map((r) => r[0]);

describe('page shortcut lists live with their pages', () => {
  it('carry the keys each page binds', () => {
    expect(keys(NEEDS_SHORTCUTS)).toContain('x');
    expect(keys(WORK_SHORTCUTS)).toContain('a');
    expect(keys(DISPATCH_SHORTCUTS)).toContain('+ / =');
    expect(keys(AGENT_HOME_SHORTCUTS)).toEqual(['r', 'e', 'c']);
    expect(keys(AGENT_EDIT_SHORTCUTS)).toContain('Ctrl/⌘ + S');
    expect(keys(SETTINGS_SHORTCUTS)).toContain('Ctrl/⌘ + S');
    expect(keys(AGENTS_SHORTCUTS)).toContain('Esc');
  });

  it('every row is [keys, description]', () => {
    for (const list of [
      NEEDS_SHORTCUTS,
      WORK_SHORTCUTS,
      DISPATCH_SHORTCUTS,
      AGENT_HOME_SHORTCUTS,
      AGENT_EDIT_SHORTCUTS,
      SETTINGS_SHORTCUTS,
      AGENTS_SHORTCUTS,
    ]) {
      for (const row of list) {
        expect(row).toHaveLength(2);
        expect(typeof row[0]).toBe('string');
        expect(typeof row[1]).toBe('string');
      }
    }
  });

  it('the static PAGE_SHORTCUTS map is gone', () => {
    expect('PAGE_SHORTCUTS' in shortcutsHelpers).toBe(false);
  });
});

describe('each page registers its list before its first await', () => {
  // Registering after an await could land after the user already navigated
  // away (the router clears registrations on leave), labelling the next page.
  const cases: Array<[string, string, string]> = [
    ['needs-you.js', 'renderNeedsYou', 'SHORTCUTS'],
    ['work.js', 'renderWork', 'WORK_SHORTCUTS'],
    ['dispatches.js', 'renderDispatches', 'DISPATCH_SHORTCUTS'],
    ['agent-home.js', 'renderAgentHome', 'AGENT_HOME_SHORTCUTS'],
    ['agents.js', 'renderAgentEdit', 'AGENT_EDIT_SHORTCUTS'],
    ['settings.js', 'renderSettings', 'SETTINGS_SHORTCUTS'],
    ['agents.js', 'renderAgents', 'AGENTS_SHORTCUTS'],
  ];
  for (const [file, fn, list] of cases) {
    it(`${fn} → registerPageShortcuts(${list})`, () => {
      const src = readFileSync(join(import.meta.dir, '../../web/pages', file), 'utf-8');
      const start = src.indexOf(`export async function ${fn}(`);
      expect(start).toBeGreaterThan(-1);
      const firstAwait = src.indexOf('await ', start);
      const head = src.slice(start, firstAwait === -1 ? undefined : firstAwait);
      expect(head).toContain(`registerPageShortcuts(${list})`);
    });
  }
});

describe('pageShortcutsFor', () => {
  it('is what the current page registered, or nothing', () => {
    const list = [['q', 'Quit']];
    expect(shortcutsHelpers.pageShortcutsFor(list)).toEqual(list);
    expect(shortcutsHelpers.pageShortcutsFor(null)).toEqual([]);
    expect(shortcutsHelpers.pageShortcutsFor([])).toEqual([]);
  });
});
