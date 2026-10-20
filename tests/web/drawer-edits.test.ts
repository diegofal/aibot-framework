import { describe, expect, it } from 'bun:test';
import { captureEdits, restoreEdits } from '../../web/pages/drawer-edits.js';

/** Just enough of a drawer for the two helpers: fields by id and the focused one. */
type Field = {
  id: string;
  value: string;
  defaultValue: string;
  selectionStart?: number;
  selectionEnd?: number;
  focused?: boolean;
  focus(): void;
  setSelectionRange(a: number, b: number): void;
};

function field(id: string, defaultValue: string, value = defaultValue): Field {
  return {
    id,
    value,
    defaultValue,
    focus() {
      this.focused = true;
    },
    setSelectionRange(a, b) {
      this.selectionStart = a;
      this.selectionEnd = b;
    },
  };
}

function drawer(fields: Field[]) {
  const byId = new Map(fields.map((f) => [f.id, f]));
  return {
    querySelector: (sel: string) => byId.get(sel.replace(/^#/, '')) ?? null,
    contains: (el: unknown) => fields.includes(el as Field),
    add(f: Field) {
      byId.set(f.id, f);
      fields.push(f);
    },
  };
}

describe('a drawer repaint keeps the edit in progress', () => {
  it('notes typed while a brief save was in flight survive the repaint (review finding, PR 7)', () => {
    const notes = field('fb-notesed', '', 'half-written note');
    notes.selectionStart = 4;
    notes.selectionEnd = 4;
    const before = drawer([field('fb-brief', 'old', 'new brief'), notes]);
    const snap = captureEdits(before, { activeElement: notes });

    // The repaint after the save: the brief carries the saved text, the notes editor is gone.
    const after = drawer([field('fb-brief', 'new brief')]);
    let reopened = 0;
    restoreEdits(after, snap, {
      reopenNotes: () => {
        reopened++;
        after.add(field('fb-notesed', ''));
      },
    });

    const back = after.querySelector('#fb-notesed') as Field;
    expect(reopened).toBe(1);
    expect(back.value).toBe('half-written note');
    expect(back.focused).toBe(true);
    expect([back.selectionStart, back.selectionEnd]).toEqual([4, 4]);
    expect((after.querySelector('#fb-brief') as Field).value).toBe('new brief');
  });

  it('a field nobody changed takes the fresh value; nothing reopens', () => {
    const before = drawer([field('fb-title', 'Old title'), field('fb-brief', 'old')]);
    const snap = captureEdits(before, { activeElement: null });
    const after = drawer([field('fb-title', 'Title from server'), field('fb-brief', 'fresh')]);
    let reopened = 0;
    restoreEdits(after, snap, { reopenNotes: () => reopened++ });
    expect((after.querySelector('#fb-title') as Field).value).toBe('Title from server');
    expect((after.querySelector('#fb-brief') as Field).value).toBe('fresh');
    expect(reopened).toBe(0);
  });

  it('a saved or cancelled notes editor (clean, still focused) does not come back', () => {
    const notes = field('fb-notesed', 'saved text');
    const snap = captureEdits(drawer([notes]), { activeElement: notes });
    const after = drawer([]);
    let reopened = 0;
    restoreEdits(after, snap, { reopenNotes: () => reopened++ });
    expect(reopened).toBe(0);
  });

  it('a focused field outside the drawer is not the drawer’s to restore', () => {
    const before = drawer([field('fb-title', 'T')]);
    const outside = field('elsewhere', '');
    expect(captureEdits(before, { activeElement: outside }).focus).toBeNull();
  });
});
