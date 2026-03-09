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
  let mode = 'login'; // 'login' | 'signup'

  function render() {
    container.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:center;min-height:80vh">
        <div class="detail-card" style="max-width:380px;width:100%">
          <div style="display:flex;gap:0;margin-bottom:16px;border-bottom:1px solid var(--border)">
            <button class="auth-tab ${mode === 'login' ? 'active' : ''}" data-mode="login" style="flex:1;padding:10px;background:none;border:none;border-bottom:2px solid ${mode === 'login' ? 'var(--accent)' : 'transparent'};color:${mode === 'login' ? 'var(--accent)' : 'var(--text-dim)'};font-size:14px;font-weight:600;cursor:pointer;font-family:inherit">Login</button>
            <button class="auth-tab ${mode === 'signup' ? 'active' : ''}" data-mode="signup" style="flex:1;padding:10px;background:none;border:none;border-bottom:2px solid ${mode === 'signup' ? 'var(--accent)' : 'transparent'};color:${mode === 'signup' ? 'var(--accent)' : 'var(--text-dim)'};font-size:14px;font-weight:600;cursor:pointer;font-family:inherit">Sign Up</button>
          </div>
          ${mode === 'login' ? renderLoginForm() : renderSignupForm()}
        </div>
      </div>
    `;

    // Wire tab switching
    for (const tab of container.querySelectorAll('.auth-tab')) {
      tab.addEventListener('click', () => {
        mode = tab.dataset.mode;
        render();
      });
    }

    if (mode === 'login') wireLoginForm();
    else wireSignupForm();
  }

  function renderLoginForm() {
    return `
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
      </form>`;
  }

  function renderSignupForm() {
    return `
      <form id="signup-form">
        <div class="form-group">
          <label class="form-label">Name</label>
          <input type="text" id="signup-name" class="form-input" placeholder="Your company name" required>
        </div>
        <div class="form-group">
          <label class="form-label">Email</label>
          <input type="email" id="signup-email" class="form-input" placeholder="you@example.com" autocomplete="email" required>
        </div>
        <div class="form-group">
          <label class="form-label">Password</label>
          <input type="password" id="signup-password" class="form-input" placeholder="Min 8 characters" autocomplete="new-password" minlength="8" required>
        </div>
        <div id="signup-error" style="color:var(--red);font-size:13px;margin-bottom:8px;display:none"></div>
        <div id="signup-success" style="color:var(--green);font-size:13px;margin-bottom:8px;display:none"></div>
        <button type="submit" class="btn btn-primary" style="width:100%">Create Account</button>
      </form>`;
  }

  function wireLoginForm() {
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

  function wireSignupForm() {
    const form = document.getElementById('signup-form');
    const errorEl = document.getElementById('signup-error');
    const successEl = document.getElementById('signup-success');

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      errorEl.style.display = 'none';
      successEl.style.display = 'none';

      const name = document.getElementById('signup-name').value.trim();
      const email = document.getElementById('signup-email').value.trim();
      const password = document.getElementById('signup-password').value;

      if (!name || !email || password.length < 8) {
        errorEl.textContent = 'All fields are required. Password must be at least 8 characters.';
        errorEl.style.display = '';
        return;
      }

      try {
        const res = await fetch('/api/onboarding/signup', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, email, password }),
        });
        const data = await res.json();
        if (data.success) {
          // Auto-login if session token returned
          if (data.sessionToken) {
            sessionStorage.setItem('auth_token', data.sessionToken);
            sessionStorage.setItem('auth_role', 'tenant');
            sessionStorage.setItem('auth_name', data.tenant?.name || name);
            if (data.tenant?.id) sessionStorage.setItem('auth_tenant_id', data.tenant.id);
            onSuccess(data);
          } else {
            successEl.textContent = 'Account created! You can now log in.';
            successEl.style.display = '';
            setTimeout(() => {
              mode = 'login';
              render();
            }, 1500);
          }
        } else {
          errorEl.textContent = data.error || 'Signup failed';
          errorEl.style.display = '';
        }
      } catch {
        errorEl.textContent = 'Connection error. Please try again.';
        errorEl.style.display = '';
      }
    });

    document.getElementById('signup-name').focus();
  }

  render();
}
