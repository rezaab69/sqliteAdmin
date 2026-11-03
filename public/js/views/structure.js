// Table/view level: Structure tab (columns, indexes, keys, triggers) and Operations tab.
import {
  h, icon, card, toast, fmtNum, fmtBytes, qi, select, openModal, highlightSql, codeBlock, copyText,
  promptDialog, confirmDialog, errorBox, loading, plural,
} from '../util.js';
import { api } from '../api.js';
import {
  href, go, isReadOnly, execSql, confirmRun, schemaChanged, state,
} from '../app.js';
import { createSqlEditor } from '../sqleditor.js';
import { columnDefSql, typeInput } from './designer.js';
import { resultGrid } from '../grid.js';

const sqlStr = (s) => `'${String(s).replace(/'/g, "''")}'`;

function sqlPreview(getSql) {
  const pre = h('pre', { class: 'code' });
  const refresh = () => { pre.innerHTML = highlightSql(getSql()); };
  refresh();
  return { el: pre, refresh };
}

// ---------------------------------------------------------------------------------------------
// Dialogs

function addColumnDialog(db, table) {
  const col = { name: '', type: 'TEXT', notnull: false, unique: false, default: '', extra: '' };
  const sql = () => `ALTER TABLE ${qi(table)} ADD COLUMN ${columnDefSql(col)}`;
  const preview = sqlPreview(sql);
  const bind = (key, el, prop = 'value') => {
    el.addEventListener(prop === 'checked' ? 'change' : 'input', () => { col[key] = el[prop]; preview.refresh(); });
    return el;
  };
  const field = (label, el, hint) => h('div', { class: 'field' }, h('label', null, label), el, hint ? h('div', { class: 'hint' }, hint) : null);
  const err = h('div');
  const m = openModal({
    title: `Add column to ${table}`,
    size: 'wide',
    body: [
      h('div', { class: 'row' },
        h('div', { class: 'grow' }, field('Name', bind('name', h('input', { type: 'text', class: 'w-full', autofocus: true })))),
        h('div', { class: 'grow' }, field('Type', bind('type', typeInput('TEXT', { class: 'w-full' }))))),
      h('div', { class: 'row mb' },
        h('label', { class: 'check' }, bind('notnull', h('input', { type: 'checkbox' }), 'checked'), 'NOT NULL'),
        h('label', { class: 'check', title: 'SQLite cannot add a UNIQUE column with ALTER TABLE; create a unique index instead.' },
          h('input', { type: 'checkbox', disabled: true }), h('span', { class: 'muted' }, 'UNIQUE (use a unique index)'))),
      field('Default', bind('default', h('input', { type: 'text', class: 'w-full', placeholder: 'none' })), 'Required when NOT NULL is set on a table that already has rows.'),
      field('Other constraints', bind('extra', h('input', { type: 'text', class: 'w-full mono', placeholder: 'e.g. REFERENCES other(id) or CHECK (x > 0)' }))),
      h('p', { class: 'muted small' }, 'SQLite always appends new columns at the end. To choose the position, use Edit structure.'),
      preview.el, err],
    footer: [h('button', { class: 'btn', onclick: () => m.close() }, 'Cancel'), h('button', {
      class: 'btn btn-primary', onclick: async () => {
        if (!col.name.trim()) { err.replaceChildren(h('p', { class: 'danger-text' }, 'Enter a column name.')); return; }
        try {
          await execSql(db, sql(), { successMessage: `Column ${col.name} added` });
          m.close();
          go(state.route);
        } catch (e) { err.replaceChildren(errorBox(e)); }
      },
    }, 'Add column')],
  });
}

function createIndexDialog(db, table, columns, preset = {}) {
  const chosen = new Map((preset.columns || []).map((c) => [c, 'ASC']));
  const nameInput = h('input', { type: 'text', class: 'w-full' });
  const unique = h('input', { type: 'checkbox', checked: !!preset.unique });
  const where = h('input', { type: 'text', class: 'w-full mono', placeholder: 'optional, e.g. deleted_at IS NULL' });
  let nameTouched = false;
  const autoName = () => `${unique.checked ? 'ux' : 'idx'}_${table}_${[...chosen.keys()].join('_') || 'cols'}`.replace(/[^\w]+/g, '_');
  const sql = () => `CREATE ${unique.checked ? 'UNIQUE ' : ''}INDEX ${qi(nameInput.value || autoName())} ON ${qi(table)} (${[...chosen].map(([c, d]) => `${qi(c)}${d === 'DESC' ? ' DESC' : ''}`).join(', ')})${where.value.trim() ? ` WHERE ${where.value.trim()}` : ''}`;
  const preview = sqlPreview(sql);
  const refresh = () => {
    if (!nameTouched) nameInput.value = autoName();
    preview.refresh();
  };
  nameInput.addEventListener('input', () => { nameTouched = true; preview.refresh(); });
  unique.addEventListener('change', refresh);
  where.addEventListener('input', refresh);
  const list = h('div', { class: 'col', style: { gap: '4px', maxHeight: '240px', overflow: 'auto' } }, columns.map((c) => {
    const cb = h('input', { type: 'checkbox', checked: chosen.has(c) });
    const dir = select(['ASC', 'DESC'], chosen.get(c) || 'ASC', { class: 'input-sm' });
    cb.addEventListener('change', () => { if (cb.checked) chosen.set(c, dir.value); else chosen.delete(c); refresh(); });
    dir.addEventListener('change', () => { if (chosen.has(c)) chosen.set(c, dir.value); refresh(); });
    return h('div', { class: 'row nowrap' }, h('label', { class: 'check grow' }, cb, c), dir);
  }));
  refresh();
  const err = h('div');
  const m = openModal({
    title: `Create index on ${table}`,
    size: 'wide',
    body: [h('div', { class: 'field' }, h('label', null, 'Index name'), nameInput),
      h('label', { class: 'check mb' }, unique, 'Unique'),
      h('div', { class: 'field' }, h('label', null, 'Columns (in the order you tick them)'), list),
      h('div', { class: 'field' }, h('label', null, 'WHERE (partial index)'), where),
      preview.el, err],
    footer: [h('button', { class: 'btn', onclick: () => m.close() }, 'Cancel'), h('button', {
      class: 'btn btn-primary', onclick: async () => {
        if (!chosen.size) { err.replaceChildren(h('p', { class: 'danger-text' }, 'Choose at least one column.')); return; }
        try {
          await execSql(db, sql(), { successMessage: 'Index created' });
          m.close();
          go(state.route);
        } catch (e) { err.replaceChildren(errorBox(e)); }
      },
    }, 'Create index')],
  });
}

function createTriggerDialog(db, table, columns, isView) {
  const name = h('input', { type: 'text', class: 'w-full', value: `trg_${table}_` });
  const timing = select(isView ? ['INSTEAD OF'] : ['AFTER', 'BEFORE'], isView ? 'INSTEAD OF' : 'AFTER');
  const event = select(['INSERT', 'UPDATE', 'DELETE'], 'INSERT');
  const ofCols = h('input', { type: 'text', class: 'w-full', placeholder: `optional: ${columns.slice(0, 2).join(', ')}`, disabled: true });
  const when = h('input', { type: 'text', class: 'w-full mono', placeholder: 'optional, e.g. NEW.price <> OLD.price' });
  const editor = createSqlEditor({
    value: `-- Use NEW.column and OLD.column to refer to the row.\nUPDATE ${qi(table)} SET updated_at = CURRENT_TIMESTAMP WHERE rowid = NEW.rowid;`,
    height: 150, schema: () => state.schema,
  });
  event.addEventListener('change', () => { ofCols.disabled = event.value !== 'UPDATE'; });
  const sql = () => {
    const body = editor.getValue().trim().replace(/;?\s*$/, ';');
    const of = event.value === 'UPDATE' && ofCols.value.trim() ? ` OF ${ofCols.value.split(',').map((s) => qi(s.trim())).join(', ')}` : '';
    return `CREATE TRIGGER ${qi(name.value)}\n${timing.value} ${event.value}${of} ON ${qi(table)}\nFOR EACH ROW${when.value.trim() ? `\nWHEN ${when.value.trim()}` : ''}\nBEGIN\n  ${body.replace(/\n/g, '\n  ')}\nEND`;
  };
  const err = h('div');
  const field = (label, el) => h('div', { class: 'field grow' }, h('label', null, label), el);
  const m = openModal({
    title: `Create trigger on ${table}`,
    size: 'wide',
    body: [field('Name', name), h('div', { class: 'row' }, field('Timing', timing), field('Event', event), field('Of columns (UPDATE only)', ofCols)),
      field('When', when), h('div', { class: 'field' }, h('label', null, 'Statements'), editor.el), err],
    footer: [h('button', { class: 'btn', onclick: () => m.close() }, 'Cancel'), h('button', {
      class: 'btn btn-primary', onclick: async () => {
        try {
          await execSql(db, sql(), { successMessage: 'Trigger created' });
          m.close();
          go(state.route);
        } catch (e) { err.replaceChildren(errorBox(e, 'Could not create the trigger'), codeBlock(sql())); }
      },
    }, 'Create trigger')],
  });
}

function editViewDialog(db, name, sql) {
  const editor = createSqlEditor({ value: sql, height: 260, schema: () => state.schema });
  const err = h('div');
  const m = openModal({
    title: `Edit view ${name}`,
    size: 'wide',
    body: [h('p', { class: 'muted small' }, 'The view is dropped and recreated in a single transaction.'), editor.el, err],
    footer: [h('button', { class: 'btn', onclick: () => m.close() }, 'Cancel'), h('button', {
      class: 'btn btn-primary', onclick: async () => {
        const newSql = editor.getValue().trim().replace(/;\s*$/, '');
        try {
          await execSql(db, `BEGIN;\nDROP VIEW ${qi(name)};\n${newSql};\nCOMMIT;`, { successMessage: 'View updated' });
          m.close();
          const n = /^\s*CREATE\s+(?:TEMP\w*\s+)?VIEW\s+(?:IF\s+NOT\s+EXISTS\s+)?("(?:[^"]|"")+"|[\w$]+)/i.exec(newSql);
          go({ db, table: n ? n[1].replace(/^"|"$/g, '').replace(/""/g, '"') : name, tab: 'structure' });
        } catch (e) { err.replaceChildren(errorBox(e)); }
      },
    }, 'Save view')],
  });
}

// ---------------------------------------------------------------------------------------------
// Structure tab

export async function renderStructure(container, route) {
  const { db, table } = route;
  const s = await api('structure', { db, table });
  const ro = isReadOnly();
  const isTable = s.type === 'table';
  const isView = s.type === 'view';
  const canAlter = isTable && !ro;
  const visibleCols = s.columns.filter((c) => c.hidden !== 1);
  const fkByCol = new Map();
  for (const fk of s.foreignKeys) fk.from.forEach((f, i) => fkByCol.set(f, `${fk.table}(${fk.to[i]})`));
  const uniqueCols = new Set(s.indexes.filter((i) => i.unique && i.columns.length === 1).map((i) => i.columns[0].name));
  const indexedCols = new Set(s.indexes.flatMap((i) => i.columns.map((c) => c.name)));

  const renameColumn = async (c) => {
    const to = await promptDialog({ title: `Rename column ${c.name}`, label: 'New name', value: c.name, okLabel: 'Rename' });
    if (!to || to === c.name) return;
    try {
      await execSql(db, `ALTER TABLE ${qi(s.name)} RENAME COLUMN ${qi(c.name)} TO ${qi(to)}`, { successMessage: 'Column renamed' });
      go(route);
    } catch (e) { toast(e.message, 'error', { sql: e.sql }); }
  };
  const dropColumn = async (c) => {
    const r = await confirmDialog({
      title: `Drop column ${c.name}`,
      message: h('div', null, h('p', null, 'The column and all of its data will be removed.'),
        h('p', { class: 'muted small' }, 'SQLite refuses to drop columns that are part of a key, index or constraint. In that case use Edit structure, which rebuilds the table.')),
      sql: `ALTER TABLE ${qi(s.name)} DROP COLUMN ${qi(c.name)}`, okLabel: 'Drop column', danger: true,
    });
    if (!r) return;
    try {
      await execSql(db, `ALTER TABLE ${qi(s.name)} DROP COLUMN ${qi(c.name)}`, { successMessage: `Column ${c.name} dropped` });
      go(route);
    } catch (e) {
      const t = toast(h('span', null, e.message, ' ', h('a', { href: href({ db, table: s.name, tab: 'edit' }) }, 'Use Edit structure instead')), 'error');
      t.querySelector('a').addEventListener('click', () => t.remove());
    }
  };

  const colRows = visibleCols.map((c, i) => h('tr', null,
    h('td', { class: 'muted' }, i + 1),
    h('td', null, h('strong', null, c.name), c.pk ? h('span', { title: 'Primary key', style: { marginLeft: '6px' } }, icon('key', 13, 'hl-str')) : null),
    h('td', { class: 'mono' }, c.type || h('span', { class: 'muted' }, '(none)')),
    h('td', null, c.notnull ? 'No' : 'Yes'),
    h('td', { class: 'mono small' }, c.dflt_value ?? h('span', { class: 'muted' }, c.notnull ? '—' : 'NULL')),
    h('td', null,
      c.pk ? h('span', { class: 'badge amber' }, c.pk > 1 || s.columns.filter((x) => x.pk).length > 1 ? `PK ${c.pk}` : 'PRIMARY') : null, ' ',
      uniqueCols.has(c.name) ? h('span', { class: 'badge blue' }, 'UNIQUE') : null, ' ',
      !c.pk && !uniqueCols.has(c.name) && indexedCols.has(c.name) ? h('span', { class: 'badge' }, 'INDEX') : null),
    h('td', { class: 'small' },
      c.hidden === 2 ? h('span', { class: 'badge green' }, 'GENERATED VIRTUAL') : c.hidden === 3 ? h('span', { class: 'badge green' }, 'GENERATED STORED') : null,
      c.pk && s.autoincrement ? h('span', { class: 'badge' }, 'AUTOINCREMENT') : null,
      fkByCol.has(c.name) ? h('span', { class: 'mono' }, '→ ', fkByCol.get(c.name)) : null),
    canAlter ? h('td', { class: 'actions' },
      h('a', { class: 'icon-btn sm', title: 'Change type/constraints (Edit structure)', href: href({ db, table: s.name, tab: 'edit', params: { focus: c.name } }) }, icon('tool', 14)),
      h('button', { class: 'icon-btn sm', title: 'Rename', onclick: () => renameColumn(c) }, icon('edit', 14)),
      h('button', { class: 'icon-btn sm', title: 'Add index', onclick: () => createIndexDialog(db, s.name, visibleCols.map((x) => x.name), { columns: [c.name] }) }, icon('index', 14)),
      h('button', { class: 'icon-btn sm', title: 'Add unique index', onclick: () => createIndexDialog(db, s.name, visibleCols.map((x) => x.name), { columns: [c.name], unique: true }) }, 'U'),
      h('button', { class: 'icon-btn sm danger', title: 'Drop column', onclick: () => dropColumn(c) }, icon('trash', 14))) : null));

  const badges = h('div', { class: 'row mb' },
    h('span', { class: 'badge blue' }, s.type.toUpperCase()),
    s.rowCount !== null ? h('span', { class: 'badge' }, plural(s.rowCount, 'row')) : null,
    s.size !== null && isTable ? h('span', { class: 'badge' }, fmtBytes(s.size)) : null,
    s.withoutRowid ? h('span', { class: 'badge amber' }, 'WITHOUT ROWID') : null,
    s.strict ? h('span', { class: 'badge green' }, 'STRICT') : null,
    s.autoincrement ? h('span', { class: 'badge' }, 'AUTOINCREMENT') : null,
    isTable ? h('span', { class: 'badge', title: 'How rows are identified for editing' },
      s.key.kind === 'rowid' ? 'rows identified by rowid' : s.key.kind === 'pk' ? `rows identified by ${s.key.cols.join(', ')}` : 'no row identifier') : null);

  const parts = [badges, card({
    title: `Columns (${visibleCols.length})`,
    actions: canAlter ? [
      h('button', { class: 'btn btn-sm btn-primary', onclick: () => addColumnDialog(db, s.name) }, icon('plus', 14), 'Add column'),
      s.model ? h('a', { class: 'btn btn-sm', href: href({ db, table: s.name, tab: 'edit' }) }, icon('edit', 14), 'Edit structure') : null,
    ] : isView && !ro ? [h('button', { class: 'btn btn-sm', onclick: () => editViewDialog(db, s.name, s.sql) }, icon('edit', 14), 'Edit view')] : null,
    flush: true,
    body: h('div', { class: 'table-wrap' }, h('table', { class: 'tbl' },
      h('thead', null, h('tr', null, h('th', null, '#'), h('th', null, 'Name'), h('th', null, 'Type'), h('th', null, 'Null'),
        h('th', null, 'Default'), h('th', null, 'Key'), h('th', null, 'Extra'), canAlter ? h('th', null, 'Actions') : null)),
      h('tbody', null, colRows))),
  })];

  if (isTable) {
    parts.push(card({
      title: `Indexes (${s.indexes.length})`,
      actions: canAlter ? h('button', { class: 'btn btn-sm', onclick: () => createIndexDialog(db, s.name, visibleCols.map((x) => x.name)) }, icon('plus', 14), 'Create index') : null,
      flush: true,
      body: s.indexes.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'tbl' },
        h('thead', null, h('tr', null, h('th', null, 'Name'), h('th', null, 'Columns'), h('th', null, 'Unique'), h('th', null, 'Origin'), canAlter ? h('th') : null)),
        h('tbody', null, s.indexes.map((ix) => h('tr', null,
          h('td', { class: 'mono' }, ix.name),
          h('td', null, ix.columns.map((c) => `${c.name}${c.desc ? ' DESC' : ''}${c.coll && c.coll !== 'BINARY' ? ` COLLATE ${c.coll}` : ''}`).join(', '),
            ix.partial ? h('span', { class: 'badge', style: { marginLeft: '6px' }, title: ix.sql }, 'partial') : null),
          h('td', null, ix.unique ? 'Yes' : 'No'),
          h('td', { class: 'small muted' }, { c: 'CREATE INDEX', u: 'UNIQUE constraint', pk: 'PRIMARY KEY' }[ix.origin] || ix.origin),
          canAlter ? h('td', { class: 'actions' }, ix.origin === 'c' ? h('button', {
            class: 'icon-btn sm danger', title: 'Drop index',
            onclick: async () => { if (await confirmRun(db, `DROP INDEX ${qi(ix.name)}`, { title: 'Drop index', okLabel: 'Drop', danger: true, successMessage: 'Index dropped' })) go(route); },
          }, icon('trash', 14)) : null) : null))))) : h('div', { class: 'card-body muted' }, 'No indexes.'),
    }));

    if (s.foreignKeys.length || s.referencedBy.length) {
      const fkRow = (tableName, from, to, onDelete, onUpdate, dir) => h('tr', null,
        h('td', { class: 'mono' }, dir === 'out' ? from.join(', ') : h('a', { href: href({ db, table: tableName, tab: 'structure' }) }, `${tableName}(${from.join(', ')})`)),
        h('td', null, '→'),
        h('td', { class: 'mono' }, dir === 'out' ? h('a', { href: href({ db, table: tableName, tab: 'structure' }) }, `${tableName}(${to.join(', ')})`) : to.join(', ')),
        h('td', { class: 'small' }, `ON DELETE ${onDelete}`), h('td', { class: 'small' }, `ON UPDATE ${onUpdate}`));
      parts.push(card({
        title: 'Relations',
        actions: canAlter && s.model ? h('a', { class: 'btn btn-sm', href: href({ db, table: s.name, tab: 'edit' }) }, 'Edit foreign keys') : null,
        flush: true,
        body: h('div', { class: 'table-wrap' }, h('table', { class: 'tbl' },
          s.foreignKeys.length ? [h('thead', null, h('tr', null, h('th', { colspan: '5' }, 'References (foreign keys in this table)'))),
            h('tbody', null, s.foreignKeys.map((fk) => fkRow(fk.table, fk.from, fk.to, fk.onDelete, fk.onUpdate, 'out')))] : null,
          s.referencedBy.length ? [h('thead', null, h('tr', null, h('th', { colspan: '5' }, 'Referenced by'))),
            h('tbody', null, s.referencedBy.map((fk) => fkRow(fk.table, fk.from, fk.to, fk.onDelete, fk.onUpdate, 'in')))] : null)),
      }));
    }
  }

  if (isTable || isView) {
    parts.push(card({
      title: `Triggers (${s.triggers.length})`,
      actions: !ro ? h('button', { class: 'btn btn-sm', onclick: () => createTriggerDialog(db, s.name, visibleCols.map((c) => c.name), isView) }, icon('plus', 14), 'Create trigger') : null,
      flush: true,
      body: s.triggers.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'tbl' }, h('tbody', null, s.triggers.map((t) => h('tr', null,
        h('td', { class: 'mono', style: { width: '200px' } }, icon('trigger', 13), ' ', t.name),
        h('td', null, h('pre', { class: 'code', style: { maxHeight: '160px' }, innerHTML: highlightSql(t.sql) })),
        !ro ? h('td', { class: 'actions' }, h('button', {
          class: 'icon-btn sm danger', title: 'Drop trigger',
          onclick: async () => { if (await confirmRun(db, `DROP TRIGGER ${qi(t.name)}`, { title: 'Drop trigger', okLabel: 'Drop', danger: true, successMessage: 'Trigger dropped' })) go(route); },
        }, icon('trash', 14))) : null))))) : h('div', { class: 'card-body muted' }, 'No triggers.'),
    }));
  }

  if (s.sql) {
    parts.push(card({
      title: 'Definition',
      actions: h('button', { class: 'btn btn-sm', onclick: () => copyText(s.sql + ';') }, icon('copy', 14), 'Copy'),
      body: codeBlock(s.sql + ';'),
    }));
  }
  container.replaceChildren(...parts);
}

// ---------------------------------------------------------------------------------------------
// Operations tab

export async function renderTableOperations(container, route) {
  const { db, table } = route;
  const s = await api('structure', { db, table });
  const ro = isReadOnly();
  const isTable = s.type === 'table';
  const out = h('div');
  const parts = [];

  const runAndShow = async (sql, label) => {
    out.replaceChildren(loading(`${label}…`));
    try {
      const r = await execSql(db, sql);
      const res = r.results[0];
      out.replaceChildren(card({
        title: label, flush: !!res.columns,
        body: res.columns ? resultGrid(res.columns, res.rows) : h('div', { class: 'success-text' }, icon('check', 15), ' Done.'),
      }));
    } catch (e) { out.replaceChildren(errorBox(e, label)); }
  };

  if (isTable && !ro) {
    const renameInput = h('input', { type: 'text', value: s.name, style: { width: '260px' } });
    const copyName = h('input', { type: 'text', value: `${s.name}_copy`, style: { width: '260px' } });
    const withData = h('input', { type: 'radio', name: 'copymode', checked: true });
    const structOnly = h('input', { type: 'radio', name: 'copymode' });
    const withIdx = h('input', { type: 'checkbox', checked: true });
    parts.push(h('div', { class: 'grid-2' },
      card({
        title: 'Rename table',
        body: h('div', { class: 'row' }, renameInput, h('button', {
          class: 'btn btn-primary', onclick: async () => {
            const to = renameInput.value.trim();
            if (!to || to === s.name) return;
            try {
              await execSql(db, `ALTER TABLE ${qi(s.name)} RENAME TO ${qi(to)}`, { successMessage: `Renamed to ${to}` });
              go({ db, table: to, tab: 'operations' });
            } catch (e) { toast(e.message, 'error', { sql: e.sql }); }
          },
        }, 'Rename')),
      }),
      card({
        title: 'Copy table',
        body: [h('div', { class: 'row mb' }, copyName),
          h('div', { class: 'row mb' }, h('label', { class: 'check' }, withData, 'Structure and data'), h('label', { class: 'check' }, structOnly, 'Structure only'),
            h('label', { class: 'check' }, withIdx, 'Include indexes')),
          h('button', {
            class: 'btn btn-primary', onclick: async () => {
              try {
                const r = await api('copyTable', { db, table: s.name, newName: copyName.value.trim(), withData: withData.checked, withIndexes: withIdx.checked });
                await schemaChanged(db);
                toast(`Copied to ${r.table}`, 'success', { sql: r.sql });
                go({ db, table: r.table });
              } catch (e) { toast(e.message, 'error'); }
            },
          }, icon('copy', 15), 'Copy')],
      })));
  }

  if (s.type === 'view' && !ro) {
    const matName = h('input', { type: 'text', value: `${s.name}_snapshot`, style: { width: '260px' } });
    parts.push(card({
      title: 'Materialize view',
      body: [h('p', { class: 'muted small' }, 'Create a regular table containing the current result of this view.'),
        h('div', { class: 'row' }, matName, h('button', {
          class: 'btn btn-primary', onclick: async () => {
            try {
              await execSql(db, `CREATE TABLE ${qi(matName.value.trim())} AS SELECT * FROM ${qi(s.name)}`, { successMessage: 'Table created' });
              go({ db, table: matName.value.trim() });
            } catch (e) { toast(e.message, 'error', { sql: e.sql }); }
          },
        }, 'Create table'))],
    }));
  }

  parts.push(card({
    title: 'Maintenance',
    body: h('div', { class: 'row' },
      isTable && !ro ? h('button', { class: 'btn', onclick: () => runAndShow(`ANALYZE ${qi(s.name)}`, 'Analyze') }, 'Analyze') : null,
      isTable && !ro ? h('button', { class: 'btn', onclick: () => runAndShow(`REINDEX ${qi(s.name)}`, 'Reindex') }, 'Reindex') : null,
      isTable ? h('button', { class: 'btn', onclick: () => runAndShow(`PRAGMA integrity_check(${qi(s.name)})`, 'Integrity check') }, 'Integrity check') : null,
      isTable ? h('button', { class: 'btn', onclick: () => runAndShow(`PRAGMA foreign_key_check(${qi(s.name)})`, 'Foreign key check') }, 'Foreign key check') : null,
      h('button', { class: 'btn', onclick: () => runAndShow(`SELECT count(*) AS "rows" FROM ${qi(s.name)}`, 'Count rows') }, 'Count rows')),
  }), out);

  if (!ro) {
    const hasSeq = s.autoincrement;
    const resetSeq = h('input', { type: 'checkbox', checked: true });
    parts.push(card({
      title: 'Danger zone',
      className: 'danger-zone',
      body: h('div', { class: 'col' },
        isTable ? h('div', { class: 'row' }, h('div', { class: 'grow' }, h('strong', null, 'Empty the table'), h('div', { class: 'small muted' }, `Delete all ${fmtNum(s.rowCount)} rows but keep the structure.`),
          hasSeq ? h('label', { class: 'check small mt' }, resetSeq, 'Reset AUTOINCREMENT counter') : null),
        h('button', {
          class: 'btn btn-danger', onclick: async () => {
            const sql = `DELETE FROM ${qi(s.name)};${hasSeq && resetSeq.checked ? `\nDELETE FROM sqlite_sequence WHERE name = ${sqlStr(s.name)};` : ''}`;
            if (await confirmRun(db, sql, { title: `Empty ${s.name}`, okLabel: 'Empty table', danger: true, successMessage: 'Table emptied' })) go(route);
          },
        }, 'Empty')) : null,
        h('div', { class: 'row' }, h('div', { class: 'grow' }, h('strong', null, `Drop the ${s.type}`), h('div', { class: 'small muted' }, 'Permanently remove it together with its indexes and triggers.')),
          h('button', {
            class: 'btn btn-danger solid', onclick: async () => {
              if (await confirmRun(db, `DROP ${s.type === 'view' ? 'VIEW' : 'TABLE'} ${qi(s.name)}`, { title: `Drop ${s.name}`, okLabel: 'Drop', danger: true, successMessage: `${s.name} dropped` })) go({ db });
            },
          }, icon('trash', 15), 'Drop'))),
    }));
  }
  container.replaceChildren(...parts);
}
