/**
 * Edits in progress survive a goal-drawer repaint. The drawer is redrawn from
 * `innerHTML` whenever a save or the Activity load lands, and that used to wipe
 * whatever the operator was typing in another field meanwhile (notes opened
 * while the brief was saving). `captureEdits` before the repaint, `restoreEdits`
 * after it, on the same goal only. Takes the drawer element, so it is testable
 * without a DOM.
 */

/** The drawer's free-text fields, by id. `fb-notesed` exists only while Notes is open. */
const KEPT = ['fb-title', 'fb-brief', 'fb-notesed', 'fb-addtask'];

/** `{ fields: { id: value }, focus: { id, start, end } | null }`: what differs from its rendering, and where the caret is. */
export function captureEdits(root, doc) {
  const fields = {};
  for (const id of KEPT) {
    const el = root.querySelector(`#${id}`);
    if (el && el.value !== el.defaultValue) fields[id] = el.value;
  }
  const a = doc?.activeElement;
  const focus =
    a && root.contains(a) && KEPT.includes(a.id)
      ? { id: a.id, start: a.selectionStart, end: a.selectionEnd }
      : null;
  return { fields, focus };
}

/** Put the snapshot back into the repainted drawer; `reopenNotes()` re-opens the Notes editor. */
export function restoreEdits(root, snap, { reopenNotes } = {}) {
  if (!snap) return;
  // Only unsaved notes reopen the editor: Save and Cancel leave it clean on purpose.
  if ('fb-notesed' in snap.fields && !root.querySelector('#fb-notesed')) reopenNotes?.();
  for (const [id, value] of Object.entries(snap.fields)) {
    const el = root.querySelector(`#${id}`);
    if (el) el.value = value;
  }
  const el = snap.focus ? root.querySelector(`#${snap.focus.id}`) : null;
  if (!el) return;
  el.focus();
  if (snap.focus.start != null) el.setSelectionRange(snap.focus.start, snap.focus.end);
}
