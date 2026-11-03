// Database level: structure overview, global search and operations.
import {
  h, icon, card, toast, fmtBytes, fmtNum, fmtDate, confirmDialog, loading, errorBox, qi, select, plural, fmtMs,
} from '../util.js';
import { api, apiDownload } from '../api.js';
import {
  href, go, browseHref, isReadOnly, execSql, loadSchema, state, currentUser,
} from '../app.js';
import { resultGrid } from '../grid.js';
import {
  renameDb, copyDb, deleteDb, saveDb, locationBadge,
} from './server.js';

function typeBadges(o) {
  return [
    o.type === 'view' ? h('span', { class: 'badge blue' }, 'view') : null,
    o.type === 'virtual' ? h('span', { class: 'badge blue' }, 'virtual') : null,
    o.type === 'shadow' ? h('span', { class: 'badge' }, 'shadow') : null,
    o.withoutRowid ? h('span', { class: 'badge amber' }, 'WITHOUT ROWID') : null,
    o.strict ? h('span', { class: 'badge green' }, 'STRICT') : null,
  ];
}

export async function renderDbStructure(container, route) {
  const db = route.db;
  const { objects, info } = await api('overview', { db });
  const ro = isReadOnly();
  const userObjects = objects.filter((o) => !o.system && o.type !== 'shadow');
  const systemObjects = objects.filter((o) => o.system || o.type === 'shadow');
  const selected = new Set();

  const bulkBar = h('div', { class: 'row' });
  const updateBulk = () => {
    bulkBar.replaceChildren(
      h('span', { class: 'muted small' }, selected.size ? `${selected.size} selected:` : 'With selected:'),
      h('button', {
        class: 'btn btn-sm', disabled: !selected.size,
        onclick: () => go({ db, tab: 'export', params: { tables: [...selected].join(',') } }),
      }, icon('download', 14), 'Export'),
      ro ? null : h('button', { class: 'btn btn-sm', disabled: !selected.size, onclick: () => emptyTables([...selected]) }, 'Empty'),
      ro ? null : h('button', { class: 'btn btn-sm btn-danger', disabled: !selected.size, onclick: () => dropObjects([...selected]) }, icon('trash', 14), 'Drop'));
  };

  async function emptyTables(names) {
    const tables = names.filter((n) => objects.find((o) => o.name === n && o.type !== 'view'));
    if (!tables.length) { toast('Views cannot be emptied', 'error'); return; }
    const hasSeq = objects.some((o) => o.name === 'sqlite_sequence');
    const reset = h('input', { type: 'checkbox', checked: true });
    const sql = tables.map((t) => `DELETE FROM ${qi(t)};`).join('\n');
    const ok = await confirmDialog({
      title: `Empty ${plural(tables.length, 'table')}`,
      message: h('div', null, h('p', null, 'All rows will be deleted. The table structure is kept.'),
        hasSeq ? h('label', { class: 'check mb' }, reset, 'Reset AUTOINCREMENT counters') : null),
      sql, okLabel: 'Empty', danger: true,
    });
    if (!ok) return;
    const full = sql + (hasSeq && reset.checked ? `\nDELETE FROM sqlite_sequence WHERE name IN (${tables.map((t) => `'${t.replace(/'/g, "''")}'`).join(', ')});` : '');
    try {
      await execSql(db, `BEGIN;\n${full}\nCOMMIT;`, { successMessage: `Emptied ${plural(tables.length, 'table')}` });
      go(route);
    } catch (e) { toast(e.message, 'error', { sql: e.sql }); }
  }

  async function dropObjects(names) {
    const sql = names.map((n) => {
      const o = objects.find((x) => x.name === n);
      return `DROP ${o && o.type === 'view' ? 'VIEW' : 'TABLE'} ${qi(n)};`;
    }).join('\n');
    const ok = await confirmDialog({
      title: `Drop ${plural(names.length, 'object')}`,
      message: h('p', { class: 'danger-text' }, 'The selected tables/views and all their data, indexes and triggers will be permanently removed.'),
      sql, okLabel: 'Drop', danger: true,
    });
    if (!ok) return;
    try {
      await execSql(db, `BEGIN;\n${sql}\nCOMMIT;`, { successMessage: `Dropped ${plural(names.length, 'object')}` });
      go(route);
    } catch (e) { toast(e.message, 'error', { sql: e.sql }); }
  }

  const allBox = h('input', {
    type: 'checkbox', 'aria-label': 'Select all',
    onchange: (e) => {
      container.querySelectorAll('input.obj-sel').forEach((cb) => {
        cb.checked = e.target.checked;
        if (cb.checked) selected.add(cb.value); else selected.delete(cb.value);
      });
      updateBulk();
    },
  });

  const row = (o) => {
    const isView = o.type === 'view';
    const act = (tab, ic, title) => h('a', { class: 'icon-btn sm', href: href({ db, table: o.name, tab }), title }, icon(ic, 15));
    return h('tr', null,
      h('td', null, h('input', {
        type: 'checkbox', class: 'obj-sel', value: o.name, 'aria-label': `Select ${o.name}`,
        onchange: (e) => { if (e.target.checked) selected.add(o.name); else selected.delete(o.name); updateBulk(); },
      })),
      h('td', null, h('a', { href: href({ db, table: o.name }), class: 'row nowrap gap-sm' },
        icon(isView ? 'view' : 'table', 15), h('strong', null, o.name)), o.error ? h('div', { class: 'small danger-text' }, o.error) : null),
      h('td', { class: 'nowrap' }, typeBadges(o)),
      h('td', { class: 'actions' },
        act('browse', 'grid', 'Browse'), act('structure', 'structure', 'Structure'), act('search', 'search', 'Search'),
        !isView && !ro ? act('insert', 'plus-square', 'Insert') : null,
        !isView && !ro ? h('button', { class: 'icon-btn sm', title: 'Empty', onclick: () => emptyTables([o.name]) }, icon('x', 15)) : null,
        !ro ? h('button', { class: 'icon-btn sm danger', title: 'Drop', onclick: () => dropObjects([o.name]) }, icon('trash', 15)) : null),
      h('td', { class: 'num' }, o.rows === null ? (isView ? h('span', { class: 'muted' }, 'view') : '—') : fmtNum(o.rows)),
      h('td', { class: 'num' }, o.size === null ? '—' : fmtBytes(o.size)),
      h('td', { class: 'num' }, o.columns ?? '—'),
      h('td', { class: 'num' }, o.indexes || ''));
  };

  const totalRows = userObjects.reduce((s, o) => s + (o.rows || 0), 0);
  const totalSize = userObjects.reduce((s, o) => s + (o.size || 0), 0);
  const tables = userObjects.filter((o) => o.type !== 'view');
  const views = userObjects.filter((o) => o.type === 'view');

  const table = h('table', { class: 'tbl' },
    h('thead', null, h('tr', null, h('th', { style: { width: '32px' } }, allBox), h('th', null, 'Name'), h('th', null, 'Type'),
      h('th', null, 'Actions'), h('th', { class: 'num' }, 'Rows'), h('th', { class: 'num' }, 'Size'),
      h('th', { class: 'num' }, 'Columns'), h('th', { class: 'num' }, 'Indexes'))),
    h('tbody', null, userObjects.map(row)),
    userObjects.length ? h('tfoot', null, h('tr', null, h('td'), h('td', null, `${plural(tables.length, 'table')}, ${plural(views.length, 'view')}`),
      h('td'), h('td'), h('td', { class: 'num' }, fmtNum(totalRows)), h('td', { class: 'num' }, info.fileSize !== undefined ? fmtBytes(totalSize) : ''), h('td'), h('td'))) : null);

  updateBulk();

  const stat = (label, value) => h('div', { class: 'stat' }, h('div', { class: 'label' }, label), h('div', { class: 'value' }, value));
  container.replaceChildren(
    h('div', { class: 'stats' },
      stat('Tables', fmtNum(tables.length)), stat('Views', fmtNum(views.length)), stat('Indexes', fmtNum(info.indexes)),
      stat('Triggers', fmtNum(info.triggers)), stat('Total rows', fmtNum(totalRows)), stat('File size', fmtBytes(info.fileSize))),
    card({
      title: 'Tables and views',
      actions: [
        ro ? null : h('a', { class: 'btn btn-sm btn-primary', href: href({ db, tab: 'newtable' }) }, icon('plus', 14), 'New table'),
        ro ? null : h('a', {
          class: 'btn btn-sm', href: href({ db, tab: 'sql', params: { sql: 'CREATE VIEW view_name AS\nSELECT *\nFROM table_name;' } }),
        }, icon('view', 14), 'New view'),
        h('button', { class: 'btn btn-sm', onclick: () => { loadSchema(db, true); go(route); } }, icon('refresh', 14), 'Refresh'),
      ],
      flush: true,
      body: userObjects.length
        ? [h('div', { class: 'table-wrap' }, table), h('div', { class: 'card-body', style: { borderTop: '1px solid var(--border)' } }, bulkBar)]
        : h('div', { class: 'empty' }, icon('table', 40), h('p', null, 'This database has no tables yet.'),
          ro ? null : h('a', { class: 'btn btn-primary', href: href({ db, tab: 'newtable' }) }, icon('plus', 15), 'Create the first table')),
    }),
    systemObjects.length ? card({
      title: 'System tables',
      flush: true,
      body: h('div', { class: 'table-wrap' }, h('table', { class: 'tbl' },
        h('thead', null, h('tr', null, h('th', null, 'Name'), h('th', null, 'Type'), h('th', { class: 'num' }, 'Rows'))),
        h('tbody', null, systemObjects.map((o) => h('tr', null,
          h('td', null, h('a', { href: href({ db, table: o.name }) }, o.name)), h('td', null, typeBadges(o), o.system ? h('span', { class: 'badge' }, 'internal') : null),
          h('td', { class: 'num' }, fmtNum(o.rows))))))),
    }) : null,
    card({
      title: 'Database information',
      body: h('dl', { class: 'kv' },
        [['File', h('span', { class: 'mono' }, info.file)], ['Size', `${fmtBytes(info.fileSize)} (${fmtNum(info.pageCount)} pages × ${fmtNum(info.pageSize)} bytes)`],
          ['Free pages', `${fmtNum(info.freelist)}${info.freelist > 0 ? ' — run VACUUM to reclaim space' : ''}`],
          ['Modified', fmtDate(info.modified)], ['Journal mode', info.journalMode], ['Encoding', info.encoding],
          ['Auto vacuum', ['NONE', 'FULL', 'INCREMENTAL'][info.autoVacuum] || info.autoVacuum],
          ['Foreign keys', info.foreignKeys ? 'enforced' : 'not enforced'], ['User version', info.userVersion],
          ['SQLite version', info.sqlite]].map(([k, v]) => [h('dt', null, k), h('dd', null, v)])),
    }));
}

// ---------------------------------------------------------------------------------------------

export async function renderDbSearch(container, route) {
  const db = route.db;
  const schema = await loadSchema(db);
  const objects = schema.tables.filter((t) => !t.system && t.type !== 'shadow');
  const term = h('input', { type: 'text', class: 'grow', placeholder: 'Text or value to find in every column', value: route.params.term || '', autofocus: true });
  const mode = select([['contains', 'contains (LIKE %…%)'], ['exact', 'exact match (=)'], ['regexp', 'regular expression']], route.params.mode || 'contains');
  const boxes = objects.map((t) => h('input', { type: 'checkbox', checked: true, value: t.name }));
  const results = h('div');

  const run = async () => {
    if (!term.value) { term.focus(); return; }
    results.replaceChildren(loading('Searching…'));
    const tables = boxes.filter((b) => b.checked).map((b) => b.value);
    try {
      const r = await api('searchDatabase', { db, term: term.value, mode: mode.value, tables: tables.length === boxes.length ? undefined : tables });
      const found = r.results.filter((x) => x.count);
      const total = found.reduce((s, x) => s + x.count, 0);
      results.replaceChildren(card({
        title: `${plural(total, 'match', 'matches')} in ${plural(found.length, 'table')} (${fmtMs(r.time)})`,
        flush: true,
        body: r.results.length ? h('table', { class: 'tbl' },
          h('thead', null, h('tr', null, h('th', null, 'Table'), h('th', { class: 'num' }, 'Matches'), h('th', null, 'Columns'), h('th'))),
          h('tbody', null, r.results.map((x) => h('tr', null,
            h('td', null, h('strong', null, x.table)),
            h('td', { class: 'num' }, x.error ? h('span', { class: 'danger-text' }, x.error) : fmtNum(x.count)),
            h('td', null, (x.columns || []).map((c) => h('span', { class: 'badge', style: { marginRight: '4px' } }, c))),
            h('td', { class: 'actions' }, x.error ? null : h('a', {
              class: 'btn btn-sm', href: browseHref(db, x.table, { search: term.value, searchMode: mode.value }),
            }, icon('grid', 14), 'Browse')))))) : h('div', { class: 'empty' }, 'No matches found.'),
      }));
    } catch (e) { results.replaceChildren(errorBox(e)); }
  };
  term.addEventListener('keydown', (e) => { if (e.key === 'Enter') run(); });

  container.replaceChildren(
    card({
      title: 'Search in database',
      body: [
        h('div', { class: 'row mb' }, term, mode, h('button', { class: 'btn btn-primary', onclick: run }, icon('search', 15), 'Search')),
        h('details', null, h('summary', { class: 'muted small', style: { cursor: 'pointer' } }, `Tables to search (${objects.length})`),
          h('div', { class: 'row mt' },
            h('button', { class: 'btn btn-sm', onclick: () => boxes.forEach((b) => { b.checked = true; }) }, 'Select all'),
            h('button', { class: 'btn btn-sm', onclick: () => boxes.forEach((b) => { b.checked = false; }) }, 'Select none')),
          h('div', { class: 'row mt', style: { gap: '6px 16px' } }, objects.map((t, i) => h('label', { class: 'check' }, boxes[i], t.name)))),
      ],
    }),
    results);
  if (route.params.term) run();
}

// ---------------------------------------------------------------------------------------------

const MAINTENANCE = [
  ['VACUUM', 'Vacuum', 'Rebuild the file to reclaim unused space and defragment it.'],
  ['ANALYZE', 'Analyze', 'Gather statistics so the query planner picks better indexes.'],
  ['PRAGMA optimize', 'Optimize', 'Run the recommended light-weight optimizations.'],
  ['PRAGMA integrity_check', 'Integrity check', 'Thoroughly verify the database structure.'],
  ['PRAGMA quick_check', 'Quick check', 'Faster, less thorough integrity check.'],
  ['PRAGMA foreign_key_check', 'Foreign key check', 'List rows that violate foreign key constraints.'],
  ['REINDEX', 'Reindex', 'Rebuild all indexes.'],
  ['PRAGMA wal_checkpoint(TRUNCATE)', 'WAL checkpoint', 'Copy the write-ahead log into the database file.'],
];

export async function renderDbOperations(container, route) {
  const db = route.db;
  const ro = isReadOnly();
  const dbInfo = state.databases.find((d) => d.name === db) || {};
  const out = h('div');

  const runMaintenance = async (sql, label) => {
    out.replaceChildren(loading(`${label}…`));
    try {
      const r = await execSql(db, sql);
      const res = r.results[0];
      out.replaceChildren(card({
        title: `${label} — ${fmtMs(res.time)}`,
        flush: !!res.columns,
        body: res.columns
          ? (res.rows.length ? resultGrid(res.columns, res.rows) : h('div', { class: 'card-body success-text' }, icon('check', 15), ' No problems found.'))
          : h('div', { class: 'success-text' }, icon('check', 15), ' Done.'),
      }));
    } catch (e) { out.replaceChildren(errorBox(e, label)); }
  };

  const pragmaCard = card({ title: 'Settings (PRAGMA)', flush: true, body: loading() });
  api('pragmas', { db }).then(({ pragmas }) => {
    const rows = pragmas.map((p) => {
      let input;
      if (p.readOnly) input = h('span', { class: 'mono' }, String(p.value ?? '—'));
      else if (p.bool) input = select([['1', 'ON'], ['0', 'OFF']], p.value ? '1' : '0', { class: 'input-sm' });
      else if (p.options) input = select(p.options.map((o, i) => [o, p.labels ? `${p.labels[i]} (${o})` : o.toUpperCase()]), String(p.value).toLowerCase(), { class: 'input-sm' });
      else input = h('input', { type: 'text', class: 'input-sm', value: p.value ?? '', style: { width: '120px' } });
      const save = p.readOnly || ro ? null : h('button', {
        class: 'btn btn-sm', onclick: async () => {
          try {
            const r = await api('setPragma', { db, name: p.name, value: input.value });
            toast(`${p.name} is now ${r.value}`, 'success', { sql: r.sql });
          } catch (e) { toast(e.message, 'error'); }
        },
      }, 'Save');
      return h('tr', null, h('td', { class: 'mono' }, p.name), h('td', null, input), h('td', { class: 'small muted' },
        p.help || '', p.scope === 'connection' ? h('span', { class: 'badge', style: { marginLeft: '6px' } }, 'this connection only') : null), h('td', { class: 'actions' }, save));
    });
    pragmaCard.querySelector('.card-body').replaceChildren(h('div', { class: 'table-wrap' }, h('table', { class: 'tbl' }, h('tbody', null, rows))));
  }).catch((e) => pragmaCard.querySelector('.card-body').replaceChildren(errorBox(e)));

  container.replaceChildren(
    h('div', { class: 'grid-2' },
      card({
        title: 'File',
        body: h('div', { class: 'col' },
          dbInfo.location ? h('div', { class: 'row small' }, 'Storage:', locationBadge(dbInfo.location),
            currentUser() && dbInfo.location === 'temp'
              ? h('button', { class: 'btn btn-sm btn-primary', onclick: () => saveDb(db) }, icon('save', 14), 'Save to my account') : null) : null,
          h('div', { class: 'row' },
            h('button', { class: 'btn', onclick: () => apiDownload('downloadDatabase', { db }).catch((e) => toast(e.message, 'error')) }, icon('download', 15), 'Download .db file'),
            h('a', { class: 'btn', href: href({ db, tab: 'export' }) }, icon('file', 15), 'Export as SQL…')),
          ro || dbInfo.external ? null : h('div', { class: 'row' },
            h('button', { class: 'btn', onclick: () => renameDb(db) }, icon('edit', 15), 'Rename database…'),
            h('button', { class: 'btn', onclick: () => copyDb(db) }, icon('copy', 15), 'Copy database…')),
          ro || !dbInfo.external ? null : h('button', { class: 'btn', onclick: () => copyDb(db) }, icon('copy', 15), 'Copy database…')),
      }),
      card({
        title: 'Maintenance',
        body: h('div', { class: 'col' }, MAINTENANCE.filter(([sql]) => !ro || !/^(VACUUM|ANALYZE|REINDEX|PRAGMA optimize|PRAGMA wal)/.test(sql)).map(([sql, label, help]) => h('div', { class: 'row nowrap' },
          h('button', { class: 'btn btn-sm', style: { minWidth: '140px' }, onclick: () => runMaintenance(sql, label) }, label),
          h('span', { class: 'small muted' }, help)))),
      })),
    h('div', { class: 'mt' }, out),
    pragmaCard,
    ro || dbInfo.external ? null : card({
      title: 'Danger zone',
      className: 'danger-zone',
      body: h('div', { class: 'row' }, h('span', { class: 'grow' }, 'Delete this database file permanently.'),
        h('button', { class: 'btn btn-danger solid', onclick: () => deleteDb(db) }, icon('trash', 15), 'Delete database')),
    }));
}
