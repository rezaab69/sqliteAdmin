// Application shell: login, header, sidebar tree, tabs and view dispatch.
import {
  h, icon, store, toast, loading, errorBox, showMenu,
} from './util.js';
import { api, onAuthRequired } from './api.js';
import {
  state, on, parseRoute, href, go, loadDatabases, loadSchema, findTable, setTx,
} from './app.js';
import { renderDatabases, renderServerInfo } from './views/server.js';
import {
  openAuthDialog, logOut, renderAccount, renderVerify, renderReset, accountsEnabled, signupEnabled,
} from './views/account.js';
import { renderDbStructure, renderDbSearch, renderDbOperations } from './views/database.js';
import { renderBrowse, renderInsert, renderTableSearch } from './views/browse.js';
import { renderStructure, renderTableOperations } from './views/structure.js';
import { renderDesigner } from './views/designer.js';
import { renderSql } from './views/sql.js';
import { renderExport, renderImport } from './views/transfer.js';
import { renderDiagram } from './views/diagram.js';

const TABS = {
  server: [['databases', 'Databases', 'database'], ['status', 'Server info', 'info']],
  db: [['structure', 'Structure', 'structure'], ['sql', 'SQL', 'code'], ['search', 'Search', 'search'],
    ['designer', 'Designer', 'diagram'], ['export', 'Export', 'download'], ['import', 'Import', 'upload'],
    ['operations', 'Operations', 'sliders']],
  table: [['browse', 'Browse', 'grid'], ['structure', 'Structure', 'structure'], ['sql', 'SQL', 'code'],
    ['search', 'Search', 'search'], ['insert', 'Insert', 'plus-square'], ['export', 'Export', 'download'],
    ['import', 'Import', 'upload'], ['operations', 'Operations', 'sliders']],
  view: [['browse', 'Browse', 'grid'], ['structure', 'Structure', 'structure'], ['sql', 'SQL', 'code'],
    ['search', 'Search', 'search'], ['export', 'Export', 'download'], ['operations', 'Operations', 'sliders']],
};
// Tabs that exist but are reached through buttons; they highlight their parent tab.
const HIDDEN_TABS = { newtable: 'structure', edit: 'structure' };

const VIEWS = {
  server: {
    databases: renderDatabases, status: renderServerInfo, account: renderAccount, verify: renderVerify, reset: renderReset,
  },
  db: {
    structure: renderDbStructure, sql: renderSql, search: renderDbSearch, designer: renderDiagram,
    export: renderExport, import: renderImport, operations: renderDbOperations, newtable: renderDesigner,
  },
  table: {
    browse: renderBrowse, structure: renderStructure, sql: renderSql, search: renderTableSearch, insert: renderInsert,
    export: renderExport, import: renderImport, operations: renderTableOperations, edit: renderDesigner,
  },
};

const root = document.getElementById('root');
let shell = null;
let renderToken = 0;

// ---------------------------------------------------------------------------------------------
// Theme

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  store.set('theme', theme);
}

function themeButton() {
  const btn = h('button', { class: 'icon-btn', title: 'Toggle light/dark theme' });
  const update = () => btn.replaceChildren(icon(document.documentElement.dataset.theme === 'dark' ? 'sun' : 'moon', 18));
  btn.addEventListener('click', () => {
    applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
    update();
  });
  update();
  return btn;
}

// ---------------------------------------------------------------------------------------------
// Login

function renderLogin(message) {
  shell = null;
  const pw = h('input', { type: 'password', class: 'w-full', autocomplete: 'current-password', autofocus: true, placeholder: 'Password' });
  const err = h('div', { class: 'small danger-text', style: { minHeight: '18px' } }, message || '');
  const submit = async (e) => {
    e.preventDefault();
    err.textContent = '';
    try {
      await api('login', { password: pw.value });
      start();
    } catch (ex) {
      err.textContent = ex.message;
      pw.select();
    }
  };
  root.replaceChildren(h('div', { class: 'login-page' },
    h('form', { class: 'card login-card', onsubmit: submit },
      h('div', { class: 'card-body' },
        h('div', { class: 'brand-lg' }, icon('database', 26), 'SQLite Admin'),
        h('div', { class: 'field' }, h('label', null, 'Password'), pw),
        err,
        h('button', { class: 'btn btn-primary w-full', type: 'submit' }, 'Log in')))));
  pw.focus();
}

onAuthRequired(() => renderLogin('Your session has expired. Please log in again.'));

// ---------------------------------------------------------------------------------------------
// Shell

function buildShell() {
  const crumbs = h('nav', { class: 'crumbs', 'aria-label': 'Breadcrumb' });
  const sidebar = h('aside', { class: 'sidebar', 'aria-label': 'Database navigator' });
  const tabs = h('nav', { class: 'tabs', 'aria-label': 'Sections' });
  const banners = h('div');
  const content = h('div', { class: 'content' });
  const main = h('main', { class: 'main' }, banners, tabs, content);
  const resizer = h('div', { class: 'resizer', title: 'Drag to resize' });
  const app = h('div', { class: 'app' },
    h('header', { class: 'topbar' },
      h('button', { class: 'icon-btn menu-toggle', title: 'Toggle navigation', onclick: () => app.classList.toggle('sidebar-open') }, icon('menu', 18)),
      h('a', { class: 'brand', href: '#/' }, icon('database', 20), 'SQLite Admin'),
      crumbs,
      h('div', { class: 'spacer' }),
      themeButton(),
      accountControls()),
    h('div', { class: 'app-body' }, sidebar, resizer, main));

  const width = store.get('sidebarWidth', null);
  if (width) app.style.setProperty('--sidebar-w', `${width}px`);
  resizer.addEventListener('mousedown', (e) => {
    e.preventDefault();
    resizer.classList.add('active');
    const move = (ev) => {
      const w = Math.max(180, Math.min(600, ev.clientX));
      app.style.setProperty('--sidebar-w', `${w}px`);
      store.set('sidebarWidth', w);
    };
    const up = () => {
      resizer.classList.remove('active');
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
    };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  });

  root.replaceChildren(app);
  return { app, crumbs, sidebar, tabs, banners, main, content };
}

function accountControls() {
  if (!state.status.public) {
    return state.status.authRequired ? h('button', {
      class: 'icon-btn', title: 'Log out',
      onclick: async () => { await api('logout').catch(() => {}); renderLogin(); },
    }, icon('logout', 18)) : null;
  }
  const user = state.status.user;
  if (!user) {
    if (!accountsEnabled()) return null;
    return h('div', { class: 'account-btns' },
      h('button', { class: 'btn btn-sm topbar-btn', onclick: () => openAuthDialog('login') }, 'Log in'),
      signupEnabled() ? h('button', { class: 'btn btn-sm btn-primary', onclick: () => openAuthDialog('signup') }, 'Sign up') : null);
  }
  const btn = h('button', {
    class: 'btn btn-sm topbar-btn', title: `Logged in as ${user.email}`, 'aria-haspopup': 'menu',
    onclick: () => {
      const r = btn.getBoundingClientRect();
      showMenu(r.right - 190, r.bottom + 4, [
        { label: 'Account settings', icon: 'user', onClick: () => go({ tab: 'account' }) },
        '-',
        { label: 'Log out', icon: 'logout', onClick: logOut },
      ]);
    },
  }, icon('user', 16), h('span', { class: 'hide-sm user-label' }, user.name || user.email));
  return btn;
}

function renderCrumbs(route, obj) {
  const parts = [h('a', { href: '#/', class: 'hide-sm' }, icon('server', 14), 'Server')];
  if (route.db) {
    parts.push(h('span', { class: 'sep hide-sm' }, '›'));
    parts.push(h('a', { href: href({ db: route.db }), class: route.table ? '' : 'current' }, icon('database', 14), route.db));
  }
  if (route.table) {
    parts.push(h('span', { class: 'sep' }, '›'));
    parts.push(h('a', { href: href({ db: route.db, table: route.table }), class: 'current' },
      icon(obj && obj.type === 'view' ? 'view' : 'table', 14), route.table));
  }
  shell.crumbs.replaceChildren(...parts);
}

function renderTabs(route, obj) {
  const level = route.table ? (obj && obj.type === 'view' ? 'view' : 'table') : route.db ? 'db' : 'server';
  const activeTab = HIDDEN_TABS[route.tab] || route.tab;
  shell.tabs.replaceChildren(...TABS[level].map(([id, label, ic]) => h('a', {
    href: href({ db: route.db, table: route.table, tab: id }),
    class: id === activeTab ? 'active' : '',
    'aria-current': id === activeTab ? 'page' : null,
  }, icon(ic, 15), label)));
}

function renderBanners(route) {
  const items = [];
  if (state.status.readOnly) items.push(h('div', { class: 'ro-banner' }, icon('lock', 13), ' Read-only mode: changes are disabled.'));
  if (route.db && state.tx[route.db]) {
    const act = async (action) => {
      try {
        await api('transaction', { db: route.db, action });
        setTx(route.db, false);
        toast(action === 'commit' ? 'Transaction committed' : 'Transaction rolled back', 'success');
        go(route);
      } catch (e) { toast(e.message, 'error'); }
    };
    items.push(h('div', { class: 'tx-banner' }, icon('alert', 15),
      h('span', { class: 'grow' }, 'A transaction is open on this database. Other connections cannot write until you commit or roll back.'),
      h('button', { class: 'btn btn-sm btn-primary', onclick: () => act('commit') }, 'Commit'),
      h('button', { class: 'btn btn-sm btn-danger', onclick: () => act('rollback') }, 'Roll back')));
  }
  shell.banners.replaceChildren(...items);
}

// ---------------------------------------------------------------------------------------------
// Sidebar

const collapsed = store.get('sb:collapsed', { indexes: true, triggers: true, system: true });
let sidebarFilter = '';

function treeGroup(id, label, items, extra) {
  const li = h('li', { class: `tree-group ${collapsed[id] ? 'collapsed' : ''}` },
    h('div', {
      class: 'tree-label', role: 'button', tabindex: '0',
      onclick: () => {
        collapsed[id] = !collapsed[id];
        li.classList.toggle('collapsed', collapsed[id]);
        store.set('sb:collapsed', collapsed);
      },
      onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.currentTarget.click(); } },
    }, icon('chevron-down', 12, 'chev'), label, h('span', { class: 'count' }, items.length)),
    h('ul', null, extra, items));
  return li;
}

function treeItem(link, ic, name, active, sub) {
  return h('li', { class: 'tree-item' }, h('a', { href: link, class: active ? 'active' : '', title: name },
    icon(ic, 15), h('span', { class: 'name' }, name), sub ? h('span', { class: 'sub' }, sub) : null));
}

function renderSidebar(route) {
  const dbSelect = h('select', {
    'aria-label': 'Database',
    onchange: (e) => go(e.target.value ? { db: e.target.value } : {}),
    id: 'sb-db-select',
    title: route.db || 'Select a database',
  }, h('option', { value: '' }, state.databases.length ? 'All databases…' : 'No databases yet'),
  state.databases.map((d) => h('option', { value: d.name, selected: d.name === route.db },
    d.tables !== undefined ? `${d.name}  (${d.tables} ${d.tables === 1 ? 'table' : 'tables'})` : d.name)));
  const filter = h('input', {
    type: 'search', placeholder: route.db ? 'Filter tables…' : 'Filter databases…', value: sidebarFilter,
    'aria-label': 'Filter',
    oninput: (e) => { sidebarFilter = e.target.value; renderTree(); },
  });
  const tree = h('ul', { class: 'tree' });

  function renderTree() {
    const f = sidebarFilter.toLowerCase();
    const match = (name) => !f || name.toLowerCase().includes(f);
    const groups = [];
    if (!route.db) {
      groups.push(treeGroup('dbs', 'Databases', state.databases.filter((d) => match(d.name))
        .map((d) => treeItem(href({ db: d.name }), 'database', d.name, false, d.tables !== undefined ? `${d.tables}` : ''))));
    } else if (state.schema && state.schemaDb === route.db) {
      const s = state.schema;
      const tables = s.tables.filter((t) => (t.type === 'table' || t.type === 'virtual') && !t.system && match(t.name));
      const views = s.tables.filter((t) => t.type === 'view' && match(t.name));
      const system = s.tables.filter((t) => (t.system || t.type === 'shadow') && match(t.name));
      const newTable = state.status.readOnly ? null : h('li', { class: 'tree-item tree-action' },
        h('a', { href: href({ db: route.db, tab: 'newtable' }) }, icon('plus', 15), 'New table'));
      groups.push(treeGroup('tables', 'Tables', tables.map((t) => treeItem(href({ db: route.db, table: t.name }),
        t.type === 'virtual' ? 'columns' : 'table', t.name, t.name === route.table)), newTable));
      if (views.length || !f) groups.push(treeGroup('views', 'Views', views.map((t) => treeItem(href({ db: route.db, table: t.name }), 'view', t.name, t.name === route.table))));
      const idx = s.indexes.filter((i) => !i.auto && (match(i.name) || match(i.table)));
      if (idx.length) groups.push(treeGroup('indexes', 'Indexes', idx.map((i) => treeItem(href({ db: route.db, table: i.table, tab: 'structure' }), 'index', i.name, false, i.table))));
      const trg = s.triggers.filter((t) => match(t.name) || match(t.table));
      if (trg.length) groups.push(treeGroup('triggers', 'Triggers', trg.map((t) => treeItem(href({ db: route.db, table: t.table, tab: 'structure' }), 'trigger', t.name, false, t.table))));
      if (system.length) groups.push(treeGroup('system', 'System', system.map((t) => treeItem(href({ db: route.db, table: t.name }), 'lock', t.name, t.name === route.table))));
    }
    tree.replaceChildren(...groups);
    if (!groups.length) tree.append(h('li', { class: 'sb-empty' }, route.db ? 'Loading…' : 'No databases yet.'));
  }
  renderTree();

  shell.sidebar.replaceChildren(
    h('div', { class: 'sb-section' },
      h('label', { class: 'sb-label', for: 'sb-db-select' }, 'Database'),
      h('div', { class: 'sb-db' }, dbSelect,
        h('a', { class: 'icon-btn', href: '#/', title: 'All databases' }, icon('server', 16))),
      h('div', { class: 'sb-filter' }, icon('search', 14), filter)),
    tree);
  const active = tree.querySelector('a.active');
  if (active) active.scrollIntoView({ block: 'nearest' });
}

// ---------------------------------------------------------------------------------------------
// Rendering

async function render() {
  if (!shell) return;
  const token = ++renderToken;
  const route = parseRoute();
  const prevDb = state.route && state.route.db;
  state.route = route;
  if (route.db !== prevDb) sidebarFilter = '';
  shell.app.classList.remove('sidebar-open');

  const content = h('div', { class: 'content' });
  shell.content.replaceWith(content);
  shell.content = content;
  content.append(loading());

  let obj = null;
  try {
    if (route.db) {
      if (!state.databases.some((d) => d.name === route.db)) await loadDatabases();
      await loadSchema(route.db);
      if (route.table) {
        obj = findTable(route.table);
        if (!obj) throw new Error(`Table or view "${route.table}" does not exist in ${route.db}.`);
      }
    }
  } catch (e) {
    if (token !== renderToken) return;
    renderCrumbs(route, obj);
    renderSidebar(route);
    shell.tabs.replaceChildren();
    content.replaceChildren(errorBox(e), h('a', { class: 'btn', href: route.table ? href({ db: route.db }) : '#/' }, icon('chevron-left', 15), 'Back'));
    return;
  }
  if (token !== renderToken) return;

  const level = route.table ? 'table' : route.db ? 'db' : 'server';
  document.title = [route.table, route.db, 'SQLite Admin'].filter(Boolean).join(' · ');
  renderCrumbs(route, obj);
  renderSidebar(route);
  renderTabs(route, obj);
  renderBanners(route);

  const view = VIEWS[level][route.tab];
  if (!view) {
    content.replaceChildren(errorBox(new Error(`Unknown page: ${route.tab}`)));
    return;
  }
  try {
    await view(content, route, { obj });
  } catch (e) {
    if (token === renderToken) {
      console.error(e);
      content.replaceChildren(errorBox(e));
    }
  }
  shell.main.scrollTop = 0;
}

on('navigate', render);
on('schema', () => { if (shell && state.route) renderSidebar(state.route); });
on('databases', () => { if (shell && state.route) renderSidebar(state.route); });
on('tx', () => { if (shell && state.route) renderBanners(state.route); });
// Logged in or out (public mode): the set of databases changed, so start over.
on('session', () => {
  Object.assign(state, { schema: null, schemaDb: null, databases: [], tx: {}, route: null });
  start();
});
window.addEventListener('hashchange', render);

async function start() {
  try {
    state.status = await api('status');
  } catch (e) {
    if (e.status === 401) { renderLogin(); return; }
    root.replaceChildren(h('div', { class: 'content' }, errorBox(e, 'Unable to start SQLite Admin')));
    return;
  }
  shell = buildShell();
  showSignInResult();
  try { await loadDatabases(); } catch (e) { toast(e.message, 'error'); }
  render();
}

// Where "Continue with Google" ends up: the server redirects to #/?signedIn=google or #/?authError=<code>.
const AUTH_ERRORS = {
  'google-cancelled': 'Google sign-in was cancelled.',
  'google-expired': 'The Google sign-in took too long or was started in another browser. Please try again.',
  'google-unverified': 'Your Google account\'s email address is not verified, so it can\'t be used here.',
  'google-mismatch': 'This email address is already linked to a different Google account.',
  'google-disabled': 'Google sign-in is not available on this server.',
  'signup-closed': 'Creating new accounts is disabled on this server.',
  'rate-limited': 'Too many sign-ups from your network. Please try again later.',
};

function showSignInResult() {
  const { params } = parseRoute();
  if (!params.signedIn && !params.authError) return;
  if (params.signedIn && state.status.user) toast(`Logged in as ${state.status.user.email}`, 'success');
  if (params.authError) toast(AUTH_ERRORS[params.authError] || 'Google sign-in failed. Please try again.', 'error');
  history.replaceState(null, '', '#/');
}

start();
