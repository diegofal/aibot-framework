import { describe, expect, it } from 'bun:test';
import {
  POSTURE_TONE,
  applyPresence,
  formatNext,
  isPresenceEvent,
  postureTone,
  presenceHeader,
  presenceMeta,
  traitChangesList,
  traitsBody,
} from '../../web/pages/agent-home-helpers.js';

const NOW = 1_700_000_000_000;
const M = 60_000;

describe('postureTone', () => {
  it('maps every posture and falls back to muted', () => {
    for (const [p, t] of Object.entries(POSTURE_TONE)) expect(postureTone(p)).toBe(t);
    expect(postureTone('weird')).toBe('muted');
    expect(postureTone(undefined)).toBe('muted');
  });
});

describe('formatNext', () => {
  it('handles null, past, minutes, hours, days and ISO strings', () => {
    expect(formatNext(null, NOW)).toBe('');
    expect(formatNext(NOW - M, NOW)).toBe('next run now');
    expect(formatNext(NOW + 7 * M, NOW)).toBe('next run in 7m');
    expect(formatNext(NOW + 5 * 60 * M, NOW)).toBe('next run in 5h');
    expect(formatNext(NOW + 3 * 24 * 60 * M, NOW)).toBe('next run in 3d');
    expect(formatNext(new Date(NOW + 7 * M).toISOString(), NOW)).toBe('next run in 7m');
    expect(formatNext('garbage', NOW)).toBe('');
  });
});

describe('presenceMeta', () => {
  it('joins backend, channel and next run', () => {
    const s = presenceMeta(
      { backend: 'ollama', model: 'qwen', channel: { kind: 'telegram', state: 'ok' } },
      { nextRunAt: NOW + 10 * M },
      NOW
    );
    expect(s).toBe('ollama · qwen · telegram ok · next run in 10m');
  });
  it('says cycle running instead of the next run while executing', () => {
    expect(presenceMeta({}, { isExecuting: true, nextRunAt: NOW + M }, NOW)).toBe('cycle running');
    expect(presenceMeta({}, {}, NOW)).toBe('');
  });
});

describe('presenceHeader', () => {
  const home = {
    identity: { id: 'b<1>', name: 'Job <Seeker>', running: true, backend: 'ollama' },
    presence: {
      posture: 'active',
      nowLine: "I'm between <cycles>",
      tone: 'ok',
      nextRunAt: NOW + M,
    },
  };
  it('escapes identity and now line and carries the tone', () => {
    const html = presenceHeader(home, { nowMs: NOW, actions: '<button>Go</button>' });
    expect(html).toContain('data-bot-id="b&lt;1&gt;"');
    expect(html).toContain('presence-name">Job &lt;Seeker&gt;<');
    expect(html).toContain('id="presence-now">I&#39;m between &lt;cycles&gt;<');
    expect(html).toContain('presence-now presence-now-ok');
    expect(html).toContain('ui-avatar-dot ui-avatar-dot-ok');
    expect(html).toContain('ui-badge ui-badge-ok">');
    expect(html).toContain('<button>Go</button>');
    expect(html).not.toContain('>stopped<');
  });
  it('marks a stopped agent and survives an empty payload', () => {
    const html = presenceHeader(
      { identity: { id: 'x', running: false }, presence: {} },
      { nowMs: NOW }
    );
    expect(html).toContain('>stopped<');
    expect(html).toContain('ui-badge-muted');
    expect(presenceHeader(undefined)).toContain('presence-header');
  });
  it('uses the uploaded face through avatarSrc and offers face / voice controls on request', () => {
    const faced = {
      identity: { id: 'b1', name: 'Bot', running: true, avatarUrl: '/api/agents/b1/avatar?v=1' },
      presence: { posture: 'active', nowLine: 'hi', tone: 'ok' },
    };
    const plain = presenceHeader(faced, { nowMs: NOW });
    expect(plain).toContain('<img src="/api/agents/b1/avatar?v=1"');
    expect(plain).not.toContain('id="face-input"');
    expect(plain).not.toContain('id="presence-speak"');

    const full = presenceHeader(faced, {
      nowMs: NOW,
      avatarSrc: (u) => `${u}&token=T`,
      face: true,
      voice: true,
    });
    expect(full).toContain('<img src="/api/agents/b1/avatar?v=1&amp;token=T"');
    expect(full).toContain('id="face-input"');
    expect(full).toContain('id="face-remove"');
    expect(full).toContain('id="presence-speak"');
    expect(full).toContain('id="presence-now"');

    const seed = presenceHeader(home, { nowMs: NOW, face: true, avatarSrc: () => 'never' });
    expect(seed).toContain('<svg');
    expect(seed).not.toContain('never');
    expect(seed).not.toContain('id="face-remove"');
  });
});

describe('isPresenceEvent', () => {
  it('accepts agent, tool and llm:start events for the bot only', () => {
    expect(isPresenceEvent({ type: 'agent:phase', botId: 'b1' }, 'b1')).toBe(true);
    expect(isPresenceEvent({ type: 'tool:start', botId: 'b1' }, 'b1')).toBe(true);
    expect(isPresenceEvent({ type: 'llm:start', botId: 'b1' }, 'b1')).toBe(true);
    expect(isPresenceEvent({ type: 'llm:end', botId: 'b1' }, 'b1')).toBe(false);
    expect(isPresenceEvent({ type: 'agent:phase', botId: 'b2' }, 'b1')).toBe(false);
    expect(isPresenceEvent(null, 'b1')).toBe(false);
  });
});

describe('posture Why (Why row 8)', () => {
  const postureWhy = { what: 'Posture: standby', by: 'system', rule: '5 idle cycles in a row.' };
  it('the header renders the posture fold next to the now line', () => {
    const html = presenceHeader(
      { identity: { id: 'b1' }, presence: { posture: 'standby', nowLine: 'x', postureWhy } },
      { nowMs: NOW }
    );
    expect(html).toContain('id="presence-why"');
    expect(html).toContain('<details class="why">');
    expect(html).toContain('5 idle cycles in a row.');
    expect(presenceHeader({ identity: {}, presence: {} })).not.toContain('<details');
  });
  it('applyPresence refreshes the fold and keeps it open', () => {
    let fold = { open: true };
    let html = '';
    const why = {
      get innerHTML() {
        return html;
      },
      set innerHTML(v: string) {
        html = v;
        fold = { open: false };
      },
      querySelector: (sel: string) => (sel === 'details' ? fold : null),
    };
    const root = { querySelector: (sel: string) => (sel === '#presence-why' ? why : null) };
    applyPresence(root, { posture: 'standby', postureWhy }, {}, NOW);
    expect(html).toContain('5 idle cycles in a row.');
    expect(fold.open).toBe(true);
  });
});

describe('applyPresence', () => {
  it('is a no-op without a DOM root', () => {
    expect(applyPresence(null, { posture: 'active' })).toBe(false);
    expect(applyPresence({}, { posture: 'active' })).toBe(false);
  });
  it('updates the now line, badge, dot and meta through a minimal element stub', () => {
    const nodes: Record<string, { textContent: string; className: string; innerHTML: string }> = {
      '#presence-now': { textContent: '', className: '', innerHTML: '' },
      '#presence-badge': { textContent: '', className: '', innerHTML: '' },
      '.ui-avatar-dot': { textContent: '', className: '', innerHTML: '' },
      '#presence-meta': { textContent: '', className: '', innerHTML: '' },
    };
    const root = { querySelector: (sel: string) => nodes[sel] ?? null };
    const ok = applyPresence(
      root,
      { posture: 'blocked', nowLine: "I'm blocked: quota.", tone: 'danger', nextRunAt: NOW + M },
      { backend: 'claude-cli' },
      NOW
    );
    expect(ok).toBe(true);
    expect(nodes['#presence-now'].textContent).toBe("I'm blocked: quota.");
    expect(nodes['#presence-now'].className).toBe('presence-now presence-now-danger');
    expect(nodes['#presence-badge'].innerHTML).toContain('ui-badge-danger');
    expect(nodes['.ui-avatar-dot'].className).toBe('ui-avatar-dot ui-avatar-dot-danger');
    expect(nodes['#presence-meta'].textContent).toBe('claude-cli · next run in 1m');
  });
});

describe('traits history (Why row 13)', () => {
  const change = {
    ts: new Date(NOW - 2 * 60 * M).toISOString(),
    source: 'strategist',
    cycleId: 'c-1',
    changes: [{ trait: 'caution', from: 0.5, to: 0.53, requested: 0.03 }],
    rejected: [],
    reasons: { caution: 'Repeated <errors>.' },
    derived: false,
    why: {
      what: 'Trait adjusted: caution +0.03',
      by: 'strategist',
      reason: { text: 'Repeated <errors>.', source: 'Strategist' },
      cycle: { id: 'c-1', botId: 'b1' },
    },
  };

  it('lists each change with who, when and its Why fold', () => {
    const html = traitChangesList([change], { nowMs: NOW, botId: 'b1' });
    expect(html).toContain('Trait adjusted: caution +0.03');
    expect(html).toContain('strategist');
    expect(html).toContain('2h ago');
    expect(html).toContain('<details class="why">');
    expect(html).toContain('Repeated &lt;errors&gt;.');
    expect(html).toContain('data-open-cycle="c-1"');
  });

  it('is empty without changes; the traits card includes it under the radar', () => {
    expect(traitChangesList([], { nowMs: NOW })).toBe('');
    expect(traitChangesList(undefined, { nowMs: NOW })).toBe('');
    const traits = { current: { a: 0.5, b: 0.5, c: 0.5 }, adjustments: 2, drift: null };
    const html = traitsBody(traits, [change], { nowMs: NOW, botId: 'b1' });
    expect(html).toContain('home-traits-radar');
    expect(html).toContain('Recent changes');
    expect(html).toContain('<details class="why">');
    expect(traitsBody(traits)).not.toContain('Recent changes');
  });
});

describe('isPresenceEvent — workers', () => {
  it('accepts worker:* and task:changed of the bot', () => {
    expect(isPresenceEvent({ type: 'worker:step', botId: 'b1' }, 'b1')).toBe(true);
    expect(isPresenceEvent({ type: 'task:changed', botId: 'b1' }, 'b1')).toBe(true);
    expect(isPresenceEvent({ type: 'worker:step', botId: 'b2' }, 'b1')).toBe(false);
  });
});
