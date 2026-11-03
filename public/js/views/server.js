// Server level: database list and server information.
import {
  h, icon, card, toast, fmtBytes, fmtDate, confirmDialog, promptDialog, errorBox, loading,
} from '../util.js';
import { api, apiDownload, apiUpload } from '../api.js';
import {
  state, href, go, loadDatabases, isReadOnly, isPublic, currentUser, fmtDuration, LOCATION_LABELS,
} from '../app.js';
import { openAuthDialog, accountsEnabled, signupEnabled } from './account.js';

const MB = 1048576;

/** "Save to my account" checkbox for signed-in users; returns [element, () => location]. */
function locationChoice() {
  if (!isPublic() || !currentUser()) return [null, () => undefined];
  const box = h('input', { type: 'checkbox', checked: true });
  return [h('label', { class: 'row nowrap gap-sm small' }, box, 'Save to my account'), () => (box.checked ? 'saved' : 'temp')];
}

export function locationBadge(location) {
  if (!location) return null;
  return h('span', {
    class: `badge ${location === 'saved' ? 'green' : 'amber'}`,
    title: location === 'saved' ? 'Kept in your account' : 'Deleted when your session ends',
  }, LOCATION_LABELS[location]);
}

/** Notice explaining where a public-mode visitor's databases are kept, with their storage usage. */
function storageNotice(dbs, usage) {
  const limits = state.status.limits;
  const user = currentUser();
  const used = usage ? h('div', { class: 'small muted mt' }, [
    ...usage.locations.map((l) => `${LOCATION_LABELS[l.id]}: ${fmtBytes(l.used)} of ${fmtBytes(l.quota)}`),
    `${usage.databases} of ${usage.maxDatabases} databases`,
  ].join(' · ')) : null;
  if (!user) {
    return h('div', { class: 'alert alert-info' }, icon('info', 18),
      h('div', { class: 'grow' },
        h('p', null, h('strong', null, 'You are working as a guest. '),
          `Your databases are private to this browser and are deleted after ${fmtDuration(limits.guestTtl)} without activity.`,
          accountsEnabled() ? '' : ' Download any you want to keep.'),
        accountsEnabled() ? h('div', { class: 'row' },
          signupEnabled() ? h('button', { class: 'btn btn-sm btn-primary', onclick: () => openAuthDialog('signup') }, 'Sign up to save databases') : null,
          h('button', { class: 'btn btn-sm', onclick: () => openAuthDialog('login') }, 'Log in')) : null,
        used));
  }
  const temp = dbs.filter((d) => d.location === 'temp').length;
  return h('div', { class: `alert ${temp ? 'alert-warn' : 'alert-info'}` }, icon('info', 18),
    h('div', { class: 'grow' },
      temp
        ? h('p', null, `${LOCATION_LABELS.temp} databases are deleted when you log out or after ${fmtDuration(limits.userTtl)} without activity. `,
          'Use ', icon('save', 13), ' Save to keep one in your account.')
        : h('p', null, 'Your databases are saved in your account.'),
      used));
}

export async function saveDb(name) {
  try {
    await api('saveDatabase', { db: name });
    toast(`${name} is now saved in your account`, 'success');
    await loadDatabases();
    go(state.route || {});
  } catch (e) { toast(e.message, 'error'); }
}

export async function renderDatabases(container) {
  const pub = isPublic();
  const [dbs, usage] = await Promise.all([loadDatabases(), pub ? api('usage').catch(() => null) : null]);
  const ro = isReadOnly();
  const user = currentUser();

  const nameInput = h('input', { type: 'text', placeholder: 'e.g. inventory.db', style: { width: '260px' } });
  const [createWhere, createLocation] = locationChoice();
  const create = async () => {
    const name = nameInput.value.trim();
    if (!name) { nameInput.focus(); return; }
    try {
      const r = await api('createDatabase', { name, location: createLocation() });
      toast(`Database ${r.name} created`, 'success');
      await loadDatabases();
      go({ db: r.name });
    } catch (e) { toast(e.message, 'error'); }
  };
  nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') create(); });

  const rows = dbs.map((d) => h('tr', null,
    h('td', null, h('a', { href: href({ db: d.name }), class: 'row nowrap gap-sm' }, icon('database', 15), h('strong', null, d.name)),
      d.external ? h('span', { class: 'badge amber', style: { marginLeft: '8px' }, title: d.path }, 'external') : null,
      d.error ? h('div', { class: 'small danger-text' }, d.error) : null),
    pub ? h('td', null, locationBadge(d.location)) : null,
    h('td', { class: 'num' }, fmtBytes(d.size)),
    h('td', { class: 'num' }, d.tables ?? '—'),
    h('td', { class: 'num' }, d.views ?? '—'),
    h('td', null, d.journal ? h('span', { class: 'badge' }, d.journal.toUpperCase()) : '—'),
    h('td', { class: 'nowrap' }, fmtDate(d.mtime)),
    h('td', { class: 'actions' },
      h('a', { class: 'btn btn-sm btn-ghost', href: href({ db: d.name, tab: 'sql' }), title: 'Run SQL' }, icon('code', 14), 'SQL'),
      h('button', {
        class: 'icon-btn sm', title: 'Download database file',
        onclick: () => apiDownload('downloadDatabase', { db: d.name }).catch((e) => toast(e.message, 'error')),
      }, icon('download', 15)),
      user && d.location === 'temp' ? h('button', { class: 'icon-btn sm', title: 'Save to my account', onclick: () => saveDb(d.name) }, icon('save', 15)) : null,
      ro || d.external ? null : h('button', { class: 'icon-btn sm', title: 'Rename', onclick: () => renameDb(d.name) }, icon('edit', 15)),
      ro ? null : h('button', { class: 'icon-btn sm', title: 'Copy', onclick: () => copyDb(d.name) }, icon('copy', 15)),
      ro || d.external ? null : h('button', { class: 'icon-btn sm danger', title: 'Delete', onclick: () => deleteDb(d.name) }, icon('trash', 15)))));

  const list = card({
    title: `Databases (${dbs.length})`,
    actions: h('button', { class: 'btn btn-sm', onclick: () => go({}) }, icon('refresh', 14), 'Refresh'),
    flush: true,
    body: dbs.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'tbl' },
      h('thead', null, h('tr', null, h('th', null, 'Name'), pub ? h('th', null, 'Storage') : null, h('th', { class: 'num' }, 'Size'), h('th', { class: 'num' }, 'Tables'),
        h('th', { class: 'num' }, 'Views'), h('th', null, 'Journal'), h('th', null, 'Modified'), h('th', null, ''))),
      h('tbody', null, rows)))
      : h('div', { class: 'empty' }, icon('database', 40), h('p', null, 'No databases yet. Create one or upload an existing file.')),
  });

  const panels = [];
  if (!ro) {
    panels.push(card({
      title: 'Create database',
      body: [h('div', { class: 'row' }, nameInput, h('button', { class: 'btn btn-primary', onclick: create }, icon('plus', 15), 'Create')),
        createWhere ? h('div', { class: 'mt' }, createWhere) : null,
        h('p', { class: 'muted small mt' }, pub ? 'The .db extension is added when missing.'
          : `Files are stored in ${state.status.dataDir}. The .db extension is added when missing.`)],
    }));
    panels.push(card({ title: 'Upload database', body: uploadPanel() }));
  }

  container.replaceChildren(h('h1', null, 'Databases'), pub ? storageNotice(dbs, usage) : null, list,
    panels.length ? h('div', { class: 'grid-2' }, panels) : null);
}

function uploadPanel() {
  const [uploadWhere, uploadLocation] = locationChoice();
  const maxUpload = isPublic() ? state.status.limits.maxUpload : 0;
  const fileInput = h('input', { type: 'file', accept: '.db,.sqlite,.sqlite3,.db3,.s3db,.sl3', hidden: true });
  const progress = h('div', { class: 'progress', hidden: true }, h('div'));
  const zone = h('div', { class: 'drop-zone', tabindex: '0', role: 'button', onclick: () => fileInput.click(),
    onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); } } },
  icon('upload', 26), h('div', null, h('strong', null, 'Drop an SQLite file here'), ' or click to choose'),
  h('div', { class: 'small' }, '.db, .sqlite, .sqlite3, .db3', maxUpload ? ` · up to ${Math.round(maxUpload / MB)} MB` : ''));

  async function upload(file) {
    if (!file) return;
    if (maxUpload && file.size > maxUpload) {
      toast(`${file.name} is ${fmtBytes(file.size)}; the upload limit is ${Math.round(maxUpload / MB)} MB.`, 'error');
      return;
    }
    let name = file.name;
    if (state.databases.some((d) => d.name === name)) {
      name = await promptDialog({ title: 'Name already in use', label: 'Save the uploaded database as', value: `copy-of-${file.name}`, okLabel: 'Upload' });
      if (!name) return;
    }
    progress.hidden = false;
    const bar = progress.firstChild;
    try {
      const location = uploadLocation();
      const r = await apiUpload('uploadDatabase', location ? { name, location } : { name }, file, (p) => { bar.style.width = `${Math.round(p * 100)}%`; });
      toast(`Uploaded ${r.name}`, 'success');
      await loadDatabases();
      go({ db: r.name });
    } catch (e) {
      toast(e.message, 'error');
    } finally {
      progress.hidden = true;
      bar.style.width = '0';
    }
  }

  fileInput.addEventListener('change', () => upload(fileInput.files[0]));
  zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('over'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('over'));
  zone.addEventListener('drop', (e) => {
    e.preventDefault();
    zone.classList.remove('over');
    upload(e.dataTransfer.files[0]);
  });
  return [zone, fileInput, uploadWhere ? h('div', { class: 'mt' }, uploadWhere) : null, h('div', { class: 'mt' }, progress)];
}

export async function renameDb(name) {
  const newName = await promptDialog({ title: `Rename ${name}`, label: 'New file name', value: name, okLabel: 'Rename' });
  if (!newName || newName === name) return;
  try {
    const r = await api('renameDatabase', { db: name, newName });
    toast(`Renamed to ${r.name}`, 'success');
    await loadDatabases();
    if (state.route && state.route.db === name) go({ db: r.name });
    else go({});
  } catch (e) { toast(e.message, 'error'); }
}

export async function copyDb(name) {
  const newName = await promptDialog({ title: `Copy ${name}`, label: 'Name of the copy', value: name.replace(/(\.[^.]+)$/, '-copy$1'), okLabel: 'Copy' });
  if (!newName) return;
  try {
    const r = await api('copyDatabase', { db: name, newName });
    toast(`Copied to ${r.name}`, 'success');
    await loadDatabases();
    go({ db: r.name });
  } catch (e) { toast(e.message, 'error'); }
}

export async function deleteDb(name) {
  const ok = await confirmDialog({
    title: 'Delete database',
    message: h('div', null, h('p', null, 'Permanently delete ', h('strong', null, name), ' and all of its data?'),
      h('p', { class: 'danger-text' }, 'This cannot be undone. Download a copy first if you might need it.')),
    okLabel: 'Delete database',
    danger: true,
  });
  if (!ok) return;
  try {
    await api('deleteDatabase', { db: name });
    toast(`Deleted ${name}`, 'success');
    await loadDatabases();
    go({});
  } catch (e) { toast(e.message, 'error'); }
}

export async function renderServerInfo(container) {
  container.replaceChildren(loading());
  let s;
  try {
    s = await api('status');
  } catch (e) {
    container.replaceChildren(errorBox(e));
    return;
  }
  const kv = (pairs) => h('dl', { class: 'kv' }, pairs.map(([k, v]) => [h('dt', null, k), h('dd', null, v)]));
  container.replaceChildren(
    h('h1', null, 'Server information'),
    h('div', { class: 'grid-2' },
      card({
        title: 'Environment',
        body: kv(s.public ? [
          ['SQLite Admin', s.app],
          ['SQLite library', s.sqlite],
          ['Guest storage', `${Math.round(s.limits.guestQuota / MB)} MB, kept ${fmtDuration(s.limits.guestTtl)} after your last visit`],
          ['Account storage', `${Math.round(s.limits.userQuota / MB)} MB`],
          ['Databases', `Up to ${s.limits.maxDatabases}`],
          ['Uploads', `Up to ${Math.round(s.limits.maxUpload / MB)} MB`],
          ['Time limit', s.limits.queryTimeout ? `${Math.round(s.limits.queryTimeout / 1000)} seconds per operation` : 'None'],
          ['Disabled', 'ATTACH, VACUUM INTO and PRAGMAs that affect the server'],
        ] : [
          ['SQLite Admin', s.app],
          ['SQLite library', s.sqlite],
          ['Node.js', s.node],
          ['Platform', s.platform],
          ['Data directory', h('span', { class: 'mono' }, s.dataDir)],
          ['Mode', s.readOnly ? h('span', { class: 'badge amber' }, 'Read-only') : h('span', { class: 'badge green' }, 'Read/write')],
          ['Authentication', s.authRequired ? 'Password required' : 'Disabled (local access only)'],
        ]),
      }),
      card({
        title: `Compile options (${s.compileOptions.length})`,
        body: h('div', { class: 'chips' }, s.compileOptions.map((o) => h('span', { class: 'badge mono' }, o))),
      })),
    card({
      title: 'Keyboard shortcuts',
      body: kv([
        ['Ctrl/⌘ + Enter', 'Run SQL (or the selected part)'],
        ['Ctrl/⌘ + Space', 'Show autocompletion'],
        ['Ctrl/⌘ + /', 'Toggle comment on selected lines'],
        ['Double-click a cell', 'Edit it in place (Browse)'],
        ['Right-click a cell', 'More actions: copy, filter, set NULL…'],
        ['Esc', 'Close dialogs and menus'],
      ]),
    }));
}
