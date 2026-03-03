export function renderAdminSetup(container, onSuccess) {
  container.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:center;min-height:80vh">
      <div class="detail-card" style="max-width:380px;width:100%">
        <div class="page-title" style="margin-bottom:4px">Admin Setup</div>
        <p class="text-dim" style="font-size:13px;margin-bottom:16px">Create your admin account to get started.</p>
        <form id="setup-form">
          <div class="form-group">
            <label class="form-label">Email</label>
            <input type="email" id="setup-email" class="form-input" placeholder="admin@example.com" autocomplete="email" required>
          </div>
          <div class="form-group">
            <label class="form-label">Password</label>
            <input type="password" id="setup-password" class="form-input" placeholder="Min 8 characters" autocomplete="new-password" minlength="8" required>
          </div>
          <div id="setup-error" style="color:var(--red);font-size:13px;margin-bottom:8px;display:none"></div>
          <button type="submit" class="btn btn-primary" style="width:100%">Create Admin Account</button>
        </form>
      </div>
    </div>
  `;

  const form = document.getElementById('setup-form');
  const errorEl = document.getElementById('setup-error');

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    errorEl.style.display = 'none';
    const email = document.getElementById('setup-email').value.trim();
    const password = document.getElementById('setup-password').value;

    if (!email || password.length < 8) return;

    try {
      const res = await fetch('/api/auth/admin-setup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      const data = await res.json();
      if (data.success) {
        onSuccess();
      } else {
        errorEl.textContent = data.error || 'Setup failed';
        errorEl.style.display = '';
      }
    } catch {
      errorEl.textContent = 'Connection error. Please try again.';
      errorEl.style.display = '';
    }
  });

  document.getElementById('setup-email').focus();
}

export function renderLogin(container, onSuccess) {
  container.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:center;min-height:80vh">
      <div class="detail-card" style="max-width:380px;width:100%">
        <div class="page-title" style="margin-bottom:16px">Login</div>
        <form id="login-form">
          <div class="form-group">
            <label class="form-label">Email</label>
            <input type="email" id="login-email" class="form-input" placeholder="you@example.com" autocomplete="email" required>
          </div>
          <div class="form-group">
            <label class="form-label">Password</label>
            <input type="password" id="login-password" class="form-input" placeholder="Enter your password" autocomplete="current-password" required>
          </div>
          <div id="login-error" style="color:var(--red);font-size:13px;margin-bottom:8px;display:none"></div>
          <button type="submit" class="btn btn-primary" style="width:100%">Login</button>
        </form>
      </div>
    </div>
  `;

  const form = document.getElementById('login-form');
  const errorEl = document.getElementById('login-error');

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    errorEl.style.display = 'none';
    const email = document.getElementById('login-email').value.trim();
    const password = document.getElementById('login-password').value;

    if (!email || !password) return;

    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      const data = await res.json();
      if (data.sessionToken) {
        sessionStorage.setItem('auth_token', data.sessionToken);
        sessionStorage.setItem('auth_role', data.role);
        sessionStorage.setItem('auth_name', data.name);
        if (data.tenantId) sessionStorage.setItem('auth_tenant_id', data.tenantId);
        onSuccess(data);
      } else {
        errorEl.textContent = data.error || 'Invalid credentials';
        errorEl.style.display = '';
      }
    } catch {
      errorEl.textContent = 'Connection error. Please try again.';
      errorEl.style.display = '';
    }
  });

  document.getElementById('login-email').focus();
}
