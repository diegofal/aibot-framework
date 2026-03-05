import { api, escapeHtml, timeAgo } from './shared.js';

const STATUS_BADGES = {
  pending: '<span class="badge badge-pending">Pending</span>',
  approved: '<span class="badge badge-running">Approved</span>',
  rejected: '<span class="badge badge-stopped">Rejected</span>',
};

export async function renderAgentProposals(el) {
  el.innerHTML = '<div class="page-title">Agent Proposals</div><p class="text-dim">Loading...</p>';

  const proposals = await api('/api/agent-proposals');

  if (proposals.error) {
    el.innerHTML = `
      <div class="page-title">Agent Proposals</div>
      <p class="text-dim">Agent proposals are not enabled. Set <code>agentProposals.enabled: true</code> in config.</p>
    `;
    return;
  }

  const pending = proposals.filter((p) => p.status === 'pending');
  const resolved = proposals.filter((p) => p.status !== 'pending');

  el.innerHTML = `
    <div class="flex-between mb-16">
      <div class="page-title">Agent Proposals <span class="count">${proposals.length}</span></div>
    </div>

    ${
      pending.length > 0
        ? `
      <h3>Pending Review <span class="count">${pending.length}</span></h3>
      <div id="pending-proposals"></div>
    `
        : '<p class="text-dim">No pending proposals. Bots can propose new agents using the <code>create_agent</code> tool.</p>'
    }

    ${
      resolved.length > 0
        ? `
      <h3 class="mt-16">History</h3>
      <table>
        <thead><tr><th>Agent</th><th>Role</th><th>Status</th><th>Proposed By</th><th>Date</th><th>Actions</th></tr></thead>
        <tbody id="resolved-tbody"></tbody>
      </table>
    `
        : ''
    }
  `;

  // Render pending proposal cards
  if (pending.length > 0) {
    const container = document.getElementById('pending-proposals');
    for (const p of pending) {
      const card = document.createElement('div');
      card.className = 'card mb-16';
      card.innerHTML = `
        <div class="flex-between mb-8">
          <div>
            <strong>${p.emoji ? `${escapeHtml(p.emoji)} ` : ''}${escapeHtml(p.agentName)}</strong>
            <span class="text-dim ml-8">${escapeHtml(p.agentId)}</span>
          </div>
          ${STATUS_BADGES.pending}
        </div>
        <div class="detail-grid mb-8">
          <div class="detail-row"><span class="detail-label">Role</span><span>${escapeHtml(p.role)}</span></div>
          <div class="detail-row"><span class="detail-label">Proposed By</span><span>${escapeHtml(p.proposedBy)}</span></div>
          <div class="detail-row"><span class="detail-label">Skills</span><span>${p.skills.map((s) => `<code>${escapeHtml(s)}</code>`).join(', ') || '<span class="text-dim">none</span>'}</span></div>
          ${p.model ? `<div class="detail-row"><span class="detail-label">Model</span><span>${escapeHtml(p.model)}</span></div>` : ''}
          ${p.llmBackend ? `<div class="detail-row"><span class="detail-label">Backend</span><span>${escapeHtml(p.llmBackend)}</span></div>` : ''}
          ${p.language ? `<div class="detail-row"><span class="detail-label">Language</span><span>${escapeHtml(p.language)}</span></div>` : ''}
          <div class="detail-row"><span class="detail-label">Created</span><span>${timeAgo(p.createdAt)}</span></div>
        </div>
        <div class="mb-8">
          <strong class="text-dim">Personality:</strong>
          <p class="mt-4">${escapeHtml(p.personalityDescription)}</p>
        </div>
        <div class="mb-8">
          <strong class="text-dim">Justification:</strong>
          <p class="mt-4">${escapeHtml(p.justification)}</p>
        </div>
        <div class="actions">
          <button class="btn btn-primary" data-action="approve" data-id="${p.id}">Approve & Create Agent</button>
          <button class="btn btn-danger" data-action="reject" data-id="${p.id}">Reject</button>
        </div>
      `;
      container.appendChild(card);
    }

    container.addEventListener('click', async (e) => {
      const btn = e.target.closest('button[data-action]');
      if (!btn) return;
      const action = btn.dataset.action;
      const id = btn.dataset.id;

      if (action === 'approve') {
        btn.disabled = true;
        btn.textContent = 'Creating agent...';
        const result = await api(`/api/agent-proposals/${id}/approve`, { method: 'POST' });
        if (result.error) {
          alert(`Approval failed: ${result.error}`);
          btn.disabled = false;
          btn.textContent = 'Approve & Create Agent';
        } else {
          const soulMsg = result.soulGenerated
            ? 'Soul files generated successfully.'
            : `Agent created with basic IDENTITY.md (soul generation failed: ${result.error || 'unknown'}).`;
          alert(
            `Agent "${result.agent?.name || 'unknown'}" created!\n\n${soulMsg}\n\nThe agent is disabled — start it from the Agents page when ready.`
          );
          renderAgentProposals(el);
        }
      } else if (action === 'reject') {
        const note = prompt('Rejection note (optional):');
        btn.disabled = true;
        btn.textContent = 'Rejecting...';
        await api(`/api/agent-proposals/${id}/reject`, {
          method: 'POST',
          body: { note: note || undefined },
        });
        renderAgentProposals(el);
      }
    });
  }

  // Render resolved history
  if (resolved.length > 0) {
    const tbody = document.getElementById('resolved-tbody');
    for (const p of resolved) {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${p.emoji ? `${escapeHtml(p.emoji)} ` : ''}${escapeHtml(p.agentName)} <span class="text-dim">(${escapeHtml(p.agentId)})</span></td>
        <td class="text-dim">${escapeHtml(p.role)}</td>
        <td>${STATUS_BADGES[p.status] || p.status}</td>
        <td class="text-dim">${escapeHtml(p.proposedBy)}</td>
        <td class="text-dim">${timeAgo(p.updatedAt)}</td>
        <td class="actions">
          <button class="btn btn-sm btn-danger" data-action="delete" data-id="${p.id}">Delete</button>
        </td>
      `;
      tbody.appendChild(tr);
    }

    tbody.addEventListener('click', async (e) => {
      const btn = e.target.closest('button[data-action]');
      if (!btn) return;
      if (btn.dataset.action === 'delete') {
        if (confirm('Delete this proposal record?')) {
          await api(`/api/agent-proposals/${btn.dataset.id}`, { method: 'DELETE' });
          renderAgentProposals(el);
        }
      }
    });
  }
}
