import { describe, expect, it } from 'bun:test';
import { lessonsCardHtml, lessonsUrl } from '../../web/pages/agent-home-helpers.js';

const NOW = 1_700_000_000_000;
const H = 3_600_000;

const lesson = (over: Record<string, unknown> = {}) => ({
  id: 'l-0000abcd',
  classKey: 'file_read:file-not-found',
  tool: 'file_read',
  errorClass: 'file-not-found',
  text: 'Use the full path.',
  textSource: 'model',
  evidence: [],
  source: 'own',
  status: 'active',
  createdAt: new Date(NOW - 3 * H).toISOString(),
  updatedAt: new Date(NOW - 3 * H).toISOString(),
  baseline: { failures: 4, calls: 10, rate: 0.4, sinceMs: 0, untilMs: 1 },
  why: { what: 'Lesson: Use the full path.' },
  ...over,
});

describe('lessonsUrl', () => {
  it('encodes the bot id', () => {
    expect(lessonsUrl('a b')).toBe('/api/agents/a%20b/lessons');
  });
});

describe('lessonsCardHtml', () => {
  it('empty and off: one dim line', () => {
    const html = lessonsCardHtml({ enabled: false, lessons: [] }, { nowMs: NOW });
    expect(html).toContain('Self-improvement is off for this agent');
    expect(html).toContain('text-dim');
    expect(html).not.toContain('No lessons yet');
  });

  it('empty and on: no lessons yet', () => {
    const html = lessonsCardHtml({ enabled: true, lessons: [] }, { nowMs: NOW });
    expect(html).toContain('No lessons yet');
    expect(html).not.toContain('is off');
  });

  it('a request error says so, escaped', () => {
    const html = lessonsCardHtml({ error: '<boom>' }, { nowMs: NOW });
    expect(html).toContain('Could not load the lessons');
    expect(html).toContain('&lt;boom&gt;');
  });

  it('one row per lesson: text, status, class, baseline only when not measured, the why fold', () => {
    const html = lessonsCardHtml(
      { enabled: true, botId: 'b1', lessons: [lesson()] },
      { nowMs: NOW }
    );
    expect(html).toContain('Use the full path.');
    expect(html).toContain('>active<');
    expect(html).toContain('file_read · file-not-found');
    expect(html).toContain('baseline 40%');
    expect(html).not.toContain('→ now');
    expect(html).toContain('3h ago');
    expect(html).toContain('<details class="why">');
  });

  it('measured: baseline → now; borrowed: its source; every status tag', () => {
    const html = lessonsCardHtml(
      {
        enabled: true,
        lessons: [
          lesson({
            status: 'proven',
            measure: { failures: 1, calls: 20, rate: 0.05, sinceMs: 1, untilMs: 2 },
          }),
          lesson({
            id: 'l-2',
            status: 'retired',
            source: 'borrowed',
            borrowedFrom: { botId: 'scout', lessonId: 'l-9' },
          }),
          lesson({ id: 'l-3', status: 'unproven' }),
        ],
      },
      { nowMs: NOW }
    );
    expect(html).toContain('baseline 40% → now 5%');
    expect(html).toContain('borrowed from scout');
    for (const s of ['proven', 'retired', 'unproven']) expect(html).toContain(`>${s}<`);
  });

  it('escapes every text it shows', () => {
    const html = lessonsCardHtml(
      {
        enabled: true,
        lessons: [
          lesson({
            text: '<img src=x>',
            tool: '<t>',
            errorClass: '<e>',
            source: 'borrowed',
            borrowedFrom: { botId: '<b>', lessonId: 'l' },
            why: undefined,
          }),
        ],
      },
      { nowMs: NOW }
    );
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<t>');
    expect(html).not.toContain('<e>');
    expect(html).not.toContain('<b>');
    expect(html).toContain('&lt;img src=x&gt;');
  });
});
