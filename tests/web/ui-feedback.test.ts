import { describe, expect, it } from 'bun:test';
import {
  confirmDialog,
  confirmInline,
  dialogMarkup,
  flushUndoables,
  promptDialog,
  showToast,
  toastMarkup,
  undoable,
} from '../../web/ui/index.js';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Minimal button stand-in: confirmInline only needs textContent + classList. */
function fakeButton(text = 'Delete') {
  const classes = new Set<string>();
  return {
    textContent: text,
    classList: {
      add: (c: string) => classes.add(c),
      remove: (c: string) => classes.delete(c),
      contains: (c: string) => classes.has(c),
    },
    has: (c: string) => classes.has(c),
  };
}

describe('toastMarkup with action', () => {
  it('is unchanged without an action label', () => {
    expect(toastMarkup('<x>', 'ok')).toBe(
      '<div class="ui-toast ui-toast-ok" role="status">&lt;x&gt;</div>'
    );
  });
  it('renders an escaped action button when a label is given', () => {
    const html = toastMarkup('Deleted', 'warn', 'Un<do>');
    expect(html).toContain('ui-toast-warn');
    expect(html).toContain('ui-toast-has-action');
    expect(html).toContain('<span class="ui-toast-text">Deleted</span>');
    expect(html).toContain(
      '<button type="button" class="ui-toast-action" data-toast-action>Un&lt;do&gt;</button>'
    );
  });
  it('showToast with an action is still a no-op without a document', () => {
    expect(showToast('x', { action: { label: 'Undo', onClick: () => {} } })).toBeNull();
  });
});

describe('undoable', () => {
  it('commits once after the delay', async () => {
    let commits = 0;
    let undos = 0;
    const p = undoable('Deleted', {
      commit: () => {
        commits++;
        return 'done';
      },
      undo: () => {
        undos++;
      },
      delayMs: 10,
    });
    const res = await p;
    expect(res).toEqual({ undone: false, result: 'done' });
    await wait(20);
    expect(commits).toBe(1);
    expect(undos).toBe(0);
  });

  it('awaits an async commit result', async () => {
    const res = await undoable('x', { commit: async () => 42, delayMs: 1 });
    expect(res).toEqual({ undone: false, result: 42 });
  });

  it('undo before the delay calls undo and never commits', async () => {
    let commits = 0;
    let undos = 0;
    const p = undoable('Deleted', {
      commit: () => {
        commits++;
      },
      undo: () => {
        undos++;
      },
      delayMs: 20,
    });
    p.undo();
    p.undo();
    const res = await p;
    expect(res).toEqual({ undone: true, result: undefined });
    await wait(40);
    expect(commits).toBe(0);
    expect(undos).toBe(1);
  });

  it('undo is optional', async () => {
    let commits = 0;
    const p = undoable('x', { commit: () => commits++, delayMs: 20 });
    p.undo();
    expect((await p).undone).toBe(true);
    expect(commits).toBe(0);
  });

  it('flushUndoables commits pending actions immediately, exactly once', async () => {
    let commits = 0;
    const p = undoable('x', { commit: () => ++commits, delayMs: 10_000 });
    const q = undoable('y', { commit: () => ++commits, delayMs: 10_000 });
    flushUndoables();
    flushUndoables();
    expect(commits).toBe(2);
    expect((await p).undone).toBe(false);
    expect((await q).undone).toBe(false);
    p.undo();
    expect(commits).toBe(2);
  });

  it('a commit error rejects the promise', async () => {
    const p = undoable('x', {
      commit: () => {
        throw new Error('boom');
      },
      delayMs: 1,
    });
    await expect(p).rejects.toThrow('boom');
  });
});

describe('dialogMarkup', () => {
  it('renders an escaped confirm dialog with tone and labels', () => {
    const html = dialogMarkup({
      title: '<T>',
      message: 'Really <delete>?',
      confirmLabel: 'Delete',
      cancelLabel: 'Keep',
      tone: 'danger',
    });
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain('&lt;T&gt;');
    expect(html).toContain('Really &lt;delete&gt;?');
    expect(html).toContain('btn-danger');
    expect(html).toContain('data-dialog-confirm>Delete</button>');
    expect(html).toContain('data-dialog-cancel>Keep</button>');
    expect(html).not.toContain('data-dialog-input');
  });
  it('defaults labels and maps non-danger tones to primary', () => {
    const html = dialogMarkup({ title: 't', tone: 'accent' });
    expect(html).toContain('>Confirm</button>');
    expect(html).toContain('>Cancel</button>');
    expect(html).toContain('btn-primary');
    expect(html).not.toContain('ui-dialog-message');
  });
  it('renders an input with escaped placeholder and value for prompts', () => {
    const html = dialogMarkup({
      title: 'Note',
      input: { placeholder: 'a"b', value: '<v>' },
    });
    expect(html).toContain('data-dialog-input');
    expect(html).toContain('placeholder="a&quot;b"');
    expect(html).toContain('value="&lt;v&gt;"');
  });
});

describe('dialogs without a document', () => {
  it('confirmDialog resolves false', async () => {
    expect(await confirmDialog({ title: 'x' })).toBe(false);
  });
  it('promptDialog resolves null (callers treat null as abort)', async () => {
    expect(await promptDialog({ title: 'x', defaultValue: 'y' })).toBeNull();
  });
});

describe('confirmInline', () => {
  it('first click arms, second click within timeout confirms and restores', () => {
    const btn = fakeButton('Delete');
    expect(confirmInline(btn, { timeoutMs: 1000 })).toBe(false);
    expect(btn.textContent).toBe('Click again to confirm');
    expect(btn.has('ui-armed')).toBe(true);
    expect(confirmInline(btn, { timeoutMs: 1000 })).toBe(true);
    expect(btn.textContent).toBe('Delete');
    expect(btn.has('ui-armed')).toBe(false);
  });
  it('disarms after the timeout', async () => {
    const btn = fakeButton('Remove');
    expect(confirmInline(btn, { label: 'Sure?', timeoutMs: 10 })).toBe(false);
    expect(btn.textContent).toBe('Sure?');
    await wait(25);
    expect(btn.textContent).toBe('Remove');
    expect(btn.has('ui-armed')).toBe(false);
    expect(confirmInline(btn, { timeoutMs: 10 })).toBe(false);
  });
  it('returns false for a missing button', () => {
    expect(confirmInline(null)).toBe(false);
  });
});
