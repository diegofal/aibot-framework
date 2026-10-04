/**
 * Face and voice — the DOM side (session S4 of docs/plans/jarvis-fleet-plan.md).
 *
 * Upload / remove the face through `POST|DELETE /api/agents/:id/avatar`, and
 * speak a line through `POST /api/agents/:id/speak` into an `<audio>` element
 * created on demand. Pure helpers live in `agent-face-helpers.js`; this file
 * needs the auth token and a document.
 */
import { showToast } from '../ui/index.js';
import {
  avatarEndpoint,
  speakButton,
  speakEndpoint,
  validateAvatarFile,
  withToken,
} from './agent-face-helpers.js';
import { getAuthToken } from './shared.js';

function authHeaders(extra = {}) {
  const token = getAuthToken();
  return token ? { Authorization: `Bearer ${token}`, ...extra } : { ...extra };
}

/** Avatar url the browser can load without headers (adds `?token=`). */
export function authedAvatarSrc(url) {
  return withToken(url, getAuthToken());
}

async function readError(res, fallback) {
  try {
    const body = await res.json();
    if (body?.error) return body.error;
  } catch {
    /* not json */
  }
  return `${fallback} (${res.status})`;
}

/** Raw-body upload. Resolves `{ ok, avatarUrl, contentType, size }` or throws. */
export async function uploadAvatar(id, file) {
  const check = validateAvatarFile(file);
  if (!check.ok) throw new Error(check.error);
  const res = await fetch(avatarEndpoint(id), {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': file.type }),
    body: file,
  });
  if (!res.ok) throw new Error(await readError(res, 'Upload failed'));
  return res.json();
}

export async function deleteAvatar(id) {
  const res = await fetch(avatarEndpoint(id), { method: 'DELETE', headers: authHeaders() });
  if (!res.ok) throw new Error(await readError(res, 'Could not remove the face'));
  return res.json();
}

/**
 * Wire the `faceControl()` markup inside `root`. `onChanged(avatarUrl|null)`
 * runs after a successful upload or removal; the avatar `<img>` inside
 * `#presence-avatar` is swapped in place so no full re-render is needed.
 */
export function wireFaceControl(root, id, { onChanged } = {}) {
  if (!root || typeof root.querySelector !== 'function') return;
  const input = root.querySelector('#face-input');
  const change = root.querySelector('#face-change');
  const remove = root.querySelector('#face-remove');
  if (!input || !change) return;

  const swapAvatar = (url) => {
    const holder = root.querySelector('#presence-avatar .ui-avatar');
    if (!holder) return;
    const img = holder.querySelector('img');
    const svg = holder.querySelector('svg');
    if (url) {
      const src = authedAvatarSrc(url);
      if (img) img.src = src;
      else {
        const el = document.createElement('img');
        el.src = src;
        el.alt = holder.getAttribute('title') || '';
        holder.insertBefore(el, holder.firstChild);
        svg?.remove();
      }
    } else if (img) {
      // Back to the seed avatar: cheapest is to reload the header.
      img.remove();
    }
  };

  change.addEventListener('click', () => input.click());
  input.addEventListener('change', async () => {
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    change.disabled = true;
    try {
      const res = await uploadAvatar(id, file);
      swapAvatar(res.avatarUrl);
      showToast('New face saved.', { tone: 'ok' });
      onChanged?.(res.avatarUrl);
    } catch (err) {
      showToast(err.message || 'Upload failed', { tone: 'danger' });
    } finally {
      change.disabled = false;
    }
  });
  remove?.addEventListener('click', async () => {
    remove.disabled = true;
    try {
      await deleteAvatar(id);
      swapAvatar(null);
      showToast('Face removed; back to the seed avatar.', { tone: 'ok' });
      onChanged?.(null);
    } catch (err) {
      showToast(err.message || 'Could not remove the face', { tone: 'danger' });
      remove.disabled = false;
    }
  });
}

/**
 * Wire the play button. `getText()` returns what to say (the current
 * now-line). One `<audio>` per page; clicking while playing stops it.
 */
export function wireSpeakButton(root, id, getText) {
  if (!root || typeof root.querySelector !== 'function') return null;
  const holder = root.querySelector('#presence-speak')?.parentElement;
  if (!holder) return null;
  let audio = null;
  let objectUrl = null;

  const setState = (state) => {
    const old = holder.querySelector('#presence-speak');
    if (!old) return;
    old.outerHTML = speakButton({ state });
    holder.querySelector('#presence-speak')?.addEventListener('click', onClick);
  };

  const cleanup = () => {
    if (audio) {
      audio.pause();
      audio.src = '';
      audio = null;
    }
    if (objectUrl) {
      URL.revokeObjectURL(objectUrl);
      objectUrl = null;
    }
  };

  const stop = () => {
    cleanup();
    setState('idle');
  };

  const onClick = async () => {
    if (audio) return stop();
    const text = String(getText?.() ?? '').trim();
    if (!text) return showToast('Nothing to say yet.', { tone: 'warn' });
    setState('busy');
    try {
      const res = await fetch(speakEndpoint(id), {
        method: 'POST',
        headers: authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ text }),
      });
      if (!res.ok) throw new Error(await readError(res, 'Voice failed'));
      const blob = await res.blob();
      cleanup();
      objectUrl = URL.createObjectURL(blob);
      audio = new Audio(objectUrl);
      audio.addEventListener('ended', stop);
      audio.addEventListener('error', () => {
        showToast('The browser could not play this audio format.', { tone: 'danger' });
        stop();
      });
      setState('playing');
      await audio.play();
    } catch (err) {
      showToast(err.message || 'Voice failed', { tone: 'danger' });
      stop();
    }
  };

  holder.querySelector('#presence-speak')?.addEventListener('click', onClick);
  return { stop };
}
