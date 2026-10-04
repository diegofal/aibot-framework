import { describe, expect, it } from 'bun:test';
import { resolveCuriosity } from '../../../src/bot/curiosity/config';
import {
  activeDirectives,
  addDirective,
  decayDirectives,
  renderDirectivesForPrompt,
  serveDirectives,
} from '../../../src/bot/curiosity/directives';
import { emptyNavigatorState } from '../../../src/bot/curiosity/store';

const T0 = '2026-10-01T00:00:00.000Z';
const cfg = resolveCuriosity(undefined, {
  directiveHalfLifeOutputs: 3,
  directiveHalfLifeDays: 7,
});

describe('addDirective', () => {
  it('adds an active directive', () => {
    const nav = addDirective(emptyNavigatorState(), {
      text: 'Research Jev use cases',
      source: 'message',
      receivedAt: T0,
    });
    expect(nav.directives).toHaveLength(1);
    expect(nav.directives[0]).toMatchObject({ status: 'active', servedOutputs: 0 });
    expect(nav.directives[0].id).toBeTruthy();
  });

  it('re-anchors instead of duplicating a repeated instruction', () => {
    let nav = addDirective(emptyNavigatorState(), {
      text: 'Research Jev use cases',
      source: 'message',
      receivedAt: T0,
    });
    nav = serveDirectives(nav, [nav.directives[0].id], T0);
    nav = addDirective(nav, {
      text: 'research jev use cases!',
      source: 'message',
      receivedAt: '2026-10-02T00:00:00.000Z',
    });
    expect(nav.directives).toHaveLength(1);
    expect(nav.directives[0].servedOutputs).toBe(0);
    expect(nav.directives[0].receivedAt).toBe('2026-10-02T00:00:00.000Z');
  });

  it('ignores blank text', () => {
    expect(
      addDirective(emptyNavigatorState(), { text: '  ', source: 'message', receivedAt: T0 })
        .directives
    ).toHaveLength(0);
  });

  it('caps the list, dropping the oldest served first', () => {
    let nav = emptyNavigatorState();
    for (let i = 0; i < 25; i++) {
      nav = addDirective(nav, {
        text: `distinct instruction ${i} about subject${i * 13}`,
        source: 'message',
        receivedAt: T0,
      });
    }
    expect(nav.directives.length).toBeLessThanOrEqual(20);
  });
});

describe('serve + decay', () => {
  it('counts outputs against named directives only', () => {
    let nav = addDirective(emptyNavigatorState(), { text: 'a', source: 'message', receivedAt: T0 });
    nav = addDirective(nav, { text: 'b different', source: 'ask_human', receivedAt: T0 });
    nav = serveDirectives(nav, [nav.directives[0].id, 'unknown'], T0);
    expect(nav.directives[0].servedOutputs).toBe(1);
    expect(nav.directives[1].servedOutputs).toBe(0);
  });

  it('marks a directive served after N outputs', () => {
    let nav = addDirective(emptyNavigatorState(), { text: 'a', source: 'message', receivedAt: T0 });
    const id = nav.directives[0].id;
    for (let i = 0; i < 3; i++) nav = serveDirectives(nav, [id], T0);
    nav = decayDirectives(nav, cfg, '2026-10-01T01:00:00.000Z');
    expect(nav.directives[0].status).toBe('served');
    expect(nav.directives[0].servedAt).toBe('2026-10-01T01:00:00.000Z');
    expect(activeDirectives(nav)).toHaveLength(0);
  });

  it('marks a directive served after the half-life in days', () => {
    let nav = addDirective(emptyNavigatorState(), { text: 'a', source: 'message', receivedAt: T0 });
    nav = decayDirectives(nav, cfg, '2026-10-05T00:00:00.000Z');
    expect(nav.directives[0].status).toBe('active');
    nav = decayDirectives(nav, cfg, '2026-10-09T00:00:00.000Z');
    expect(nav.directives[0].status).toBe('served');
  });
});

describe('renderDirectivesForPrompt', () => {
  it('returns empty string with no directives', () => {
    expect(renderDirectivesForPrompt(emptyNavigatorState())).toBe('');
  });

  it('separates steering directives from served context', () => {
    let nav = addDirective(emptyNavigatorState(), {
      text: 'Study retrieval',
      source: 'message',
      receivedAt: T0,
    });
    nav = addDirective(nav, { text: 'Old jev request', source: 'message', receivedAt: T0 });
    nav = {
      ...nav,
      directives: nav.directives.map((d) =>
        d.text.startsWith('Old') ? { ...d, status: 'served' as const, servedOutputs: 3 } : d
      ),
    };
    const text = renderDirectivesForPrompt(nav);
    expect(text).toContain('Steer by');
    expect(text).toContain('Study retrieval');
    expect(text).toContain('Already served');
    expect(text).toContain('Old jev request');
    expect(text.indexOf('Study retrieval')).toBeLessThan(text.indexOf('Old jev request'));
  });
});
