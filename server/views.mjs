/**
 * views.mjs — Server-side HTML view functions for the GapScout web UI.
 *
 * Every export returns a complete HTML string. No external assets, no build step.
 * Design: minimalist dark-mode UI inspired by Linear/Vercel.
 */

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Escape a string for safe HTML embedding (prevents XSS). */
function esc(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Format an ISO date string to a short human-readable form. */
function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

/** Format duration in seconds to a human string like "3m 12s". */
function fmtDuration(seconds) {
  if (seconds == null || seconds < 0) return '—';
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  if (m === 0) return `${s}s`;
  return `${m}m ${s}s`;
}

// ─── CSS ──────────────────────────────────────────────────────────────────────

export function css() {
  return `
:root {
  --bg: #0a0a0a; --bg-card: #111; --bg-hover: #1a1a1a;
  --fg: #fafafa; --fg-muted: #888; --fg-dim: #555;
  --accent: #3b82f6; --accent-hover: #2563eb;
  --border: #222; --radius: 8px;
  --success: #22c55e; --warning: #eab308; --error: #ef4444; --muted: #6b7280;
}
[data-theme="light"] {
  --bg: #fafafa; --bg-card: #fff; --bg-hover: #f5f5f5;
  --fg: #0a0a0a; --fg-muted: #666; --fg-dim: #999;
  --border: #e5e5e5;
}

*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

body {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  font-size: 14px;
  line-height: 1.6;
  color: var(--fg);
  background: var(--bg);
  -webkit-font-smoothing: antialiased;
  padding-top: 52px;
}

a { color: var(--accent); text-decoration: none; }
a:hover { color: var(--accent-hover); text-decoration: underline; }

/* ── Nav ─────────────────────────────────────────────────────────────────── */

.nav {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 24px;
  height: 52px;
  border-bottom: 1px solid var(--border);
  background: var(--bg-card);
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  z-index: 100;
}
.nav-brand {
  font-weight: 700;
  font-size: 15px;
  color: var(--fg);
  letter-spacing: -0.3px;
}
.nav-brand:hover { text-decoration: none; }
.nav-right {
  display: flex;
  align-items: center;
  gap: 12px;
}
.nav-user {
  font-size: 13px;
  color: var(--fg-muted);
}
.btn-ghost {
  background: none;
  border: 1px solid var(--border);
  color: var(--fg-muted);
  padding: 4px 10px;
  border-radius: var(--radius);
  font-size: 12px;
  cursor: pointer;
  font-family: inherit;
  transition: background 0.15s, color 0.15s;
}
.btn-ghost:hover {
  background: var(--bg-hover);
  color: var(--fg);
}
.theme-toggle {
  background: none;
  border: none;
  color: var(--fg-muted);
  cursor: pointer;
  font-size: 16px;
  padding: 4px;
  line-height: 1;
  border-radius: var(--radius);
  transition: color 0.15s;
}
.theme-toggle:hover { color: var(--fg); }

/* ── Layout ──────────────────────────────────────────────────────────────── */

.container {
  max-width: 960px;
  margin: 0 auto;
  padding: 32px 24px 64px;
}
.page-header {
  margin-bottom: 28px;
}
.page-header h1 {
  font-size: 22px;
  font-weight: 700;
  letter-spacing: -0.4px;
  margin-bottom: 4px;
}
.page-header .subtitle {
  color: var(--fg-muted);
  font-size: 13px;
}
.back-link {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 13px;
  color: var(--fg-muted);
  margin-bottom: 16px;
}
.back-link:hover { color: var(--fg); text-decoration: none; }

/* ── Buttons ─────────────────────────────────────────────────────────────── */

.btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 8px 16px;
  border-radius: var(--radius);
  font-size: 13px;
  font-weight: 500;
  font-family: inherit;
  cursor: pointer;
  border: none;
  transition: background 0.15s, opacity 0.15s;
  text-decoration: none;
}
.btn:hover { text-decoration: none; }
.btn-primary {
  background: var(--accent);
  color: #fff;
}
.btn-primary:hover {
  background: var(--accent-hover);
  color: #fff;
}
.btn-sm {
  padding: 4px 10px;
  font-size: 12px;
}
.btn-muted {
  background: var(--bg-hover);
  color: var(--fg-muted);
  border: 1px solid var(--border);
}
.btn-muted:hover {
  background: var(--border);
  color: var(--fg);
}
.btn-danger {
  background: none;
  color: var(--error);
  border: 1px solid color-mix(in srgb, var(--error) 30%, transparent);
}
.btn-danger:hover {
  background: color-mix(in srgb, var(--error) 10%, transparent);
}

/* ── Cards ───────────────────────────────────────────────────────────────── */

.card {
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 20px;
}
.card + .card { margin-top: 12px; }

/* ── Stats row ───────────────────────────────────────────────────────────── */

.stats-row {
  display: flex;
  gap: 20px;
  align-items: center;
  margin-bottom: 8px;
  flex-wrap: wrap;
}
.stat {
  font-size: 13px;
  color: var(--fg-muted);
}
.stat strong {
  color: var(--fg);
  font-weight: 600;
}

/* ── Table ───────────────────────────────────────────────────────────────── */

.table-wrap {
  overflow-x: auto;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg-card);
}
table {
  width: 100%;
  min-width: 600px;
  border-collapse: collapse;
  font-size: 13px;
}
thead th {
  text-align: left;
  padding: 10px 14px;
  font-weight: 600;
  font-size: 12px;
  text-transform: uppercase;
  letter-spacing: 0.4px;
  color: var(--fg-muted);
  border-bottom: 1px solid var(--border);
  white-space: nowrap;
}
tbody td {
  padding: 10px 14px;
  border-bottom: 1px solid var(--border);
  vertical-align: middle;
}
tbody tr:last-child td { border-bottom: none; }
tbody tr:hover { background: var(--bg-hover); }

/* ── Status pill ─────────────────────────────────────────────────────────── */

.pill {
  display: inline-block;
  padding: 2px 8px;
  border-radius: 9999px;
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.3px;
}
.pill-completed { background: color-mix(in srgb, var(--success) 15%, transparent); color: var(--success); }
.pill-running   { background: color-mix(in srgb, var(--warning) 15%, transparent); color: var(--warning); }
.pill-failed    { background: color-mix(in srgb, var(--error) 15%, transparent);   color: var(--error); }
.pill-queued,
.pill-cancelled { background: color-mix(in srgb, var(--muted) 15%, transparent);   color: var(--muted); }

/* ── Progress bar ────────────────────────────────────────────────────────── */

.progress-track {
  width: 100%;
  height: 6px;
  background: var(--bg-hover);
  border-radius: 3px;
  overflow: hidden;
  margin: 8px 0 4px;
}
.progress-fill {
  height: 100%;
  background: var(--accent);
  border-radius: 3px;
  transition: width 0.4s ease;
}
.progress-fill.animated {
  animation: pulse 2s ease-in-out infinite;
}
@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.7; }
}
.progress-lg .progress-track {
  height: 10px;
  border-radius: 5px;
}
.progress-lg .progress-fill {
  border-radius: 5px;
}
.progress-text {
  font-size: 12px;
  color: var(--fg-muted);
  margin-top: 2px;
}
.progress-pct {
  font-size: 20px;
  font-weight: 700;
  color: var(--fg);
}

/* ── Forms ───────────────────────────────────────────────────────────────── */

.form-group {
  margin-bottom: 16px;
}
.form-group label {
  display: block;
  font-size: 13px;
  font-weight: 500;
  margin-bottom: 5px;
  color: var(--fg);
}
.form-group .hint {
  font-size: 12px;
  color: var(--fg-dim);
  margin-top: 3px;
}
.radio-card:hover { border-color: var(--accent); }
.radio-card:has(input:checked) { border-color: var(--accent); background: var(--bg-hover); }
input[type="text"],
input[type="password"] {
  width: 100%;
  padding: 8px 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg);
  color: var(--fg);
  font-size: 14px;
  font-family: inherit;
  outline: none;
  transition: border-color 0.15s;
}
input[type="text"]:focus,
input[type="password"]:focus {
  border-color: var(--accent);
}
input::placeholder { color: var(--fg-dim); }

/* ── Alert ───────────────────────────────────────────────────────────────── */

.alert {
  padding: 10px 14px;
  border-radius: var(--radius);
  font-size: 13px;
  margin-bottom: 16px;
}
.alert-error {
  background: color-mix(in srgb, var(--error) 10%, transparent);
  border: 1px solid color-mix(in srgb, var(--error) 25%, transparent);
  color: var(--error);
}
.alert-success {
  background: color-mix(in srgb, var(--success) 10%, transparent);
  border: 1px solid color-mix(in srgb, var(--success) 25%, transparent);
  color: var(--success);
}

/* ── Login ───────────────────────────────────────────────────────────────── */

.login-wrapper {
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
}
.login-card {
  width: 100%;
  max-width: 360px;
}
.login-card h1 {
  font-size: 24px;
  font-weight: 700;
  letter-spacing: -0.5px;
  margin-bottom: 4px;
}
.login-card .subtitle {
  color: var(--fg-muted);
  font-size: 14px;
  margin-bottom: 24px;
}

/* ── Empty state ─────────────────────────────────────────────────────────── */

.empty {
  text-align: center;
  padding: 48px 24px;
  color: var(--fg-muted);
  font-size: 14px;
}
.empty a { font-weight: 500; }

/* ── Sections ────────────────────────────────────────────────────────────── */

.section { margin-bottom: 32px; }
.section-title {
  font-size: 14px;
  font-weight: 600;
  margin-bottom: 12px;
  color: var(--fg);
}

/* ── Detail meta ─────────────────────────────────────────────────────────── */

.meta-row {
  display: flex;
  gap: 24px;
  flex-wrap: wrap;
  margin-bottom: 20px;
  font-size: 13px;
}
.meta-item {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.meta-label { color: var(--fg-dim); font-size: 11px; text-transform: uppercase; letter-spacing: 0.4px; }
.meta-value { color: var(--fg-muted); }

/* ── Artifacts list ──────────────────────────────────────────────────────── */

.artifact-list {
  list-style: none;
}
.artifact-list li {
  padding: 8px 0;
  border-bottom: 1px solid var(--border);
  font-size: 13px;
}
.artifact-list li:last-child { border-bottom: none; }
.artifact-list a {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

/* ── Responsive ──────────────────────────────────────────────────────────── */

@media (max-width: 640px) {
  .container { padding: 20px 16px 48px; }
  .nav { padding: 0 16px; }
  .stats-row { gap: 12px; }
  .meta-row { gap: 14px; }
}

/* ── Log panel ────────────────────────────────────────────────────────────── */

.log-panel { background: #050505; border: 1px solid var(--border); border-radius: var(--radius); margin-top: 20px; overflow: hidden; }
[data-theme="light"] .log-panel { background: #f0f0f0; }
.log-header { display: flex; justify-content: space-between; align-items: center; padding: 10px 14px; border-bottom: 1px solid var(--border); font-size: 12px; color: var(--fg-muted); text-transform: uppercase; letter-spacing: 0.5px; }
.log-header button { background: none; border: 1px solid var(--border); color: var(--fg-muted); padding: 2px 8px; border-radius: 4px; cursor: pointer; font-size: 11px; }
.log-body { height: 300px; overflow-y: auto; padding: 10px 14px; font-family: 'SF Mono', 'Fira Code', 'Cascadia Code', monospace; font-size: 12px; line-height: 1.6; }
.log-line { white-space: pre-wrap; word-break: break-all; }
.log-line .log-ts { color: var(--fg-dim); margin-right: 8px; }
.log-line .log-text { color: var(--fg); }
.log-line .log-text.warn { color: var(--warning); }
.log-line .log-text.err { color: var(--error); }
.log-line .log-text.ok { color: var(--success); }
.log-empty { color: var(--fg-dim); font-style: italic; }
.log-count { font-variant-numeric: tabular-nums; }

/* ── Chat panel ─────────────────────────────────────────────────────────── */

.chat-panel { background: var(--bg-card); border: 1px solid var(--border); border-radius: var(--radius); margin-top: 20px; display: flex; flex-direction: column; height: 400px; }
.chat-header { padding: 10px 14px; border-bottom: 1px solid var(--border); font-size: 12px; color: var(--fg-muted); text-transform: uppercase; letter-spacing: 0.5px; display: flex; justify-content: space-between; align-items: center; }
.chat-messages { flex: 1; overflow-y: auto; padding: 14px; display: flex; flex-direction: column; gap: 12px; }
.chat-msg { max-width: 85%; }
.chat-msg.user { align-self: flex-end; }
.chat-msg.assistant { align-self: flex-start; }
.chat-msg-header { font-size: 11px; color: var(--fg-dim); margin-bottom: 3px; }
.chat-msg.user .chat-msg-header { text-align: right; }
.chat-msg-body { padding: 10px 14px; border-radius: 12px; font-size: 13px; line-height: 1.5; white-space: pre-wrap; word-break: break-word; }
.chat-msg.user .chat-msg-body { background: var(--accent); color: #fff; border-bottom-right-radius: 4px; }
.chat-msg.assistant .chat-msg-body { background: var(--bg-hover); color: var(--fg); border-bottom-left-radius: 4px; border: 1px solid var(--border); }
.chat-msg.assistant .chat-msg-body.streaming { border-color: var(--accent); }
.chat-input-area { display: flex; gap: 8px; padding: 10px 14px; border-top: 1px solid var(--border); }
.chat-input-area input { flex: 1; background: var(--bg); border: 1px solid var(--border); border-radius: var(--radius); padding: 8px 12px; color: var(--fg); font-size: 13px; outline: none; }
.chat-input-area input:focus { border-color: var(--accent); }
.chat-input-area button { background: var(--accent); color: #fff; border: none; border-radius: var(--radius); padding: 8px 16px; font-size: 13px; cursor: pointer; white-space: nowrap; }
.chat-input-area button:hover { background: var(--accent-hover); }
.chat-input-area button:disabled { opacity: 0.5; cursor: not-allowed; }
.chat-empty { color: var(--fg-dim); font-style: italic; text-align: center; margin: auto; font-size: 13px; }
.chat-suggestions { display: flex; flex-wrap: wrap; gap: 6px; justify-content: center; margin-top: 8px; }
.chat-suggestion { background: var(--bg-hover); border: 1px solid var(--border); border-radius: 16px; padding: 4px 12px; font-size: 12px; color: var(--fg-muted); cursor: pointer; transition: all 0.15s; }
.chat-suggestion:hover { border-color: var(--accent); color: var(--fg); }

/* ── Phase timeline ─────────────────────────────────────────────────────── */

.phase-timeline { display: flex; align-items: center; gap: 4px; padding: 16px; background: var(--bg-card); border: 1px solid var(--border); border-radius: var(--radius); margin-top: 16px; overflow-x: auto; }
.phase-step { display: flex; flex-direction: column; align-items: center; gap: 4px; min-width: 70px; }
.phase-badge { width: 32px; height: 32px; border-radius: 50%; background: var(--bg-hover); border: 2px solid var(--border); display: flex; align-items: center; justify-content: center; font-weight: 600; font-size: 13px; color: var(--fg-muted); transition: all 0.3s; }
.phase-step.completed .phase-badge { background: var(--success); border-color: var(--success); color: #fff; }
.phase-step.active .phase-badge { background: var(--accent); border-color: var(--accent); color: #fff; animation: phase-pulse 2s ease-in-out infinite; }
@keyframes phase-pulse { 0%,100% { box-shadow: 0 0 0 0 rgba(59,130,246,0.4); } 50% { box-shadow: 0 0 0 8px rgba(59,130,246,0); } }
.phase-label { font-size: 10px; text-align: center; color: var(--fg-dim); max-width: 80px; }
.phase-step.completed .phase-label { color: var(--fg-muted); }
.phase-step.active .phase-label { color: var(--fg); font-weight: 500; }
.phase-time { font-size: 9px; color: var(--fg-dim); }
.phase-connector { flex: 0 0 20px; height: 2px; background: var(--border); }
.phase-connector.done { background: var(--success); }
.phase-connector.active { background: linear-gradient(90deg, var(--success), var(--accent)); }
.agent-stats { display: flex; gap: 16px; padding: 12px 16px; background: var(--bg-hover); border-radius: var(--radius); margin-top: 12px; font-size: 13px; }
.agent-stat-value { font-weight: 700; font-size: 18px; margin-right: 4px; }
`;
}

// ─── Layout ───────────────────────────────────────────────────────────────────

export function renderLayout(title, bodyHtml, { user, scripts, basePath = '' } = {}) {
  const themeJs = `
(function() {
  var saved = localStorage.getItem('theme');
  if (saved) document.documentElement.setAttribute('data-theme', saved);
  document.addEventListener('DOMContentLoaded', function() {
    var btn = document.getElementById('themeToggle');
    if (!btn) return;
    function update() {
      var current = document.documentElement.getAttribute('data-theme');
      btn.innerHTML = current === 'light' ? '&#9790;' : '&#9788;';
      btn.title = current === 'light' ? 'Switch to dark mode' : 'Switch to light mode';
    }
    update();
    btn.addEventListener('click', function() {
      var current = document.documentElement.getAttribute('data-theme');
      var next = current === 'light' ? 'dark' : 'light';
      document.documentElement.setAttribute('data-theme', next);
      localStorage.setItem('theme', next);
      update();
    });
  });
})();
`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${esc(title)} — GapScout</title>
  <style>${css()}</style>
</head>
<body>
  <nav class="nav">
    <a href="${basePath}/" class="nav-brand">GapScout</a>
    <div class="nav-right">
      <a href="${basePath}/settings" class="btn-ghost" style="margin-right:4px">Settings</a>
      <button class="theme-toggle" id="themeToggle" aria-label="Toggle theme">&#9788;</button>
${user ? `      <span class="nav-user">${esc(user.username)}</span>
      <form method="POST" action="${basePath}/logout" style="display:inline"><button type="submit" class="btn-ghost">Log out</button></form>` : ''}
    </div>
  </nav>
  ${bodyHtml}
  <script>${themeJs}</script>
${scripts ? `  <script>${scripts}</script>` : ''}
</body>
</html>`;
}

// ─── Login ────────────────────────────────────────────────────────────────────

export function renderLogin(error, { basePath = '' } = {}) {
  const body = `
<div class="login-wrapper">
  <div class="login-card">
    <h1>GapScout</h1>
    <p class="subtitle">Sign in to your account</p>
${error ? `    <div class="alert alert-error">${esc(error)}</div>` : ''}
    <form method="POST" action="${basePath}/login">
      <div class="form-group">
        <label for="username">Username</label>
        <input type="text" id="username" name="username" required autocomplete="username" autofocus>
      </div>
      <div class="form-group">
        <label for="password">Password</label>
        <input type="password" id="password" name="password" required autocomplete="current-password">
      </div>
      <button type="submit" class="btn btn-primary" style="width:100%;margin-top:4px">Sign in</button>
    </form>
  </div>
</div>`;

  return renderLayout('Sign in', body, { basePath });
}

// ─── Dashboard ────────────────────────────────────────────────────────────────

export function renderDashboard(scans, activeCount, queueLength, { user, basePath = '' } = {}) {
  const scanList = scans.scans || [];
  const total = scans.total || 0;
  const runningScans = scanList.filter(s => s.status === 'running');

  let activeSection = '';
  if (runningScans.length) {
    const cards = runningScans.map(s => {
      const pct = s.progress_pct || 0;
      const detail = esc(s.progress_detail || '');
      return `
      <div class="card">
        <div style="display:flex;justify-content:space-between;align-items:flex-start">
          <div>
            <strong>${esc(s.name || s.domain)}</strong>
            <div style="font-size:12px;color:var(--fg-muted)">${esc(s.domain)}</div>
          </div>
          <form method="POST" action="${basePath}/scans/${esc(s.id)}/cancel">
            <button type="submit" class="btn btn-sm btn-muted">Cancel</button>
          </form>
        </div>
        <div class="progress-track"><div class="progress-fill animated" style="width:${pct}%"></div></div>
        <div class="progress-text">${detail || `${pct}% complete`}</div>
      </div>`;
    }).join('');

    activeSection = `
    <div class="section">
      <div class="section-title">Active Scans</div>
      ${cards}
    </div>`;
  }

  const pillClass = (status) => `pill pill-${status || 'queued'}`;

  let tableBody = '';
  if (scanList.length === 0) {
    tableBody = `
    <div class="empty">
      No scans yet. <a href="${basePath}/scans/new">Start your first scan.</a>
    </div>`;
  } else {
    const rows = scanList.map(s => {
      const dur = (s.status === 'completed' && s.started_at && s.completed_at)
        ? fmtDuration((new Date(s.completed_at) - new Date(s.started_at)) / 1000)
        : '—';
      const action = s.status === 'completed'
        ? `<a href="${basePath}/scans/${esc(s.id)}" class="btn btn-sm btn-muted">View</a>`
        : `<a href="${basePath}/scans/${esc(s.id)}" class="btn btn-sm btn-muted">Details</a>`;
      return `
        <tr>
          <td>${esc(s.name || '—')}</td>
          <td>${esc(s.domain)}</td>
          <td><span class="${pillClass(s.status)}">${esc(s.status)}</span></td>
          <td>${fmtDate(s.created_at)}</td>
          <td>${dur}</td>
          <td>${action}</td>
        </tr>`;
    }).join('');

    tableBody = `
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Name</th>
            <th>Domain</th>
            <th>Status</th>
            <th>Created</th>
            <th>Duration</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
  }

  const body = `
<div class="container">
  <div class="page-header">
    <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:12px">
      <h1>Dashboard</h1>
      <a href="${basePath}/scans/new" class="btn btn-primary">New Scan</a>
    </div>
    <div class="stats-row" style="margin-top:10px">
      <span class="stat"><strong>${activeCount}</strong> running</span>
      <span class="stat"><strong>${queueLength}</strong> queued</span>
      <span class="stat"><strong>${total}</strong> total scans</span>
    </div>
  </div>
  ${activeSection}
  <div class="section">
    <div class="section-title">Scan History</div>
    ${tableBody}
  </div>
</div>`;

  return renderLayout('Dashboard', body, { user, basePath });
}

// ─── New Scan ─────────────────────────────────────────────────────────────────

export function renderNewScan({ user, basePath = '' } = {}) {
  const body = `
<div class="container" style="max-width:560px">
  <a href="${basePath}/" class="back-link">&larr; Dashboard</a>
  <div class="page-header">
    <h1>New Scan</h1>
  </div>
  <div class="card">
    <form method="POST" action="${basePath}/scans">
      <div class="form-group">
        <label for="domain">Market / Domain</label>
        <input type="text" id="domain" name="domain" required placeholder="e.g. project management tools">
      </div>
      <div class="form-group">
        <label>Scan Mode</label>
        <div style="display:flex;gap:12px;margin-top:6px">
          <label class="radio-card" style="flex:1;display:flex;align-items:flex-start;gap:10px;padding:12px;border:1px solid var(--border);border-radius:var(--radius);cursor:pointer">
            <input type="radio" name="mode" value="full" checked style="margin-top:3px">
            <div>
              <strong style="display:block;margin-bottom:2px">Deep Scan</strong>
              <span style="font-size:12px;color:var(--fg-muted)">Full 225-agent pipeline. Competitors, pain points, gaps, opportunities. 1-4 hours.</span>
            </div>
          </label>
          <label class="radio-card" style="flex:1;display:flex;align-items:flex-start;gap:10px;padding:12px;border:1px solid var(--border);border-radius:var(--radius);cursor:pointer">
            <input type="radio" name="mode" value="quick" style="margin-top:3px">
            <div>
              <strong style="display:block;margin-bottom:2px">Quick Scan</strong>
              <span style="font-size:12px;color:var(--fg-muted)">Source scraping only. Raw posts from selected sources. 2-5 minutes.</span>
            </div>
          </label>
        </div>
      </div>
      <div class="form-group">
        <label for="name">Scan Name</label>
        <input type="text" id="name" name="name" placeholder="e.g. Q1 PM Research">
        <div class="hint">Optional. A short label for this scan.</div>
      </div>
      <div class="form-group" id="sources-group">
        <label for="sources">Sources</label>
        <input type="text" id="sources" name="sources" placeholder="e.g. hackernews,reddit-api — leave blank for all">
        <div class="hint">Comma-separated source names, or leave blank to scan all sources.</div>
      </div>
      <div style="display:flex;gap:10px;align-items:center;margin-top:20px">
        <button type="submit" class="btn btn-primary">Start Scan</button>
        <a href="${basePath}/" class="btn btn-muted">Cancel</a>
      </div>
    </form>
    <script>
document.querySelectorAll('input[name="mode"]').forEach(function(r) {
  r.addEventListener('change', function() {
    var srcGroup = document.getElementById('sources-group');
    if (srcGroup) srcGroup.style.display = this.value === 'quick' ? '' : 'none';
  });
});
// Hide sources by default (deep scan is default)
var srcGroup = document.getElementById('sources-group');
if (srcGroup) srcGroup.style.display = 'none';
</script>
  </div>
</div>`;

  return renderLayout('New Scan', body, { user, basePath });
}

// ─── Scan Detail ──────────────────────────────────────────────────────────────

export function renderScanDetail(scan, progress, { user, basePath = '' } = {}) {
  const s = scan;
  const pct = progress?.pct ?? s.progress_pct ?? 0;
  const detail = progress?.detail ?? s.progress_detail ?? '';
  const isRunning = s.status === 'running';
  const isFailed = s.status === 'failed';
  const isCompleted = s.status === 'completed';

  const timestamps = `
    <div class="meta-row">
      <div class="meta-item">
        <span class="meta-label">Status</span>
        <span><span class="pill pill-${esc(s.status)}">${esc(s.status)}</span></span>
      </div>
      <div class="meta-item">
        <span class="meta-label">Created</span>
        <span class="meta-value">${fmtDate(s.created_at)}</span>
      </div>
${s.started_at ? `      <div class="meta-item">
        <span class="meta-label">Started</span>
        <span class="meta-value">${fmtDate(s.started_at)}</span>
      </div>` : ''}
${s.completed_at ? `      <div class="meta-item">
        <span class="meta-label">Completed</span>
        <span class="meta-value">${fmtDate(s.completed_at)}</span>
      </div>` : ''}
    </div>`;

  let progressSection = '';
  if (isRunning) {
    progressSection = `
    <div class="card section" style="margin-top:16px">
      <div class="progress-pct" id="scanPct">${Math.round(pct)}%</div>
      <div class="progress-lg">
        <div class="progress-track"><div class="progress-fill animated" id="scanBar" style="width:${pct}%"></div></div>
      </div>
      <div class="progress-text" id="scanDetail">${esc(detail)}</div>
    </div>`;
  }

  // Phase timeline for deep scans
  let phaseTimeline = '';
  if (isRunning && s.mode === 'full') {
    const defaultPhases = [
      { name: 'Planning', number: 1 },
      { name: 'Discovery', number: 2 },
      { name: 'Scanning', number: 3 },
      { name: 'Synthesis', number: 4 },
      { name: 'Reports', number: 5 },
    ];

    phaseTimeline = `
    <div class="phase-timeline" id="phaseTimeline">
      ${defaultPhases.map((p, i) => `
        <div class="phase-step" id="phase-${p.number}">
          <div class="phase-badge">${p.number}</div>
          <div class="phase-label">${esc(p.name)}</div>
          <div class="phase-time" id="phase-time-${p.number}"></div>
        </div>
        ${i < defaultPhases.length - 1 ? '<div class="phase-connector" id="conn-' + (i + 1) + '"></div>' : ''}
      `).join('')}
    </div>
    <div class="agent-stats" id="agentStats" style="display:none">
      <div><span class="agent-stat-value" id="agentActive">0</span> active</div>
      <div><span class="agent-stat-value" id="agentTotal">0</span> agents spawned</div>
    </div>`;
  }

  let errorSection = '';
  if (isFailed) {
    errorSection = `
    <div class="card alert-error" style="margin-top:16px;padding:16px">
      <strong>Scan failed</strong>
      <p style="margin-top:6px;font-size:13px">${esc(s.error || 'An unknown error occurred.')}</p>
    </div>`;
  }

  let reportBtn = '';
  if (isCompleted) {
    reportBtn = `
    <div style="margin-top:16px">
      <a href="${basePath}/api/reports/${esc(s.id)}/html" target="_blank" class="btn btn-primary">View Report</a>
    </div>`;
  }

  let chatSection = '';
  if (isCompleted) {
    chatSection = `
    <div class="section" style="margin-top:20px">
      <div class="chat-panel" id="chatPanel">
        <div class="chat-header">
          <span>Team Chat</span>
          <span id="chatStatus" style="font-size:11px"></span>
        </div>
        <div class="chat-messages" id="chatMessages">
          <div class="chat-empty" id="chatEmpty">
            Ask questions about this scan's results
            <div class="chat-suggestions">
              <span class="chat-suggestion" onclick="askSuggestion(this)">What are the top opportunities?</span>
              <span class="chat-suggestion" onclick="askSuggestion(this)">Summarize the key pain points</span>
              <span class="chat-suggestion" onclick="askSuggestion(this)">Which competitors are weakest?</span>
            </div>
          </div>
        </div>
        <div class="chat-input-area">
          <input type="text" id="chatInput" placeholder="Ask about this scan..." onkeydown="if(event.key==='Enter')sendChat()" />
          <button id="chatSend" onclick="sendChat()">Send</button>
        </div>
      </div>
    </div>`;
  }

  // Source results / artifacts
  const artifacts = s.artifacts || [];
  let artifactSection = '';
  if (artifacts.length) {
    const items = artifacts.map(a => {
      const name = esc(a.name || a.filename || a);
      const href = esc(a.url || `${basePath}/api/scans/${s.id}/artifacts/${a.filename || a}`);
      return `<li><a href="${href}" target="_blank">&#128196; ${name}</a></li>`;
    }).join('');
    artifactSection = `
    <div class="section" style="margin-top:24px">
      <div class="section-title">Source Results</div>
      <div class="card">
        <ul class="artifact-list">${items}</ul>
      </div>
    </div>`;
  }

  const pollScript = (isRunning || isCompleted || isFailed) ? `
(function() {
  var scanId = ${JSON.stringify(s.id)};
  var basePath = ${JSON.stringify(basePath)};
  var logBody = document.getElementById('logBody');
  var logEmpty = document.getElementById('logEmpty');
  var logCount = document.getElementById('logCount');
  var logLineCount = 0;
  var autoScroll = true;

  // Track if user has scrolled up (disable auto-scroll)
  if (logBody) {
    logBody.addEventListener('scroll', function() {
      var atBottom = logBody.scrollHeight - logBody.scrollTop - logBody.clientHeight < 40;
      autoScroll = atBottom;
    });
  }

  function addLogLines(lines) {
    if (!logBody || !lines.length) return;
    if (logEmpty) { logEmpty.style.display = 'none'; }

    var frag = document.createDocumentFragment();
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      var div = document.createElement('div');
      div.className = 'log-line';

      var ts = new Date(line.ts);
      var timeStr = ts.toLocaleTimeString();

      var textClass = 'log-text';
      var text = line.text || '';
      if (text.indexOf('[WARN') > -1 || text.indexOf('WARNING') > -1) textClass += ' warn';
      else if (text.indexOf('[ERR') > -1 || text.indexOf('CRITICAL') > -1 || text.indexOf('Error') > -1) textClass += ' err';
      else if (text.indexOf('complete') > -1 || text.indexOf('\\u2713') > -1 || text.indexOf('done') > -1 || text.indexOf('posts') > -1) textClass += ' ok';

      div.innerHTML = '<span class="log-ts">' + timeStr + '</span><span class="' + textClass + '">' + text.replace(/</g,'&lt;').replace(/>/g,'&gt;') + '</span>';
      frag.appendChild(div);
    }
    logBody.appendChild(frag);
    logLineCount += lines.length;
    if (logCount) logCount.textContent = '(' + logLineCount + ' lines)';

    if (autoScroll) {
      logBody.scrollTop = logBody.scrollHeight;
    }
  }

  ${isRunning ? `
  // Use SSE for real-time streaming
  var evtSource = new EventSource(basePath + '/api/scans/' + scanId + '/events');

  evtSource.addEventListener('progress', function(e) {
    try {
      var data = JSON.parse(e.data);
      var pctEl = document.getElementById('scanPct');
      var barEl = document.getElementById('scanBar');
      var detEl = document.getElementById('scanDetail');
      if (pctEl) pctEl.textContent = Math.round(data.pct || 0) + '%';
      if (barEl) barEl.style.width = (data.pct || 0) + '%';
      if (detEl) detEl.textContent = data.detail || '';

      // Update phase timeline if phases data available
      if (data.phases && data.phases.length > 0) {
        var statsEl = document.getElementById('agentStats');
        if (statsEl) statsEl.style.display = '';

        data.phases.forEach(function(p) {
          var num = 0;
          var nameLower = (p.name || '').toLowerCase();
          if (nameLower.includes('plan')) num = 1;
          else if (nameLower.includes('discover')) num = 2;
          else if (nameLower.includes('scan')) num = 3;
          else if (nameLower.includes('synthe')) num = 4;
          else if (nameLower.includes('report')) num = 5;

          if (num > 0) {
            var step = document.getElementById('phase-' + num);
            if (step) {
              if (p.status === 'completed') step.className = 'phase-step completed';
              else if (p.status === 'in_progress') step.className = 'phase-step active';
            }

            var timeEl = document.getElementById('phase-time-' + num);
            if (timeEl && p.duration) {
              timeEl.textContent = Math.round(p.duration / 1000) + 's';
            } else if (timeEl && p.status === 'in_progress' && p.startedAt) {
              var elapsed = Math.round((Date.now() - p.startedAt) / 1000);
              timeEl.textContent = elapsed + 's';
            }

            // Update connectors
            if (num > 1) {
              var conn = document.getElementById('conn-' + (num - 1));
              if (conn) {
                if (p.status === 'completed') conn.className = 'phase-connector done';
                else if (p.status === 'in_progress') conn.className = 'phase-connector active';
              }
            }
          }
        });
      }
    } catch(ex) {}
  });

  evtSource.addEventListener('logs', function(e) {
    try {
      var data = JSON.parse(e.data);
      addLogLines(data.lines || []);
    } catch(ex) {}
  });

  evtSource.addEventListener('done', function(e) {
    evtSource.close();
    setTimeout(function() { location.reload(); }, 1000);
  });

  evtSource.onerror = function() {
    // SSE reconnects automatically, but if scan ended, reload
    setTimeout(function() {
      fetch(basePath + '/api/scans/' + scanId)
        .then(function(r) { return r.json(); })
        .then(function(data) {
          if (data.status === 'completed' || data.status === 'failed') {
            location.reload();
          }
        })
        .catch(function() {});
    }, 3000);
  };
  ` : `
  // Completed/failed scan — load existing logs
  fetch(basePath + '/api/scans/' + scanId + '/logs')
    .then(function(r) { return r.json(); })
    .then(function(data) { addLogLines(data.lines || []); })
    .catch(function() {});
  `}
})();
` : '';

  const chatScript = isCompleted ? `
(function() {
  var scanId = ${JSON.stringify(s.id)};
  var basePath = ${JSON.stringify(basePath)};
  var chatMessages = document.getElementById('chatMessages');
  var chatInput = document.getElementById('chatInput');
  var chatSend = document.getElementById('chatSend');
  var chatEmpty = document.getElementById('chatEmpty');
  var chatStatus = document.getElementById('chatStatus');
  var sending = false;

  function escHtml(s) {
    var d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
  }

  function addMessage(role, content, username) {
    if (chatEmpty) chatEmpty.style.display = 'none';
    var div = document.createElement('div');
    div.className = 'chat-msg ' + role;
    var header = role === 'user' ? (username || 'You') : 'GapScout';
    div.innerHTML = '<div class="chat-msg-header">' + escHtml(header) + '</div><div class="chat-msg-body">' + escHtml(content) + '</div>';
    chatMessages.appendChild(div);
    chatMessages.scrollTop = chatMessages.scrollHeight;
    return div;
  }

  function addStreamingMessage() {
    if (chatEmpty) chatEmpty.style.display = 'none';
    var div = document.createElement('div');
    div.className = 'chat-msg assistant';
    div.innerHTML = '<div class="chat-msg-header">GapScout</div><div class="chat-msg-body streaming" id="streamingBody"></div>';
    chatMessages.appendChild(div);
    chatMessages.scrollTop = chatMessages.scrollHeight;
    return document.getElementById('streamingBody');
  }

  // Load existing messages
  fetch(basePath + '/api/scans/' + scanId + '/chat')
    .then(function(r) { return r.json(); })
    .then(function(data) {
      if (data.messages && data.messages.length > 0) {
        if (chatEmpty) chatEmpty.style.display = 'none';
        data.messages.forEach(function(m) {
          addMessage(m.role, m.content, m.username);
        });
      }
    })
    .catch(function() {});

  window.askSuggestion = function(el) {
    chatInput.value = el.textContent;
    sendChat();
  };

  window.sendChat = function() {
    var msg = chatInput.value.trim();
    if (!msg || sending) return;

    sending = true;
    chatSend.disabled = true;
    chatInput.value = '';
    chatStatus.textContent = 'Thinking...';

    addMessage('user', msg);
    var streamBody = addStreamingMessage();

    var controller = new AbortController();
    var timeoutId = setTimeout(function() { controller.abort(); }, 130000);

    fetch(basePath + '/api/scans/' + scanId + '/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: msg }),
      signal: controller.signal
    }).then(function(r) { return r.json(); })
    .then(function(data) {
      clearTimeout(timeoutId);
      if (streamBody) {
        streamBody.textContent = data.content || data.error || 'No response.';
        streamBody.classList.remove('streaming');
      }
      sending = false;
      chatSend.disabled = false;
      chatStatus.textContent = '';
      chatMessages.scrollTop = chatMessages.scrollHeight;
    }).catch(function(err) {
      clearTimeout(timeoutId);
      var errMsg = err.name === 'AbortError'
        ? 'Response timed out. Please try again.'
        : 'Failed to send message. Try again.';
      if (streamBody) {
        streamBody.textContent = errMsg;
        streamBody.classList.remove('streaming');
      }
      sending = false;
      chatSend.disabled = false;
      chatStatus.textContent = '';
    });
  };
})();
` : '';

  const body = `
<div class="container">
  <a href="${basePath}/" class="back-link">&larr; Dashboard</a>
  <div class="page-header">
    <h1>${esc(s.name || s.domain)}</h1>
    <p class="subtitle">${esc(s.domain)}</p>
  </div>
  ${timestamps}
  ${progressSection}
  ${phaseTimeline}
  ${errorSection}
  ${reportBtn}
  ${chatSection}
  ${artifactSection}
  <div class="section" style="margin-top:24px">
    <div class="log-panel">
      <div class="log-header">
        <span>Live Output <span class="log-count" id="logCount">(0 lines)</span></span>
        <div>
          <button onclick="document.getElementById('logBody').scrollTop=document.getElementById('logBody').scrollHeight" title="Scroll to bottom">&#8595; Bottom</button>
          <button onclick="document.getElementById('logBody').innerHTML='';logLineCount=0;document.getElementById('logCount').textContent='(0 lines)'" title="Clear">Clear</button>
        </div>
      </div>
      <div class="log-body" id="logBody">
        <div class="log-empty" id="logEmpty">Waiting for output...</div>
      </div>
    </div>
  </div>
</div>`;

  return renderLayout(s.name || s.domain, body, { user, scripts: pollScript + chatScript, basePath });
}

// ─── Settings ─────────────────────────────────────────────────────────────────

export function renderSettings(users, currentUser, { message, error, basePath = '' } = {}) {
  const userRows = (users || []).map(u => `
    <tr>
      <td>${esc(u.username)}</td>
      <td>${fmtDate(u.created_at)}</td>
    </tr>`).join('');

  const body = `
<div class="container" style="max-width:640px">
  <a href="${basePath}/" class="back-link">&larr; Dashboard</a>
  <div class="page-header">
    <h1>Settings</h1>
  </div>

${message ? `  <div class="alert alert-success">${esc(message)}</div>` : ''}
${error ? `  <div class="alert alert-error">${esc(error)}</div>` : ''}

  <div class="section">
    <div class="section-title">Team Members</div>
    <div class="table-wrap">
      <table>
        <thead>
          <tr><th>Username</th><th>Created</th></tr>
        </thead>
        <tbody>${userRows}</tbody>
      </table>
    </div>
  </div>

  <div class="section">
    <div class="section-title">Invite Teammate</div>
    <div class="card">
      <form method="POST" action="${basePath}/settings/users">
        <div class="form-group">
          <label for="new-username">Username</label>
          <input type="text" id="new-username" name="username" required autocomplete="off">
        </div>
        <div class="form-group">
          <label for="new-password">Password</label>
          <input type="password" id="new-password" name="password" required autocomplete="new-password">
        </div>
        <button type="submit" class="btn btn-primary">Create Account</button>
      </form>
    </div>
  </div>

  <div class="section">
    <div class="section-title">Change Password</div>
    <div class="card">
      <form method="POST" action="${basePath}/settings/password">
        <div class="form-group">
          <label for="current-password">Current Password</label>
          <input type="password" id="current-password" name="current_password" required autocomplete="current-password">
        </div>
        <div class="form-group">
          <label for="new-pw">New Password</label>
          <input type="password" id="new-pw" name="new_password" required autocomplete="new-password">
        </div>
        <button type="submit" class="btn btn-primary">Update Password</button>
      </form>
    </div>
  </div>
</div>`;

  return renderLayout('Settings', body, { user: currentUser, basePath });
}
