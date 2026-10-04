import { describe, expect, it } from 'bun:test';
import {
  KIND_LABEL,
  SHORTCUTS,
  actionByHotkey,
  buildRequest,
  chipBar,
  detailPanel,
  initialState,
  listBody,
  listRow,
  moveSelection,
  queueSummary,
  reduceKey,
  removeItem,
  selectedItem,
  shortcutsHelp,
} from '../../web/pages/needs-you-helpers.js';

const NOW = Date.UTC(2026, 8, 14, 12, 0, 0);
const H = 3_600_000;
const iso = (ms: number) => new Date(ms).toISOString();

const answer = {
  id: 'answer',
  label: 'Answer',
  method: 'POST',
  path: '/api/conversations/b1/c1/messages',
  input: { field: 'message', required: true, placeholder: 'Your answer…' },
  tone: 'ok',
  hotkey: 'a',
};
const dismiss = {
  id: 'dismiss',
  label: 'Dismiss',
  method: 'DELETE',
  path: '/api/ask-human/q1',
  tone: 'muted',
  hotkey: 'd',
};
const approve = {
  id: 'approve',
  label: 'Approve',
  method: 'POST',
  path: '/api/productions/b1/f1/evaluate',
  body: { status: 'approved' },
  input: { field: 'feedback', required: false, placeholder: 'Feedback (optional)…' },
  tone: 'ok',
  hotkey: 'a',
};
const reject = {
  ...approve,
  id: 'reject',
  label: 'Reject',
  body: { status: 'rejected' },
  tone: 'danger',
  hotkey: 'd',
};

const askItem = {
  id: 'ask:c1',
  kind: 'ask',
  botId: 'b1',
  botName: 'Bot <One>',
  title: 'Ship <it>?',
  body: 'Should I ship the <digest> today?',
  options: ['Ship', 'Wait <a bit>'],
  createdAt: iso(NOW - 2 * H),
  urgency: 'normal',
  actions: [answer, dismiss],
  href: '#/needs/inbox/b1/c1',
  meta: { live: true, files: ['digest.md'] },
};
const prodItem = {
  id: 'production:b1:f1',
  kind: 'production',
  botId: 'b1',
  botName: 'Bot One',
  title: 'notes/a.md',
  body: 'Wrote a.md\n\nnotes/a.md · 120 bytes',
  options: null,
  createdAt: iso(NOW - 5 * H),
  urgency: 'low',
  actions: [approve, reject],
  href: '#/work/productions/b1?path=notes%2Fa.md',
  meta: { path: 'notes/a.md' },
};
const permItem = {
  id: 'permission:p1',
  kind: 'permission',
  botId: 'b2',
  botName: 'Bot Two',
  title: 'file_write → /tmp/x',
  body: 'Write x',
  options: null,
  createdAt: iso(NOW - H),
  urgency: 'high',
  actions: [
    {
      ...approve,
      path: '/api/ask-permission/p1/approve',
      body: undefined,
      input: { field: 'note', required: false, placeholder: 'Optional note…' },
    },
    {
      ...reject,
      id: 'deny',
      label: 'Deny',
      path: '/api/ask-permission/p1/deny',
      body: undefined,
      input: { field: 'note', required: false, placeholder: 'Optional note…' },
    },
  ],
  href: '#/needs/permissions',
  meta: {},
};
const items = [permItem, askItem, prodItem];

describe('state: initialState / moveSelection / removeItem', () => {
  it('selects the first item by default and keeps a previous selection when it survives', () => {
    expect(initialState(items).selectedId).toBe('permission:p1');
    expect(initialState(items, 'ask:c1').selectedId).toBe('ask:c1');
    expect(initialState(items, 'gone').selectedId).toBe('permission:p1');
    expect(initialState([]).selectedId).toBeNull();
    expect(selectedItem(initialState(items, 'ask:c1'))?.id).toBe('ask:c1');
  });

  it('moves and clamps the selection, resetting the chip focus', () => {
    let s = { ...initialState(items), chipIndex: 1 };
    s = moveSelection(s, 1);
    expect(s.selectedId).toBe('ask:c1');
    expect(s.chipIndex).toBe(-1);
    s = moveSelection(s, 1);
    s = moveSelection(s, 1);
    expect(s.selectedId).toBe('production:b1:f1');
    s = moveSelection(s, -5);
    expect(s.selectedId).toBe('permission:p1');
    expect(moveSelection(initialState([]), 1).selectedId).toBeNull();
  });

  it('removeItem moves the selection to the next item, then the previous, then null', () => {
    let s = initialState(items, 'ask:c1');
    s = removeItem(s, 'ask:c1');
    expect(s.items.map((i: { id: string }) => i.id)).toEqual(['permission:p1', 'production:b1:f1']);
    expect(s.selectedId).toBe('production:b1:f1');
    s = removeItem(s, 'production:b1:f1');
    expect(s.selectedId).toBe('permission:p1');
    s = removeItem(s, 'permission:p1');
    expect(s.selectedId).toBeNull();
    expect(s.items).toEqual([]);
    // Removing an unselected item keeps the selection.
    const t = removeItem(initialState(items, 'ask:c1'), 'permission:p1');
    expect(t.selectedId).toBe('ask:c1');
    expect(removeItem(t, 'nope')).toEqual(t);
  });
});

describe('reduceKey', () => {
  const base = initialState(items, 'ask:c1');

  it('j/k and arrows move; unknown keys are no-ops', () => {
    expect(reduceKey(base, 'j').state.selectedId).toBe('production:b1:f1');
    expect(reduceKey(base, 'ArrowDown').state.selectedId).toBe('production:b1:f1');
    expect(reduceKey(base, 'k').state.selectedId).toBe('permission:p1');
    expect(reduceKey(base, 'ArrowUp').state.selectedId).toBe('permission:p1');
    const r = reduceKey(base, 'z');
    expect(r.effect).toEqual({ type: 'none' });
    expect(r.state).toBe(base);
  });

  it('a submits the reply box text, the focused chip, or asks for focus when the reply is required', () => {
    const empty = reduceKey(base, 'a', { replyText: '' });
    expect(empty.effect).toEqual({ type: 'focusReply' });

    const typed = reduceKey(base, 'a', { replyText: '  Yes, ship it  ' });
    expect(typed.effect).toEqual({ type: 'act', action: answer, text: 'Yes, ship it' });

    const chip = reduceKey({ ...base, chipIndex: 1 }, 'a', { replyText: '' });
    expect(chip.effect).toEqual({ type: 'act', action: answer, text: 'Wait <a bit>' });
    // The chip wins over a half-typed reply: it is the thing the user focused last.
    const both = reduceKey({ ...base, chipIndex: 0 }, 'a', { replyText: 'draft' });
    expect(both.effect).toEqual({ type: 'act', action: answer, text: 'Ship' });
  });

  it('a and d fire optional-input actions without text', () => {
    const s = initialState(items, 'production:b1:f1');
    expect(reduceKey(s, 'a').effect).toEqual({ type: 'act', action: approve, text: '' });
    expect(reduceKey(s, 'd', { replyText: 'meh' }).effect).toEqual({
      type: 'act',
      action: reject,
      text: 'meh',
    });
    expect(reduceKey(base, 'd').effect).toEqual({ type: 'act', action: dismiss, text: '' });
  });

  it('r focuses the reply box only when the item takes input; o and Enter open pages; ? toggles help', () => {
    expect(reduceKey(base, 'r').effect).toEqual({ type: 'focusReply' });
    expect(reduceKey(base, 'o').effect).toEqual({ type: 'open', href: '#/agents/b1' });
    expect(reduceKey(base, 'Enter').effect).toEqual({ type: 'open', href: '#/needs/inbox/b1/c1' });
    const help = reduceKey(base, '?');
    expect(help.state.help).toBe(true);
    expect(help.effect).toEqual({ type: 'help' });
    expect(reduceKey(help.state, '?').state.help).toBe(false);
    const noInput = { ...base, items: [{ ...askItem, actions: [dismiss] }] };
    expect(reduceKey(noInput, 'r').effect).toEqual({ type: 'none' });
  });

  it('digits focus quick-reply chips (toggle) and Escape clears them', () => {
    const one = reduceKey(base, '1');
    expect(one.state.chipIndex).toBe(0);
    expect(reduceKey(one.state, '1').state.chipIndex).toBe(-1);
    expect(reduceKey(base, '2').state.chipIndex).toBe(1);
    expect(reduceKey(base, '3').state.chipIndex).toBe(-1);
    expect(reduceKey(one.state, 'Escape').state.chipIndex).toBe(-1);
    // No chips on a production: digits do nothing.
    expect(reduceKey(initialState(items, 'production:b1:f1'), '1').effect).toEqual({
      type: 'none',
    });
  });

  it('inside the reply box only Escape and modified Enter are handled', () => {
    expect(reduceKey(base, 'a', { inInput: true, replyText: 'a' }).effect).toEqual({
      type: 'none',
    });
    expect(reduceKey(base, 'j', { inInput: true }).state).toBe(base);
    expect(reduceKey(base, 'Escape', { inInput: true }).effect).toEqual({ type: 'blurReply' });
    expect(reduceKey(base, 'Enter', { inInput: true, replyText: 'ok' }).effect).toEqual({
      type: 'none',
    });
    expect(reduceKey(base, 'Enter', { inInput: true, mod: true, replyText: 'ok' }).effect).toEqual({
      type: 'act',
      action: answer,
      text: 'ok',
    });
    expect(reduceKey(base, 'Enter', { inInput: true, mod: true, replyText: '' }).effect).toEqual({
      type: 'none',
    });
  });

  it('with nothing selected every key is a no-op except help', () => {
    const s = initialState([]);
    expect(reduceKey(s, 'a').effect).toEqual({ type: 'none' });
    expect(reduceKey(s, 'j').effect).toEqual({ type: 'none' });
    expect(reduceKey(s, '?').effect).toEqual({ type: 'help' });
  });
});

describe('actionByHotkey / buildRequest', () => {
  it('finds actions by hotkey', () => {
    expect(actionByHotkey(askItem, 'a')).toBe(answer);
    expect(actionByHotkey(askItem, 'd')).toBe(dismiss);
    expect(actionByHotkey(askItem, 'x')).toBeNull();
    expect(actionByHotkey(null, 'a')).toBeNull();
  });

  it('merges the text into the input field and refuses a missing required reply', () => {
    expect(buildRequest(answer, ' hi ')).toEqual({
      path: answer.path,
      method: 'POST',
      body: { message: 'hi' },
    });
    expect(buildRequest(answer, '')).toEqual({ error: 'A reply is required' });
    expect(buildRequest(approve, '')).toEqual({
      path: approve.path,
      method: 'POST',
      body: { status: 'approved' },
    });
    expect(buildRequest(approve, 'nice')).toEqual({
      path: approve.path,
      method: 'POST',
      body: { status: 'approved', feedback: 'nice' },
    });
    expect(buildRequest(dismiss, 'ignored')).toEqual({ path: dismiss.path, method: 'DELETE' });
  });
});

describe('markup', () => {
  it('listRow escapes user text and marks the selected row', () => {
    const html = listRow(askItem, true, NOW);
    expect(html).toContain('data-item-id="ask:c1"');
    expect(html).toContain('aria-selected="true"');
    expect(html).toContain('Ship &lt;it&gt;?');
    expect(html).toContain('Bot &lt;One&gt;');
    expect(html).not.toContain('<it>');
    expect(html).toContain('2h ago');
    expect(html).toContain(KIND_LABEL.ask);
    expect(listRow(prodItem, false, NOW)).toContain('aria-selected="false"');
  });

  it('listBody renders every row or an empty state', () => {
    const html = listBody(items, 'ask:c1', NOW);
    expect(html.match(/class="needs-row(?: selected)?"/g)?.length).toBe(3);
    expect(listBody([], null, NOW)).toContain('ui-empty');
    expect(listBody([], null, NOW)).toContain('Nothing needs you');
  });

  it('chipBar renders escaped chips with the focused one marked and digits as hints', () => {
    const html = chipBar(askItem.options, 1);
    expect(html).toContain('data-chip="0"');
    expect(html).toContain('data-chip="1"');
    expect(html).toContain('Wait &lt;a bit&gt;');
    expect(html).not.toContain('<a bit>');
    expect(html).toContain('class="needs-chip focus"');
    expect(html).toContain('<kbd>2</kbd>');
    expect(chipBar(null, 0)).toBe('');
    expect(chipBar([], 0)).toBe('');
  });

  it('detailPanel shows the item, its chips, a reply box for input actions, and the action buttons', () => {
    const html = detailPanel(askItem, { chipIndex: 0 }, NOW);
    expect(html).toContain('Should I ship the &lt;digest&gt; today?');
    expect(html).toContain('id="needs-reply"');
    expect(html).toContain('placeholder="Your answer…"');
    expect(html).toContain('data-action="answer"');
    expect(html).toContain('data-action="dismiss"');
    expect(html).toContain('<kbd>a</kbd>');
    expect(html).toContain('<kbd>d</kbd>');
    expect(html).toContain('href="#/needs/inbox/b1/c1"');
    expect(html).toContain('href="#/agents/b1"');
    expect(html).toContain('digest.md');
    expect(html).toContain('needs-chip focus');
    // A production has no chips and an optional input.
    const prod = detailPanel(prodItem, { chipIndex: -1 }, NOW);
    expect(prod).not.toContain('needs-chip');
    expect(prod).toContain('placeholder="Feedback (optional)…"');
    expect(prod).toContain('data-action="approve"');
    // No input action at all: no reply box.
    const bare = detailPanel({ ...askItem, actions: [dismiss], options: null }, {}, NOW);
    expect(bare).not.toContain('id="needs-reply"');
    expect(detailPanel(null, {}, NOW)).toContain('Select an item');
  });

  it('shortcutsHelp lists every shortcut and queueSummary reads naturally', () => {
    const html = shortcutsHelp();
    for (const [keys] of SHORTCUTS) expect(html).toContain(keys.split(' ')[0]);
    expect(queueSummary({ ask: 2, permission: 1, proposal: 0, production: 3, feedback: 0 })).toBe(
      '2 questions · 1 permission · 3 outputs to review'
    );
    expect(queueSummary({})).toBe('All clear');
  });
});
