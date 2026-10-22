const demo = document.body.dataset.mode === 'demo',
  key = 'mayoauth.demo.v1';
const h = (value) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
const $ = (s) => document.querySelector(s);
let state,
  tab = 'overview',
  editing,
  toastTimer;
const id = () => crypto.randomUUID();
const now = () => new Date().toISOString();
function seed() {
  return {
    users: [
      {
        id: 'sample-alex',
        name: 'Alex Morgan',
        email: 'alex@example.test',
        active: true,
        admin: true,
      },
      {
        id: 'sample-sam',
        name: 'Sam Rivera',
        email: 'sam@example.test',
        active: true,
        admin: false,
      },
      {
        id: 'sample-jordan',
        name: 'Jordan Lee',
        email: 'jordan@example.test',
        active: true,
        admin: false,
      },
    ],
    apps: [
      {
        client_id: 'sample_app_portal',
        client_name: 'Team portal',
        redirect_uris: ['https://portal.example.test/callback'],
      },
      {
        client_id: 'sample_app_docs',
        client_name: 'Internal docs',
        redirect_uris: ['https://docs.example.test/callback'],
      },
    ],
    connectors: [
      {
        id: 'sample_oidc',
        name: 'Example company IdP',
        issuer: 'https://identity.example.test',
        client_id: 'sample-client',
        active: true,
      },
    ],
    events: [
      {
        seq: 3,
        at: now(),
        actor: 'alex@example.test',
        action: 'sample.workspace_opened',
        target: 'Browser demo',
        outcome: 'success',
      },
      {
        seq: 2,
        at: now(),
        actor: 'operator',
        action: 'sample.client_created',
        target: 'Team portal',
        outcome: 'success',
      },
      {
        seq: 1,
        at: now(),
        actor: 'operator',
        action: 'sample.user_created',
        target: 'alex@example.test',
        outcome: 'success',
      },
    ],
  };
}
function loadDemo() {
  try {
    const raw = localStorage.getItem(key);
    if (raw && raw.length < 150000) {
      const candidate = JSON.parse(raw);
      if (
        ['users', 'apps', 'connectors', 'events'].every((x) => Array.isArray(candidate[x])) &&
        candidate.users.length <= 20 &&
        candidate.apps.length <= 10 &&
        candidate.connectors.length <= 10 &&
        candidate.events.length <= 200
      )
        return candidate;
    }
  } catch {}
  return seed();
}
function persist() {
  try {
    localStorage.setItem(key, JSON.stringify(state));
  } catch {
    toast('Browser storage is unavailable. Changes last for this page only.');
  }
}
function record(action, target) {
  state.events.unshift({
    seq: (state.events[0]?.seq || 0) + 1,
    at: now(),
    actor: 'sample operator',
    action: `sample.${action}`,
    target,
    outcome: 'success',
  });
  state.events = state.events.slice(0, 200);
  persist();
}
function toast(message) {
  clearTimeout(toastTimer);
  $('#toast').textContent = message;
  $('#toast').classList.add('visible');
  toastTimer = setTimeout(() => $('#toast').classList.remove('visible'), 4500);
}
async function api(path, method = 'GET', body) {
  const response = await fetch(`/api/v1/${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (response.status === 401) {
    location.assign('/login');
    throw new Error('Session expired. Sign in again.');
  }
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'The request failed.');
  return result;
}
async function refresh() {
  if (demo) {
    state = state || loadDemo();
    persist();
  } else {
    const [users, apps, connectors, events, status] = await Promise.all([
      api('users'),
      api('clients'),
      api('connectors'),
      api('events'),
      api('status'),
    ]);
    state = { users, apps, connectors, events, status };
  }
}
const status = (active) =>
  `<span class="status ${active ? '' : 'inactive'}">${active ? 'Active' : 'Suspended'}</span>`;
function heading(title, description, action) {
  return `<div class="view-heading"><div><div class="eyebrow">${demo ? 'SAMPLE WORKSPACE' : 'COMMUNITY INSTANCE'}</div><h1>${title}</h1><p>${description}</p></div>${action ? `<button class="button primary small" data-action="add" data-kind="${action.kind}" ${action.disabled ? 'disabled' : ''}>${action.label} +</button>` : ''}</div>`;
}
const eventLabel = (event) =>
  event.action
    .replace(/^sample\./, '')
    .replaceAll('.', ' / ')
    .replaceAll('_', ' ');
const date = (value) =>
  new Date(value).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
function timeline(events) {
  return events.length
    ? `<div class="timeline">${events.map((e) => `<div class="timeline-item"><span class="timeline-icon ${e.outcome === 'denied' ? 'denied' : ''}">${e.outcome === 'denied' ? '!' : '✓'}</span><div><strong>${h(eventLabel(e))}</strong><small>${h(e.target)}</small></div><time>${h(date(e.at))}</time></div>`).join('')}</div>`
    : '<div class="empty">Your audit events will appear here.</div>';
}
function overview() {
  const storage = state.status?.storage,
    active = state.users.filter((u) => u.active).length;
  return (
    heading(
      'Identity, under your control.',
      demo
        ? 'A browser-only sample of this open-source OIDC workspace. No signup, and the data stays in this browser.'
        : 'A clear view of your people, applications, and audit trail.',
    ) +
    `<div class="metric-grid"><article class="metric"><div class="metric-label">People</div><div class="metric-value">${state.users.length} <small>${demo ? '/ 20' : ''}</small></div><div class="metric-foot">${demo ? 'Sample user limit' : 'No license cap'}</div></article><article class="metric"><div class="metric-label">Active accounts</div><div class="metric-value">${active}</div><div class="metric-foot">${state.users.length - active} suspended</div></article><article class="metric"><div class="metric-label">OIDC applications</div><div class="metric-value">${state.apps.length}</div><div class="metric-foot">${demo ? 'Illustrative configurations' : 'Registered clients'}</div></article><article class="metric"><div class="metric-label">Audit events</div><div class="metric-value">${state.events.length}</div><div class="metric-foot">${demo ? 'Sample activity' : 'Most recent 200 shown'}</div></article></div><div class="console-grid"><section class="panel"><div class="panel-header"><h2>Recent activity</h2><a href="#logs">View audit log →</a></div>${timeline(state.events.slice(0, 5))}</section><section class="panel"><div class="panel-header"><h2>Instance at a glance</h2><span>${demo ? 'DEMO' : 'LIVE INSTANCE'}</span></div><div class="config-list"><div class="config-row"><span>Edition</span><strong>Community beta</strong></div><div class="config-row"><span>Issuer</span><strong>${demo ? 'Browser simulation' : h(state.status.issuer)}</strong></div><div class="config-row"><span>Connectors</span><strong>${state.connectors.length} ${demo ? 'sample' : 'configured'}</strong></div><div class="config-row"><span>Managed Cloud</span><strong>Planned</strong></div></div><div class="storage-card"><strong>${demo ? 'Local to this browser' : 'Bounded database storage'}</strong>${demo ? 'Sample data only. No server database, identity tokens, or external provider connections.' : `${(storage.databaseBytes / 1048576).toFixed(2)} MiB / ${(storage.databaseLimitBytes / 1048576).toFixed(0)} MiB · ${storage.cacheLimitKiB / 1024} MiB page cache<br>${storage.auditRows} / ${storage.auditRowLimit} audit rows · ${storage.auditRetentionDays}-day retention`}</div></section></div><div class="welcome-line"><span>↗</span><p><strong>${demo ? 'Ready to go beyond the demo?' : 'Your operator toolkit is included.'}</strong><br>${demo ? 'Run a real issuer, connect an application, and manage it all from the CLI.' : 'Use the CLI to inspect your issuer, add users, and export audit history.'}</p><a href="/docs#quickstart">${demo ? 'Self-host MayoAuth' : 'Open the docs'} →</a></div>`
  );
}
function usersView() {
  return (
    heading('Your people.', 'Add accounts, manage access, and keep the directory understandable.', {
      kind: 'users',
      label: 'Add person',
      disabled: demo && state.users.length >= 20,
    }) +
    `<div class="table-toolbar"><input id="search" type="search" aria-label="Search people" placeholder="Search name or email…"><span class="table-count">${state.users.length} ${demo ? '/ 20 sample users' : 'people'}</span></div><div class="table-scroll"><table class="data-table"><thead><tr><th>PERSON</th><th>ROLE</th><th>STATUS</th><th>ACCESS</th></tr></thead><tbody>${state.users
      .map(
        (u) =>
          `<tr data-search="${h(`${u.name} ${u.email}`.toLowerCase())}"><td><div class="person-cell"><span class="avatar">${h(
            u.name
              .split(' ')
              .map((w) => w[0])
              .slice(0, 2)
              .join(''),
          )}</span><div><strong>${h(u.name)}</strong><small>${h(u.email)}</small></div></div></td><td>${u.admin ? 'Administrator' : 'Member'}</td><td>${status(u.active)}</td><td><button class="table-action" data-action="toggle-user" data-id="${h(u.id)}">${u.active ? 'Suspend' : 'Enable'}</button></td></tr>`,
      )
      .join(
        '',
      )}</tbody></table></div>${demo && state.users.length >= 20 ? '<p class="info-strip">You reached the 20-user sample limit. Reset the workspace to start again. Self-hosted Community has no license cap.</p>' : ''}`
  );
}
function appsView() {
  return (
    heading(
      'Applications, connected.',
      'OIDC clients with exact redirect URIs. PKCE S256 is required on real instances.',
      { kind: 'apps', label: 'Add application', disabled: demo && state.apps.length >= 10 },
    ) +
    `<div class="table-scroll"><table class="data-table"><thead><tr><th>APPLICATION</th><th>CLIENT ID</th><th>REDIRECT URI</th><th>ACTION</th></tr></thead><tbody>${state.apps.map((a) => `<tr><td>${h(a.client_name)}</td><td class="mono">${h(a.client_id)}</td><td class="mono">${h(a.redirect_uris[0])}</td><td><button class="table-action" data-action="remove-app" data-id="${h(a.client_id)}">Remove</button></td></tr>`).join('')}</tbody></table>${!state.apps.length ? '<div class="empty">Register your first application to get started.</div>' : ''}</div><p class="info-strip">${demo ? 'These clients are sample configurations. They cannot issue tokens.' : 'Discovery: ' + h(state.status.issuer) + '/.well-known/openid-configuration'} <a href="/docs#oidc">OIDC setup guide →</a></p>`
  );
}
function connectorsView() {
  return (
    heading(
      'Bring your identity provider.',
      'Generic upstream OIDC. Explicit account links, no automatic email matching.',
      {
        kind: 'connectors',
        label: 'Add connector',
        disabled: demo && state.connectors.length >= 10,
      },
    ) +
    `<div class="connector-grid">${state.connectors.map((c) => `<article class="connector-card"><span class="pill">${demo ? 'SAMPLE / ' : ''}OIDC</span><h2>${h(c.name)}</h2><p>${h(c.issuer)}</p><p>Client: ${h(c.client_id)}</p><div class="connector-bottom"><span>${c.active ? 'Enabled' : 'Disabled'}</span><button class="table-action" data-action="toggle-connector" data-id="${h(c.id)}">${c.active ? 'Disable' : 'Enable'}</button></div></article>`).join('')}</div>${!state.connectors.length ? '<div class="panel empty">No upstream providers configured yet.</div>' : ''}<p class="info-strip">${demo ? 'The demo never contacts a provider or stores connector secrets.' : 'Callback: ' + h(state.status.issuer) + '/connectors/callback'}<br>Use <code>mayoauth connectors link</code> to map a provider subject to an existing local user. <a href="/docs#oidc">Read the connector guide →</a></p>`
  );
}
function logsView() {
  return (
    heading(
      'A trail you can follow.',
      'Sign-ins and administration events, ready to inspect and export.',
    ) +
    `<div class="table-toolbar"><span class="table-count">${state.events.length} ${demo ? 'sample' : 'recent'} events</span><button class="button secondary small" data-action="export">Export JSON ↓</button></div><div class="table-scroll"><table class="data-table"><thead><tr><th>TIME</th><th>EVENT</th><th>ACTOR</th><th>TARGET</th><th>OUTCOME</th></tr></thead><tbody>${state.events.map((e) => `<tr><td>${h(date(e.at))}</td><td>${h(eventLabel(e))}</td><td class="mono">${h(e.actor)}</td><td>${h(e.target)}</td><td><span class="status ${e.outcome === 'denied' ? 'inactive' : ''}">${h(e.outcome)}</span></td></tr>`).join('')}</tbody></table>${!state.events.length ? '<div class="empty">No events yet.</div>' : ''}</div><p class="info-strip">${demo ? 'All events in this workspace are sample interactions.' : 'Audit history is bounded to 10,000 events and 30 days. Exports include retained events, up to 10,000.'}</p>`
  );
}
function cliView() {
  return (
    heading(
      'Your terminal is a first-class client.',
      'Install from the repository. Use the same API that powers the console.',
    ) +
    `<div class="console-cli"><pre>git clone https://github.com/securelyprogramming/MayoAuth.git
cd MayoAuth
npm ci
npm link</pre><p>Initialize a real instance with <code>mayoauth init</code> before using these commands. This browser demo has no server endpoint for the CLI.</p><pre>mayoauth status
mayoauth users list
mayoauth apps list
mayoauth connectors list
mayoauth logs --export
mayoauth doctor</pre><p>Remote operations use <code>MAYOAUTH_URL</code> and a private <code>MAYOAUTH_TOKEN</code>. Keep credentials out of scripts, shell history, and source control.</p><a class="button primary" href="/docs#cli">Full CLI & setup reference ↗</a></div>`
  );
}
function render() {
  tab = location.hash.slice(1) || 'overview';
  if (!['overview', 'users', 'apps', 'connectors', 'logs', 'cli'].includes(tab)) tab = 'overview';
  document.querySelectorAll('[data-tab]').forEach((a) => {
    a.classList.toggle('active', a.dataset.tab === tab);
    if (a.dataset.tab === tab) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });
  $('#breadcrumb').textContent = {
    overview: 'Overview',
    users: 'People',
    apps: 'Applications',
    connectors: 'OIDC connectors',
    logs: 'Audit log',
    cli: 'CLI & setup',
  }[tab];
  $('#view').innerHTML = {
    overview,
    users: usersView,
    apps: appsView,
    connectors: connectorsView,
    logs: logsView,
    cli: cliView,
  }[tab]();
  $('#search')?.addEventListener('input', (event) => {
    document
      .querySelectorAll('[data-search]')
      .forEach(
        (row) => (row.hidden = !row.dataset.search.includes(event.target.value.toLowerCase())),
      );
  });
}
function openEditor(kind) {
  if (
    demo &&
    ((kind === 'users' && state.users.length >= 20) ||
      (kind !== 'users' && state[kind].length >= 10))
  )
    throw new Error('Sample workspace limit reached.');
  editing = kind;
  $('#form-error').textContent = '';
  const field = (label, name, type = 'text', placeholder = '', extra = '') =>
    `<label>${label}<input name="${name}" type="${type}" placeholder="${placeholder}" required maxlength="${type === 'password' ? 4096 : 255}" ${extra}></label>`;
  $('#editor-title').textContent = {
    users: 'Add a person',
    apps: 'Add an application',
    connectors: 'Add an OIDC connector',
  }[kind];
  $('#editor-fields').innerHTML =
    kind === 'users'
      ? field('Name', 'name', 'text', 'Taylor Chen') +
        field(
          demo ? 'Sample email (@example.test)' : 'Email',
          'email',
          'email',
          'taylor@example.test',
        ) +
        (demo
          ? '<small>Sample data only. No real account, password, or email will be created.</small>'
          : field(
              'Initial password (12+ characters)',
              'password',
              'password',
              '',
              'autocomplete="new-password" minlength="12" maxlength="256"',
            ))
      : kind === 'apps'
        ? field('Application name', 'name', 'text', 'Team portal') +
          field('Exact redirect URI', 'uri', 'url', 'http://localhost:3000/callback') +
          '<small>HTTPS required, except loopback HTTP during local development.</small>'
        : field('Provider name', 'name', 'text', 'Company IdP') +
          field('OIDC issuer', 'issuer', 'url', 'https://identity.example.test') +
          field('Client ID', 'clientId', 'text', 'application-client-id') +
          (demo
            ? '<small>No provider connections or secrets in the browser demo.</small>'
            : field('Client secret', 'clientSecret', 'password', '', 'autocomplete="off"'));
  $('#editor-form').reset();
  $('#editor').showModal();
}
$('#editor-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget,
    button = form.querySelector('[type=submit]');
  button.disabled = true;
  $('#form-error').textContent = '';
  try {
    const data = Object.fromEntries(new FormData(form));
    if (editing === 'users') {
      if (demo) {
        if (state.users.length >= 20) throw new Error('The demo supports up to 20 sample users.');
        if (!/^[^\s@]+@example\.test$/i.test(data.email))
          throw new Error('Use a sample address ending in @example.test.');
        if (state.users.some((u) => u.email.toLowerCase() === data.email.toLowerCase()))
          throw new Error('That sample email already exists.');
        state.users.push({
          id: id(),
          name: data.name,
          email: data.email.toLowerCase(),
          active: true,
          admin: false,
        });
        record('user_created', data.email);
      } else await api('users', 'POST', data);
    } else if (editing === 'apps') {
      const uri = new URL(data.uri);
      if (
        uri.hash ||
        uri.username ||
        uri.password ||
        (uri.protocol !== 'https:' &&
          !(uri.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(uri.hostname)))
      )
        throw new Error('Use HTTPS or loopback HTTP without a fragment or credentials.');
      if (demo) {
        if (state.apps.length >= 10) throw new Error('Sample application limit reached.');
        state.apps.push({
          client_id: `sample_${id()}`,
          client_name: data.name,
          redirect_uris: [data.uri],
        });
        record('client_created', data.name);
      } else await api('clients', 'POST', { name: data.name, redirectUris: [data.uri] });
    } else {
      const uri = new URL(data.issuer);
      if (uri.protocol !== 'https:' || uri.username || uri.password || uri.hash)
        throw new Error('Use an HTTPS issuer without credentials or a fragment.');
      if (demo) {
        if (state.connectors.length >= 10) throw new Error('Sample connector limit reached.');
        state.connectors.push({
          id: id(),
          name: data.name,
          issuer: data.issuer,
          client_id: data.clientId,
          active: true,
        });
        record('connector_created', data.name);
      } else await api('connectors', 'POST', data);
    }
    await refresh();
    render();
    $('#editor').close();
    form.reset();
    toast(demo ? 'Sample workspace updated.' : 'Instance updated.');
  } catch (err) {
    $('#form-error').textContent = err.message;
  } finally {
    button.disabled = false;
  }
});
document.addEventListener('click', async (event) => {
  const target = event.target.closest('[data-action]');
  if (!target) return;
  const action = target.dataset.action;
  try {
    if (action === 'close') return $('#editor').close();
    if (action === 'add') return openEditor(target.dataset.kind);
    if (action === 'reset' && demo) {
      if (!confirm('Reset all sample data in this browser?')) return;
      state = seed();
      persist();
      render();
      toast('Sample workspace reset.');
      return;
    }
    if (action === 'logout') {
      await fetch('/api/session', { method: 'DELETE' });
      location.assign('/login');
      return;
    }
    target.disabled = true;
    if (action === 'toggle-user') {
      const user = state.users.find((u) => u.id === target.dataset.id);
      if (user.active && user.admin && state.users.filter((u) => u.active && u.admin).length <= 1)
        throw new Error('Keep at least one active administrator.');
      if (demo) {
        user.active = !user.active;
        record(user.active ? 'user_enabled' : 'user_suspended', user.email);
      } else await api(`users/${encodeURIComponent(user.id)}`, 'PATCH', { active: !user.active });
    } else if (action === 'remove-app') {
      const app = state.apps.find((a) => a.client_id === target.dataset.id);
      if (!confirm(`Remove ${app.client_name}?`)) return;
      if (demo) {
        state.apps = state.apps.filter((a) => a.client_id !== app.client_id);
        record('client_removed', app.client_name);
      } else await api(`clients/${encodeURIComponent(app.client_id)}`, 'DELETE');
    } else if (action === 'toggle-connector') {
      const connector = state.connectors.find((c) => c.id === target.dataset.id);
      if (demo) {
        connector.active = !connector.active;
        record('connector_updated', connector.name);
      } else
        await api(`connectors/${encodeURIComponent(connector.id)}`, 'PATCH', {
          active: !connector.active,
        });
    } else if (action === 'export') {
      const events = demo ? state.events : await api('events/export'),
        blob = new Blob([JSON.stringify(events, null, 2)], { type: 'application/json' }),
        url = URL.createObjectURL(blob),
        link = document.createElement('a');
      link.href = url;
      link.download = demo ? 'mayoauth-sample-audit.json' : 'mayoauth-audit.json';
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      toast('Audit JSON exported.');
      return;
    } else return;
    await refresh();
    render();
    toast(demo ? 'Sample workspace updated.' : 'Instance updated.');
  } catch (err) {
    toast(err.message);
  } finally {
    target.disabled = false;
  }
});
window.addEventListener('hashchange', () => state && render());
refresh()
  .then(render)
  .catch((err) => {
    $('#console-error').textContent = err.message;
  });
