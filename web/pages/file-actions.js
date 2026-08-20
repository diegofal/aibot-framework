export function getMimeType(filename) {
  if (!filename) return 'text/plain;charset=utf-8';
  const lower = filename.toLowerCase();
  if (lower.endsWith('.md') || lower.endsWith('.markdown')) return 'text/markdown';
  if (lower.endsWith('.html') || lower.endsWith('.htm')) return 'text/html';
  if (lower.endsWith('.json')) return 'application/json';
  if (lower.endsWith('.csv')) return 'text/csv';
  return 'text/plain;charset=utf-8';
}

export function downloadFilename(path) {
  if (!path) return '';
  const s = String(path).replace(/\\/g, '/');
  const trimmed = s.endsWith('/') ? s.slice(0, -1) : s;
  const idx = trimmed.lastIndexOf('/');
  return idx === -1 ? trimmed : trimmed.slice(idx + 1);
}

export function flashButtonLabel(btn, text, durationMs = 1500) {
  if (!btn) return;
  const original = btn.dataset.originalLabel || btn.textContent;
  btn.dataset.originalLabel = original;
  btn.textContent = text;
  setTimeout(() => {
    if (!btn.isConnected) return;
    btn.textContent = btn.dataset.originalLabel || original;
  }, durationMs);
}

export function downloadTextFile(filename, content) {
  const blob = new Blob([content != null ? content : ''], { type: getMimeType(filename) });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = downloadFilename(filename) || 'download.txt';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export async function copyTextToClipboard(text) {
  if (navigator?.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text != null ? String(text) : '');
      return true;
    } catch (_) {
      // fall through to legacy fallback
    }
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text != null ? String(text) : '';
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.top = '0';
    ta.style.left = '-9999px';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch (_) {
    return false;
  }
}

let _fullscreenOverlay = null;
let _fullscreenListener = null;

function detachFullscreenListener() {
  if (_fullscreenListener) {
    document.removeEventListener('keydown', _fullscreenListener, true);
    _fullscreenListener = null;
  }
}

export function closeFullscreenViewer() {
  detachFullscreenListener();
  if (_fullscreenOverlay?.parentNode) {
    _fullscreenOverlay.parentNode.removeChild(_fullscreenOverlay);
  }
  _fullscreenOverlay = null;
}

export function openFullscreenViewer({ titleHtml, bodyHtml, path, content } = {}) {
  closeFullscreenViewer();

  const overlay = document.createElement('div');
  overlay.id = 'prod-fullscreen-overlay';
  overlay.className = 'prod-fullscreen-overlay';
  const enabled = content != null;
  const safePath = path || '';
  overlay.innerHTML = `
    <div class="prod-fullscreen-header">
      <div class="prod-fullscreen-title">${titleHtml || ''}</div>
      <div class="prod-fullscreen-actions">
        <button class="btn btn-sm" id="prod-fullscreen-copy" title="Copy contents">Copy</button>
        <button class="btn btn-sm" id="prod-fullscreen-download" title="Download file">Download</button>
        <button class="btn btn-sm" id="prod-fullscreen-close" title="Close (Esc)">Close</button>
      </div>
    </div>
    <div class="prod-fullscreen-body"><div class="production-content">${bodyHtml || ''}</div></div>
  `;
  document.body.appendChild(overlay);
  _fullscreenOverlay = overlay;

  const copyBtn = overlay.querySelector('#prod-fullscreen-copy');
  const downloadBtn = overlay.querySelector('#prod-fullscreen-download');
  if (copyBtn) copyBtn.disabled = !enabled;
  if (downloadBtn) downloadBtn.disabled = !enabled;
  if (enabled) {
    copyBtn?.addEventListener('click', async () => {
      const ok = await copyTextToClipboard(content);
      flashButtonLabel(copyBtn, ok ? 'Copied' : 'Failed');
    });
    downloadBtn?.addEventListener('click', () => {
      downloadTextFile(safePath, content);
    });
  }

  overlay.querySelector('#prod-fullscreen-close')?.addEventListener('click', closeFullscreenViewer);

  _fullscreenListener = (e) => {
    if (e.key !== 'Escape') return;
    if (!overlay.isConnected) return;
    e.stopPropagation();
    e.preventDefault();
    closeFullscreenViewer();
  };
  document.addEventListener('keydown', _fullscreenListener, true);
}
