import { describe, expect, it } from 'bun:test';
import {
  BADGE_TONES,
  avatar,
  avatarHue,
  badge,
  card,
  cx,
  deltaLabel,
  emptyState,
  esc,
  hashSeed,
  initials,
  kpi,
  openSheet,
  radar,
  radarPoints,
  sheetMarkup,
  showToast,
  skeleton,
  sparkline,
  sparklinePath,
  tabs,
  toastMarkup,
  toneFor,
} from '../../web/ui/index.js';

describe('esc / cx', () => {
  it('escapes the five HTML-significant characters', () => {
    expect(esc(`<a href="x" title='y'>&</a>`)).toBe(
      '&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;'
    );
  });
  it('renders nullish as empty and numbers as text', () => {
    expect(esc(null)).toBe('');
    expect(esc(undefined)).toBe('');
    expect(esc(42)).toBe('42');
  });
  it('joins class names and drops empties', () => {
    expect(cx('a', '', null, undefined, 'b')).toBe('a b');
  });
});

describe('badge', () => {
  it('renders text with the tone class', () => {
    expect(badge('Running', 'ok')).toBe('<span class="ui-badge ui-badge-ok">Running</span>');
  });
  it('falls back to muted for an unknown tone', () => {
    expect(badge('x', 'purple')).toContain('ui-badge-muted');
  });
  it('escapes user text and adds a dot on request', () => {
    const html = badge('<b>', 'danger', { dot: true, title: 'a"b' });
    expect(html).toContain('&lt;b&gt;');
    expect(html).toContain('<span class="ui-badge-dot"></span>');
    expect(html).toContain('title="a&quot;b"');
  });
  it('exposes the tone list', () => {
    expect(BADGE_TONES).toEqual(['ok', 'warn', 'danger', 'info', 'muted', 'accent']);
  });
  it('maps status words to tones', () => {
    expect(toneFor('running')).toBe('ok');
    expect(toneFor('PENDING')).toBe('warn');
    expect(toneFor('blocked')).toBe('danger');
    expect(toneFor('working')).toBe('info');
    expect(toneFor('mcp')).toBe('accent');
    expect(toneFor('whatever')).toBe('muted');
    expect(toneFor(undefined)).toBe('muted');
  });
});

describe('card', () => {
  it('renders a body only when nothing else is given', () => {
    expect(card({ body: '<p>hi</p>' })).toBe(
      '<section class="ui-card"><div class="ui-card-body"><p>hi</p></div></section>'
    );
  });
  it('escapes title and subtitle but trusts body, actions and footer', () => {
    const html = card({
      title: '<t>',
      subtitle: '<s>',
      body: '<b>body</b>',
      actions: '<button>go</button>',
      footer: '<i>f</i>',
    });
    expect(html).toContain('<div class="ui-card-title">&lt;t&gt;</div>');
    expect(html).toContain('<div class="ui-card-subtitle">&lt;s&gt;</div>');
    expect(html).toContain('<b>body</b>');
    expect(html).toContain('<div class="ui-card-actions"><button>go</button></div>');
    expect(html).toContain('<div class="ui-card-foot"><i>f</i></div>');
  });
  it('adds tone, flush and id attributes', () => {
    const html = card({ tone: 'warn', padded: false, id: 'x"y', class: 'extra' });
    expect(html).toContain('class="ui-card ui-card-warn ui-card-flush extra"');
    expect(html).toContain('id="x&quot;y"');
  });
});

describe('emptyState', () => {
  it('has sensible defaults', () => {
    const html = emptyState();
    expect(html).toContain('ui-empty-title">Nothing here yet<');
    expect(html).not.toContain('ui-empty-hint');
    expect(html).not.toContain('ui-empty-action');
  });
  it('escapes text and trusts the action', () => {
    const html = emptyState({ icon: '<', title: '<t>', hint: '<h>', action: '<button>a</button>' });
    expect(html).toContain('ui-empty-icon" aria-hidden="true">&lt;<');
    expect(html).toContain('&lt;t&gt;');
    expect(html).toContain('&lt;h&gt;');
    expect(html).toContain('<button>a</button>');
  });
});

describe('skeleton', () => {
  it('renders the requested number of lines with stable widths', () => {
    const html = skeleton({ lines: 3 });
    expect(html.match(/ui-skeleton-line/g)).toHaveLength(3);
    expect(html).toBe(skeleton({ lines: 3 }));
  });
  it('renders zero lines and a block variant', () => {
    expect(skeleton({ lines: 0 })).not.toContain('ui-skeleton-line');
    const block = skeleton({ block: true, height: 120 });
    expect(block).toContain('ui-skeleton-block');
    expect(block).toContain('style="height:120px"');
  });
});

describe('kpi', () => {
  it('formats deltas with sign and tone', () => {
    expect(deltaLabel(3)).toEqual({ text: '+3', tone: 'ok' });
    expect(deltaLabel(-1.25)).toEqual({ text: '−1.3', tone: 'danger' });
  });
  it('yields no delta for zero, null or NaN', () => {
    expect(deltaLabel(0)).toBeNull();
    expect(deltaLabel(null)).toBeNull();
    expect(deltaLabel('abc')).toBeNull();
  });
  it('renders label, value, delta chip and hint', () => {
    const html = kpi({ label: 'Karma', value: 72, delta: 4, tone: 'ok', hint: '30d' });
    expect(html).toContain('ui-kpi ui-kpi-ok');
    expect(html).toContain('ui-kpi-label">Karma<');
    expect(html).toContain('ui-kpi-value">72<');
    expect(html).toContain('ui-kpi-delta ui-kpi-delta-ok">+4<');
    expect(html).toContain('ui-kpi-hint">30d<');
  });
  it('shows a dash for a missing value', () => {
    expect(kpi({ label: 'x' })).toContain('ui-kpi-value">--<');
  });
});

describe('tabs', () => {
  it('renders nothing for an empty list', () => {
    expect(tabs([], 'a')).toBe('');
    expect(tabs(undefined, 'a')).toBe('');
  });
  it('marks the active tab and renders links or buttons', () => {
    const html = tabs(
      [
        { id: 'a', label: 'A', href: '#/a' },
        { id: 'b', label: 'B', badge: 3 },
        { id: 'c', label: 'C', badge: 0 },
      ],
      'b'
    );
    expect(html).toContain('<a class="ui-tab" href="#/a">A</a>');
    expect(html).toContain(
      '<button type="button" class="ui-tab active" data-tab="b" aria-current="page">B<span class="ui-tab-badge">3</span></button>'
    );
    expect(html).toContain('data-tab="c">C</button>');
  });
});

describe('avatar', () => {
  it('hashes deterministically and maps to a hue in range', () => {
    expect(hashSeed('job-seeker')).toBe(hashSeed('job-seeker'));
    expect(hashSeed('a')).not.toBe(hashSeed('b'));
    for (const seed of ['', 'x', 'cryptik', 'default']) {
      const h = avatarHue(seed);
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThan(360);
    }
  });
  it('derives initials from one or more words', () => {
    expect(initials('job seeker')).toBe('JS');
    expect(initials('job-seeker')).toBe('JS');
    expect(initials('cryptik')).toBe('CR');
    expect(initials('')).toBe('?');
    expect(initials(undefined)).toBe('?');
  });
  it('renders an svg disc with initials by default', () => {
    const html = avatar({ name: 'Job Seeker', size: 48, status: 'ok' });
    expect(html).toContain('<svg');
    expect(html).toContain('>JS</text>');
    expect(html).toContain('style="width:48px;height:48px"');
    expect(html).toContain('ui-avatar-dot ui-avatar-dot-ok');
    expect(html).toBe(avatar({ name: 'Job Seeker', size: 48, status: 'ok' }));
  });
  it('renders an image when src is given and escapes it', () => {
    const html = avatar({ name: 'x', src: '/a.png?x="1"' });
    expect(html).toContain('<img src="/a.png?x=&quot;1&quot;" alt="x">');
    expect(html).not.toContain('<svg');
  });
});

describe('sparkline', () => {
  it('returns no path for empty or non-numeric input', () => {
    expect(sparklinePath([])).toBe('');
    expect(sparklinePath(['a', null])).toBe('');
    expect(sparklinePath(undefined)).toBe('');
  });
  it('draws a flat full-width line for a single value', () => {
    expect(sparklinePath([5], 100, 20)).toBe('0,10 100,10');
  });
  it('scales min to the bottom and max to the top with a 1px inset', () => {
    expect(sparklinePath([0, 10], 100, 20)).toBe('0,19 100,1');
    expect(sparklinePath([0, 5, 10], 100, 20)).toBe('0,19 50,10 100,1');
  });
  it('renders an empty placeholder svg and a filled one', () => {
    expect(sparkline([])).toContain('ui-sparkline-empty');
    const html = sparkline([1, 2, 3], { width: 60, height: 20, tone: 'ok' });
    expect(html).toContain('ui-sparkline ui-sparkline-ok');
    expect(html).toContain('<polygon class="ui-sparkline-area"');
    expect(html).toContain('<polyline class="ui-sparkline-line"');
    expect(sparkline([1, 2], { fill: false })).not.toContain('ui-sparkline-area');
  });
});

describe('radar', () => {
  it('needs at least three axes', () => {
    expect(radarPoints([{ value: 1 }, { value: 1 }])).toEqual([]);
    expect(radar([{ label: 'a', value: 1 }])).toContain('ui-radar-empty');
  });
  it('points the first axis straight up and clamps values', () => {
    const pts = radarPoints(
      [
        { label: 'a', value: 1 },
        { label: 'b', value: 2 },
        { label: 'c', value: -1 },
      ],
      100
    );
    expect(pts[0]).toEqual([50, 12]);
    expect(pts[1][0]).toBeGreaterThan(50);
    expect(pts[2]).toEqual([50, 50]);
  });
  it('renders rings, spokes, shape and escaped labels', () => {
    const html = radar(
      [
        { label: '<a>', value: 0.5 },
        { label: 'b', value: 0.5 },
        { label: 'c', value: 0.5 },
      ],
      { size: 100 }
    );
    expect(html.match(/ui-radar-ring/g)).toHaveLength(4);
    expect(html.match(/ui-radar-spoke/g)).toHaveLength(3);
    expect(html).toContain('<polygon class="ui-radar-shape"');
    expect(html).toContain('&lt;a&gt;');
  });
});

describe('toast / sheet', () => {
  it('renders toast markup with tone fallback and escaping', () => {
    expect(toastMarkup('<x>', 'ok')).toBe(
      '<div class="ui-toast ui-toast-ok" role="status">&lt;x&gt;</div>'
    );
    expect(toastMarkup('x', 'nope')).toContain('ui-toast-muted');
  });
  it('renders sheet markup with optional footer and wide variant', () => {
    const html = sheetMarkup({
      title: '<t>',
      body: '<p>b</p>',
      footer: '<button>ok</button>',
      wide: true,
    });
    expect(html).toContain('aria-label="&lt;t&gt;"');
    expect(html).toContain('ui-sheet ui-sheet-wide');
    expect(html).toContain('<p>b</p>');
    expect(html).toContain('<footer class="ui-sheet-foot"><button>ok</button></footer>');
    expect(sheetMarkup({ title: 't' })).not.toContain('ui-sheet-foot');
  });
  it('DOM helpers are no-ops without a document', () => {
    expect(showToast('x')).toBeNull();
    expect(openSheet({ title: 'x' })).toBeNull();
  });
});
