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

describe('chat messages are context, never instructions', () => {
  const chat = (nav: ReturnType<typeof emptyNavigatorState>, text: string, at = T0) =>
    addDirective(nav, { text, source: 'message', receivedAt: at, status: 'context' });

  it('stores a chat message as context, outside the active set', () => {
    const nav = chat(emptyNavigatorState(), 'no need to summarize unless I ask');
    expect(nav.directives[0]).toMatchObject({ status: 'context', source: 'message' });
    expect(activeDirectives(nav)).toHaveLength(0);
  });

  it('never decays or counts outputs against context', () => {
    let nav = chat(emptyNavigatorState(), 'can you check my calendar for today');
    const id = nav.directives[0].id;
    nav = serveDirectives(nav, [id], T0);
    nav = decayDirectives(nav, cfg, '2026-10-30T00:00:00.000Z');
    expect(nav.directives[0].status).toBe('context');
  });

  it('renders context in its own section, never under "Steer by"', () => {
    let nav = addDirective(emptyNavigatorState(), {
      text: 'Study retrieval economics',
      source: 'ask_human',
      receivedAt: T0,
    });
    nav = chat(nav, 'can you check my calendar for today');
    const text = renderDirectivesForPrompt(nav);
    const steer = text.indexOf('Steer by');
    const chatAt = text.indexOf('said in chat');
    expect(steer).toBeGreaterThan(-1);
    expect(chatAt).toBeGreaterThan(steer);
    expect(text.slice(steer, chatAt)).not.toContain('calendar');
    expect(text.slice(chatAt)).toContain('can you check my calendar for today');
    expect(text.slice(chatAt)).toContain('never reply');
  });

  it('renders only the five most recent chat messages', () => {
    let nav = emptyNavigatorState();
    for (let i = 0; i < 7; i++) nav = chat(nav, `chat line ${i} about topic${i * 17}`);
    const text = renderDirectivesForPrompt(nav);
    expect(text).not.toContain('chat line 0 ');
    expect(text).not.toContain('chat line 1 ');
    expect(text).toContain('chat line 6 ');
  });

  it('a chat message never re-anchors or demotes an active instruction', () => {
    let nav = addDirective(emptyNavigatorState(), {
      text: 'Research Jev use cases',
      source: 'ask_human',
      receivedAt: T0,
    });
    nav = chat(nav, 'research jev use cases!', '2026-10-02T00:00:00.000Z');
    const active = activeDirectives(nav);
    expect(active).toHaveLength(1);
    expect(active[0].receivedAt).toBe(T0);
    expect(nav.directives.filter((d) => d.status === 'context')).toHaveLength(1);
  });

  it('a repeated chat message refreshes its context entry', () => {
    let nav = chat(emptyNavigatorState(), 'what meetings do I have today');
    nav = chat(nav, 'what meetings do I have today?', '2026-10-02T00:00:00.000Z');
    expect(nav.directives).toHaveLength(1);
    expect(nav.directives[0]).toMatchObject({
      status: 'context',
      receivedAt: '2026-10-02T00:00:00.000Z',
    });
  });

  it('shows a re-said chat line among the latest, whatever its position', () => {
    let nav = emptyNavigatorState();
    nav = chat(nav, 'the very first thing I said in chat', '2026-10-01T00:00:00.000Z');
    for (let i = 0; i < 6; i++)
      nav = chat(nav, `chat line ${i} about topic${i * 17}`, `2026-10-0${i + 2}T00:00:00.000Z`);
    nav = chat(nav, 'the very first thing I said in chat!', '2026-10-20T00:00:00.000Z');
    expect(renderDirectivesForPrompt(nav)).toContain('the very first thing I said in chat!');
  });

  it('evicts chat context before served instructions', () => {
    let nav = addDirective(emptyNavigatorState(), {
      text: 'A past instruction',
      source: 'ask_human',
      receivedAt: T0,
    });
    nav = { ...nav, directives: nav.directives.map((d) => ({ ...d, status: 'served' as const })) };
    for (let i = 0; i < 25; i++) nav = chat(nav, `chat line ${i} about topic${i * 17}`);
    expect(nav.directives.some((d) => d.text === 'A past instruction')).toBe(true);
  });

  it('evicts context before active instructions when over the cap', () => {
    let nav = addDirective(emptyNavigatorState(), {
      text: 'The one real instruction',
      source: 'ask_human',
      receivedAt: T0,
    });
    for (let i = 0; i < 25; i++) nav = chat(nav, `chat line ${i} about topic${i * 17}`);
    expect(nav.directives.length).toBeLessThanOrEqual(20);
    expect(activeDirectives(nav).map((d) => d.text)).toEqual(['The one real instruction']);
  });
});
