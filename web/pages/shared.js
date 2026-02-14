const overlay = document.getElementById('modal-overlay');
const modal = document.getElementById('modal');

export function showModal(html) {
  modal.innerHTML = html;
  overlay.classList.remove('hidden');
}

export function closeModal() {
  overlay.classList.add('hidden');
  modal.innerHTML = '';
}

// Close modal on overlay click
overlay.addEventListener('click', (e) => {
  if (e.target === overlay) closeModal();
});

// Close modal on Escape
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !overlay.classList.contains('hidden')) closeModal();
});

export async function api(url, opts = {}) {
  const fetchOpts = { headers: {} };
  if (opts.method) fetchOpts.method = opts.method;
  if (opts.body) {
    fetchOpts.headers['Content-Type'] = 'application/json';
    fetchOpts.body = JSON.stringify(opts.body);
  }
  try {
    const res = await fetch(url, fetchOpts);
    return await res.json();
  } catch (err) {
    console.error('API error:', err);
    return { error: err.message };
  }
}

const _div = document.createElement('div');
export function escapeHtml(str) {
  if (!str) return '';
  _div.textContent = str;
  return _div.innerHTML;
}

export function timeAgo(isoOrDate, future = false) {
  const d = new Date(isoOrDate);
  const diff = future ? d - Date.now() : Date.now() - d;
  const abs = Math.abs(diff);
  const suffix = future ? (diff > 0 ? 'from now' : 'ago') : 'ago';

  if (abs < 60_000) return 'just now';
  if (abs < 3600_000) return `${Math.floor(abs / 60_000)}m ${suffix}`;
  if (abs < 86400_000) return `${Math.floor(abs / 3600_000)}h ${suffix}`;
  return `${Math.floor(abs / 86400_000)}d ${suffix}`;
}
