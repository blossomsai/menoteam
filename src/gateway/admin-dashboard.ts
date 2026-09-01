export function renderAgentAdminShell(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Agent connections · Menoteam</title>
  <link rel="stylesheet" href="/agents/styles.css">
</head>
<body>
  <a class="skip-link" href="#main-content">Skip to content</a>
  <header class="app-header"><div class="header-inner"><div><strong>Menoteam · Agent connections</strong><span>Approve only devices you recognize.</span></div><button class="secondary" type="button" data-logout hidden>Lock</button></div></header>
  <main id="main-content" class="workspace"><div id="agent-admin-root"><p class="loading" role="status">Loading connection status…</p></div></main>
  <script src="/agents/client.js" defer></script>
</body>
</html>`;
}

export const agentAdminCss = String.raw`
:root { color-scheme: light; --green: oklch(.400 .087 160); --green-soft: oklch(.955 .020 160); --ink: oklch(.205 .018 250); --muted: oklch(.430 .018 250); --canvas: oklch(.990 .003 250); --surface: oklch(1 0 0); --line: oklch(.855 .010 250); --danger: oklch(.470 .175 25); --focus: oklch(.400 .087 160 / .28); font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: var(--ink); background: var(--canvas); }
* { box-sizing: border-box; }
body { margin: 0; min-width: 320px; }
button, input { font: inherit; min-height: 44px; }
button { cursor: pointer; }
button:focus-visible, input:focus-visible { outline: 2px solid var(--green); outline-offset: 2px; box-shadow: 0 0 0 4px var(--focus); }
.skip-link { position: fixed; left: 12px; top: 8px; transform: translateY(-150%); background: var(--ink); color: white; padding: 8px 12px; border-radius: 6px; z-index: 2; }
.skip-link:focus { transform: translateY(0); }
.sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }
.app-header { background: var(--surface); border-bottom: 1px solid var(--line); }
.header-inner { max-width: 1120px; margin: 0 auto; padding: 18px 28px; display: flex; align-items: center; justify-content: space-between; gap: 20px; }
.header-inner strong { display: block; font-size: 1.08rem; letter-spacing: -.02em; }
.header-inner span { display: block; color: var(--muted); font-size: .84rem; margin-top: 3px; }
.workspace { max-width: 1120px; margin: 0 auto; padding: 32px 28px 64px; }
.auth-panel { width: min(460px, 100%); margin: 8vh auto 0; border-top: 3px solid var(--green); padding-top: 20px; }
h1, h2 { letter-spacing: -.02em; text-wrap: balance; }
h1 { font-size: 1.65rem; margin: 0 0 8px; }
h2 { font-size: 1rem; margin: 0; }
p { line-height: 1.55; }
.muted, .loading, .metadata { color: var(--muted); }
form { display: grid; gap: 12px; margin-top: 22px; }
label { display: grid; gap: 6px; color: var(--muted); font: 600 .74rem/1.2 ui-monospace, SFMono-Regular, Menlo, monospace; }
input { width: 100%; border: 1px solid var(--line); background: var(--surface); color: var(--ink); border-radius: 6px; padding: 10px 12px; }
.primary, .secondary, .danger { border-radius: 6px; padding: 9px 14px; font-weight: 650; }
.primary { width: fit-content; border: 1px solid var(--green); background: var(--green); color: white; }
.primary:hover { background: oklch(.34 .087 160); }
.secondary { border: 1px solid var(--line); background: var(--surface); color: var(--ink); }
.secondary:hover { background: var(--green-soft); }
.danger { border: 1px solid color-mix(in oklch, var(--danger) 55%, var(--line)); background: var(--surface); color: var(--danger); }
.error { color: var(--danger); }
.section { margin-top: 36px; }
.section-heading { display: flex; align-items: baseline; justify-content: space-between; gap: 16px; border-bottom: 1px solid var(--line); padding-bottom: 10px; }
.section-heading span { color: var(--muted); font-size: .82rem; }
.empty { border: 1px solid var(--line); border-radius: 10px; background: var(--surface); padding: 24px; margin-top: 16px; }
.empty strong { display: block; margin-bottom: 6px; }
.copy-prompt { display: flex; gap: 8px; margin-top: 14px; }
.copy-prompt code { flex: 1; min-width: 0; overflow-wrap: anywhere; background: var(--canvas); border: 1px solid var(--line); border-radius: 6px; padding: 10px 12px; font: .78rem/1.4 ui-monospace, SFMono-Regular, Menlo, monospace; }
.request-list { list-style: none; margin: 0; padding: 0; }
.request { display: grid; grid-template-columns: 150px minmax(180px, 1fr) auto; gap: 18px; align-items: center; padding: 16px 0; border-bottom: 1px solid var(--line); }
.code { font: 700 .9rem/1.2 ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing: .035em; }
.label { font-weight: 650; }
.actions { display: flex; gap: 8px; flex-wrap: wrap; justify-content: end; }
.table-wrap { overflow-x: auto; border: 1px solid var(--line); border-radius: 10px; background: var(--surface); margin-top: 16px; }
table { width: 100%; border-collapse: collapse; min-width: 660px; }
th, td { padding: 12px 14px; text-align: left; border-bottom: 1px solid var(--line); }
th { color: var(--muted); font: 600 .72rem/1.2 ui-monospace, SFMono-Regular, Menlo, monospace; }
tr:last-child td { border-bottom: 0; }
.status { display: inline-flex; align-items: center; gap: 7px; }
.status::before { content: ""; width: 8px; height: 8px; border-radius: 50%; background: var(--muted); }
.status[data-status="online"] { color: var(--green); }
.status[data-status="online"]::before { background: var(--green); }
@media (max-width: 700px) { .header-inner, .workspace { padding-left: 18px; padding-right: 18px; } .request { grid-template-columns: 1fr; gap: 8px; } .actions { justify-content: start; } .copy-prompt { display: grid; } }
@media (prefers-reduced-motion: reduce) { *, *::before, *::after { scroll-behavior: auto !important; transition-duration: .01ms !important; } }
`;

export const agentAdminClient = String.raw`
(() => {
  const root = document.querySelector('#agent-admin-root');
  const logout = document.querySelector('[data-logout]');
  let authenticated = false;
  let refreshTimer;

  const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
  const request = async (url, options = {}) => {
    const response = await fetch(url, { credentials: 'same-origin', headers: { accept: 'application/json', ...(options.body ? { 'content-type': 'application/json' } : {}) }, ...options });
    if (response.status === 401) throw Object.assign(new Error('Unauthorized'), { unauthorized: true });
    if (!response.ok) throw new Error((await response.json().catch(() => null))?.message || 'Request failed');
    return response.status === 204 ? null : response.json();
  };
  const formatTime = (value) => value ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)) : 'Not seen since Gateway started';
  const connectPrompt = () => 'Connect this repository to Menoteam at ' + location.origin;

  function renderLogin(message = '') {
    authenticated = false;
    logout.hidden = true;
    clearTimeout(refreshTimer);
    root.innerHTML = '<section class="auth-panel" aria-labelledby="unlock-title"><h1 id="unlock-title">Unlock agent connections</h1><p class="muted">Use the separate Gateway admin password. It is exchanged for a signed HttpOnly session and is never stored by this page.</p><form data-login><label>Admin password<input name="password" type="password" autocomplete="current-password" required></label><button class="primary" type="submit">Unlock</button></form>' + (message ? '<p class="error" role="alert">' + escapeHtml(message) + '</p>' : '') + '</section>';
    root.querySelector('[data-login]').addEventListener('submit', async (event) => {
      event.preventDefault();
      const form = new FormData(event.currentTarget);
      try {
        await request('/api/agent-admin/session', { method: 'POST', body: JSON.stringify({ password: form.get('password') }) });
        authenticated = true;
        await refresh();
      } catch (error) { renderLogin(error.message); }
    });
  }

  function renderSnapshot(snapshot) {
    authenticated = true;
    logout.hidden = false;
    const pending = snapshot.pairings.filter((pairing) => pairing.status === 'pending');
    const requests = pending.length ? '<ul class="request-list">' + pending.map((pairing) => '<li class="request"><div><div class="code">' + escapeHtml(pairing.user_code) + '</div><div class="metadata">Expires ' + escapeHtml(formatTime(pairing.expires_at)) + '</div></div><div><div class="label">' + escapeHtml(pairing.label) + '</div><div class="metadata">' + escapeHtml(pairing.harness) + ' · confirm the code with your teammate</div></div><div class="actions"><button class="primary" type="button" data-approve="' + escapeHtml(pairing.id) + '">Approve</button><button class="secondary" type="button" data-reject="' + escapeHtml(pairing.id) + '">Reject</button></div></li>').join('') + '</ul>' : '<div class="empty"><strong>No connection requests</strong><span class="muted">On the teammate’s Codex, send this instruction from the repository you want to share:</span><div class="copy-prompt"><code>' + escapeHtml(connectPrompt()) + '</code><button class="secondary" type="button" data-copy>Copy</button></div></div>';
    const managed = new Set(snapshot.managed_endpoint_ids);
    const rows = snapshot.endpoints.map((endpoint) => '<tr><td><strong>' + escapeHtml(endpoint.label) + '</strong><div class="metadata">' + escapeHtml(endpoint.id) + '</div></td><td>' + escapeHtml(endpoint.harness) + '</td><td><span class="status" data-status="' + escapeHtml(endpoint.status) + '">' + escapeHtml(endpoint.status === 'online' ? 'Online' : 'Offline') + '</span></td><td>' + escapeHtml(formatTime(endpoint.lastSeenAt)) + '</td><td><button class="danger" type="button" data-revoke="' + escapeHtml(endpoint.id) + '"' + (!managed.has(endpoint.id) ? ' disabled title="Legacy endpoints are managed by the Gateway operator"' : '') + '>Revoke</button></td></tr>').join('');
    root.innerHTML = '<section aria-labelledby="requests-title"><div class="section-heading"><h1 id="requests-title">Connection requests</h1><span>' + pending.length + ' waiting</span></div>' + requests + '</section><section class="section" aria-labelledby="endpoints-title"><div class="section-heading"><h2 id="endpoints-title">Connected agents</h2><span>Current Gateway presence</span></div>' + (rows ? '<div class="table-wrap"><table><thead><tr><th>Agent</th><th>Harness</th><th>Status</th><th>Last seen</th><th><span class="sr-only">Actions</span></th></tr></thead><tbody>' + rows + '</tbody></table></div>' : '<div class="empty"><strong>No connected agents</strong></div>') + '</section>';
    root.querySelector('[data-copy]')?.addEventListener('click', async (event) => { await navigator.clipboard.writeText(connectPrompt()); event.currentTarget.textContent = 'Copied'; });
    root.querySelectorAll('[data-approve]').forEach((button) => button.addEventListener('click', () => mutate('/api/agent-admin/pairings/' + encodeURIComponent(button.dataset.approve) + '/approve', 'POST')));
    root.querySelectorAll('[data-reject]').forEach((button) => button.addEventListener('click', () => mutate('/api/agent-admin/pairings/' + encodeURIComponent(button.dataset.reject) + '/reject', 'POST')));
    root.querySelectorAll('[data-revoke]').forEach((button) => button.addEventListener('click', () => { if (confirm('Revoke this agent immediately? It will stop receiving new work.')) mutate('/api/agent-admin/endpoints/' + encodeURIComponent(button.dataset.revoke), 'DELETE'); }));
  }

  async function mutate(url, method) {
    try { await request(url, { method }); await refresh(); } catch (error) { alert(error.message); }
  }
  async function refresh() {
    try {
      const snapshot = await request('/api/agent-admin/snapshot');
      renderSnapshot(snapshot);
      clearTimeout(refreshTimer);
      if (!document.hidden) refreshTimer = setTimeout(refresh, 3000);
    } catch (error) { if (error.unauthorized) renderLogin(); else root.innerHTML = '<p class="error" role="alert">' + escapeHtml(error.message) + '</p>'; }
  }
  logout.addEventListener('click', async () => { await request('/api/agent-admin/session/logout', { method: 'POST' }).catch(() => null); renderLogin(); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden && authenticated) refresh(); });
  refresh();
})();
`;
