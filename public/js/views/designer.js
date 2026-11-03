// Table designer: create a new table or change the structure of an existing one.
import {
  h, icon, card, toast, qi, select, openModal, highlightSql, errorBox, confirmDialog,
} from '../util.js';
import { api } from '../api.js';
import {
  href, go, isReadOnly, execSql, schemaChanged, loadSchema, state,
} from '../app.js';
import { createSqlEditor } from '../sqleditor.js';

export const TYPE_SUGGESTIONS = ['INTEGER', 'TEXT', 'REAL', 'BLOB', 'NUMERIC', 'BOOLEAN', 'DATE', 'DATETIME',
  'TIMESTAMP', 'VARCHAR(255)', 'CHAR(10)', 'DECIMAL(10,2)', 'JSON', 'ANY'];
const FK_ACTIONS = ['NO ACTION', 'CASCADE', 'SET NULL', 'SET DEFAULT', 'RESTRICT'];

let datalistAdded = false;
/** A text input with type suggestions. */
export function typeInput(value = '', attrs = {}) {
  if (!datalistAdded) {
    document.body.append(h('datalist', { id: 'sqla-types' }, TYPE_SUGGESTIONS.map((t) => h('option', { value: t }))));
    datalistAdded = true;
  }
  return h('input', { type: 'text', list: 'sqla-types', value, placeholder: 'type', ...attrs });
}

/** Render a DEFAULT value: keep SQL expressions/literals, quote plain text. */
export function defaultExpr(v) {
  const s = String(v).trim();
  if (/^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(s) || /^'.*'$/s.test(s) || /^\(.*\)$/s.test(s)
    || /^(NULL|TRUE|FALSE|CURRENT_TIMESTAMP|CURRENT_DATE|CURRENT_TIME)$/i.test(s) || /^x'[0-9a-f]*'$/i.test(s)) return s;
  return `'${s.replace(/'/g, "''")}'`;
}

export function columnDefSql(c, { inlinePk = true } = {}) {
  let s = qi(c.name);
  if (c.type && c.type.trim()) s += ` ${c.type.trim()}`;
  if (c.pk && inlinePk) {
    s += ' PRIMARY KEY';
    if (c.autoincrement) s += ' AUTOINCREMENT';
  }
  if (c.notnull) s += ' NOT NULL';
  if (c.unique) s += ' UNIQUE';
  if (c.default !== undefined && c.default !== null && String(c.default).trim() !== '') s += ` DEFAULT ${defaultExpr(c.default)}`;
  if (c.extra && c.extra.trim()) s += ` ${c.extra.trim()}`;
  return s;
}

export function createTableSql(model) {
  const cols = model.columns.filter((c) => c.name.trim());
  const pk = cols.filter((c) => c.pk);
  const multiPk = pk.length > 1;
  const defs = cols.map((c) => columnDefSql(c, { inlinePk: !multiPk }));
  if (multiPk) defs.push(`PRIMARY KEY (${pk.map((c) => qi(c.name)).join(', ')})`);
  defs.push(...model.constraints.map((c) => c.trim()).filter(Boolean));
  const opts = [model.withoutRowid ? 'WITHOUT ROWID' : null, model.strict ? 'STRICT' : null].filter(Boolean).join(', ');
  return `CREATE TABLE ${qi(model.name || 'new_table')} (\n  ${defs.join(',\n  ')}\n)${opts ? ' ' + opts : ''}`;
}

function validate(model) {
  const problems = [];
  if (!model.name.trim()) problems.push('The table needs a name.');
  const cols = model.columns.filter((c) => c.name.trim());
  if (!cols.length) problems.push('Add at least one column.');
  const seen = new Set();
  for (const c of cols) {
    const k = c.name.trim().toLowerCase();
    if (seen.has(k)) problems.push(`Duplicate column name: ${c.name}`);
    seen.add(k);
  }
  const pk = cols.filter((c) => c.pk);
  if (cols.some((c) => c.autoincrement) && (pk.length !== 1 || !/^INTEGER$/i.test(pk[0].type.trim()) || !pk[0].autoincrement)) {
    problems.push('AUTOINCREMENT requires a single INTEGER PRIMARY KEY column.');
  }
  if (model.withoutRowid && !pk.length && !model.constraints.some((c) => /^\s*(CONSTRAINT\s+\S+\s+)?PRIMARY\s+KEY/i.test(c))) {
    problems.push('WITHOUT ROWID tables need a PRIMARY KEY.');
  }
  if (model.withoutRowid && cols.some((c) => c.autoincrement)) problems.push('AUTOINCREMENT is not allowed on WITHOUT ROWID tables.');
  return problems;
}

/** Dialog that builds a FOREIGN KEY clause. Resolves to the clause text or null. */
export function foreignKeyDialog(localColumns, preset = {}) {
  return new Promise((resolve) => {
    let result = null;
    const tables = (state.schema ? state.schema.tables : []).filter((t) => t.type === 'table' && !t.system);
    const localSel = select(localColumns, preset.column || localColumns[0]);
    const tableSel = select(tables.map((t) => t.name), preset.table || (tables[0] && tables[0].name));
    const refSel = h('select');
    const fillRef = () => {
      const t = tables.find((x) => x.name === tableSel.value);
      const cols = t ? t.columns : [];
      const pk = cols.find((c) => c.pk);
      refSel.replaceChildren(...cols.map((c) => h('option', { value: c.name, selected: pk && c.name === pk.name }, c.name + (c.pk ? ' (PK)' : ''))));
    };
    tableSel.addEventListener('change', fillRef);
    fillRef();
    const onDel = select(FK_ACTIONS, 'NO ACTION');
    const onUpd = select(FK_ACTIONS, 'NO ACTION');
    const clause = () => {
      let s = `FOREIGN KEY (${qi(localSel.value)}) REFERENCES ${qi(tableSel.value)}(${qi(refSel.value)})`;
      if (onDel.value !== 'NO ACTION') s += ` ON DELETE ${onDel.value}`;
      if (onUpd.value !== 'NO ACTION') s += ` ON UPDATE ${onUpd.value}`;
      return s;
    };
    const field = (label, el) => h('div', { class: 'field' }, h('label', null, label), el);
    const m = openModal({
      title: 'Add foreign key',
      body: tables.length ? [field('Column in this table', localSel), h('div', { class: 'row' },
        h('div', { class: 'grow' }, field('References table', tableSel)), h('div', { class: 'grow' }, field('Column', refSel))),
      h('div', { class: 'row' }, h('div', { class: 'grow' }, field('On delete', onDel)), h('div', { class: 'grow' }, field('On update', onUpd)))]
        : h('p', null, 'There are no other tables to reference yet.'),
      footer: [h('button', { class: 'btn', onclick: () => m.close() }, 'Cancel'),
        tables.length ? h('button', { class: 'btn btn-primary', onclick: () => { result = clause(); m.close(); } }, 'Add') : null],
      onClose: () => resolve(result),
    });
  });
}

// ---------------------------------------------------------------------------------------------

export async function renderDesigner(container, route) {
  const { db } = route;
  const editing = route.tab === 'edit';
  if (isReadOnly()) {
    container.replaceChildren(h('div', { class: 'alert alert-warn' }, icon('lock', 16), 'Changing the schema is disabled in read-only mode.'));
    return;
  }
  await loadSchema(db);
  let model;
  let original = null;
  if (editing) {
    original = await api('structure', { db, table: route.table });
    if (original.type !== 'table') throw new Error('Only tables can be edited with the designer.');
    if (!original.model) throw new Error('This table definition cannot be parsed by the designer. Edit it with SQL instead.');
    model = {
      name: original.name,
      withoutRowid: original.model.withoutRowid,
      strict: original.model.strict,
      columns: original.model.columns.map((c) => ({ ...c, orig: c.name })),
      constraints: [...original.model.constraints],
    };
    // A single-column PRIMARY KEY written as a table constraint is shown on the column itself.
    const pkIdx = model.constraints.findIndex((c) => /^\s*PRIMARY\s+KEY\s*\(/i.test(c));
    if (pkIdx >= 0) {
      const names = /\(([^)]*)\)/.exec(model.constraints[pkIdx])[1].split(',').map((s) => s.trim().replace(/^["`[]|["`\]]$/g, ''));
      const cols = names.map((n) => model.columns.find((c) => c.name.toLowerCase() === n.toLowerCase()));
      if (cols.every(Boolean) && !/\b(ASC|DESC|COLLATE|ON\s+CONFLICT)\b/i.test(model.constraints[pkIdx])) {
        cols.forEach((c) => { c.pk = true; });
        model.constraints.splice(pkIdx, 1);
      }
    }
  } else {
    model = {
      name: route.params.name || '',
      withoutRowid: false,
      strict: false,
      columns: [
        { orig: null, name: 'id', type: 'INTEGER', pk: true, autoincrement: false, notnull: false, unique: false, default: '', extra: '' },
        { orig: null, name: '', type: 'TEXT', pk: false, autoincrement: false, notnull: false, unique: false, default: '', extra: '' },
      ],
      constraints: [],
    };
  }

  let manualSql = null;
  const nameInput = h('input', { type: 'text', value: model.name, placeholder: 'table_name', style: { width: '280px' }, 'aria-label': 'Table name', oninput: (e) => { model.name = e.target.value; update(); } });
  const opt = (key, label, help) => h('label', { class: 'check', title: help }, h('input', {
    type: 'checkbox', checked: model[key], onchange: (e) => { model[key] = e.target.checked; update(); },
  }), label);

  const colBody = h('tbody');
  const consBox = h('div', { class: 'col' });
  const previewBox = h('div');
  const problemsBox = h('div');

  function newColumn(preset = {}) {
    return { orig: null, name: '', type: 'TEXT', pk: false, autoincrement: false, notnull: false, unique: false, default: '', extra: '', ...preset };
  }

  function renderColumns() {
    colBody.replaceChildren(...model.columns.map((c, i) => {
      const bind = (key, el, prop = 'value') => {
        el.addEventListener(prop === 'checked' ? 'change' : 'input', () => {
          c[key] = el[prop];
          if (key === 'pk' && !el.checked) c.autoincrement = false;
          if (key === 'autoincrement' && el.checked) { c.pk = true; c.type = 'INTEGER'; renderColumns(); }
          if (key === 'pk') renderColumns();
          update();
        });
        return el;
      };
      const chk = (key, title, disabled = false) => h('td', { class: 'c' }, bind(key, h('input', { type: 'checkbox', checked: c[key], title, 'aria-label': `${title} for ${c.name || 'column'}`, disabled }), 'checked'));
      const renamed = c.orig && c.orig !== c.name;
      return h('tr', { dataset: { index: i } },
        h('td', { class: 'nowrap' },
          h('button', { class: 'icon-btn sm', title: 'Move up', disabled: i === 0, onclick: () => { model.columns.splice(i - 1, 0, model.columns.splice(i, 1)[0]); renderColumns(); update(); } }, icon('arrow-up', 13)),
          h('button', { class: 'icon-btn sm', title: 'Move down', disabled: i === model.columns.length - 1, onclick: () => { model.columns.splice(i + 1, 0, model.columns.splice(i, 1)[0]); renderColumns(); update(); } }, icon('arrow-down', 13))),
        h('td', { style: { minWidth: '150px' } }, bind('name', h('input', { type: 'text', value: c.name, placeholder: 'column_name', 'aria-label': 'Column name', class: 'input-sm' })),
          editing ? h('div', { class: 'small muted' }, c.orig ? (renamed ? `renamed from ${c.orig}` : '') : h('span', { class: 'success-text' }, 'new column')) : null),
        h('td', { style: { minWidth: '130px' } }, bind('type', typeInput(c.type, { class: 'input-sm', 'aria-label': 'Type' }))),
        chk('pk', 'Primary key'),
        chk('autoincrement', 'AUTOINCREMENT', !(c.pk && model.columns.filter((x) => x.pk).length === 1)),
        chk('notnull', 'NOT NULL'),
        chk('unique', 'UNIQUE'),
        h('td', { style: { minWidth: '120px' } }, bind('default', h('input', { type: 'text', value: c.default, placeholder: 'none', class: 'input-sm', 'aria-label': 'Default', title: "Numbers, NULL, CURRENT_TIMESTAMP and (expressions) are used as-is; other text is quoted." }))),
        h('td', { style: { minWidth: '200px' } }, bind('extra', h('input', { type: 'text', value: c.extra, placeholder: "e.g. CHECK (x > 0) COLLATE NOCASE", class: 'input-sm mono', 'aria-label': 'Other constraints' }))),
        h('td', { class: 'nowrap' },
          h('button', {
            class: 'icon-btn sm', title: 'Add foreign key for this column',
            onclick: async () => {
              if (!c.name.trim()) { toast('Name the column first', 'error'); return; }
              const fk = await foreignKeyDialog(model.columns.filter((x) => x.name.trim()).map((x) => x.name), { column: c.name });
              if (fk) { model.constraints.push(fk); renderConstraints(); update(); }
            },
          }, icon('link', 14)),
          h('button', {
            class: 'icon-btn sm danger', title: 'Remove column',
            onclick: () => { model.columns.splice(i, 1); renderColumns(); update(); },
          }, icon('trash', 14))));
    }));
    const focus = route.params.focus && colBody.querySelector(`tr[data-index="${model.columns.findIndex((c) => c.orig === route.params.focus)}"] input[type=text]`);
    if (focus) { focus.focus(); route.params.focus = null; }
  }

  function renderConstraints() {
    consBox.replaceChildren(...model.constraints.map((c, i) => h('div', { class: 'row nowrap' },
      h('input', { type: 'text', class: 'grow mono input-sm', value: c, 'aria-label': 'Table constraint', oninput: (e) => { model.constraints[i] = e.target.value; update(); } }),
      h('button', { class: 'icon-btn sm danger', title: 'Remove constraint', onclick: () => { model.constraints.splice(i, 1); renderConstraints(); update(); } }, icon('trash', 14)))),
    model.constraints.length ? null : h('p', { class: 'muted small' }, 'No table-level constraints. Use these for composite keys, multi-column UNIQUE and CHECK rules, and foreign keys.'));
  }

  function update() {
    const sql = createTableSql(model);
    const problems = validate(model);
    problemsBox.replaceChildren(...problems.map((p) => h('div', { class: 'small danger-text' }, icon('alert', 13), ' ', p)));
    if (manualSql === null) {
      const pre = h('pre', { class: 'code' });
      pre.innerHTML = highlightSql(sql);
      previewBox.replaceChildren(pre);
    }
    saveBtn.disabled = manualSql === null && problems.length > 0;
  }

  const saveBtn = h('button', { class: 'btn btn-primary', onclick: save }, icon('save', 15), editing ? 'Save changes' : 'Create table');
  const manualBtn = h('button', {
    class: 'btn btn-sm',
    onclick: () => {
      if (manualSql === null) {
        manualSql = createSqlEditor({ value: createTableSql(model), height: 220, schema: () => state.schema });
        previewBox.replaceChildren(h('div', { class: 'alert alert-warn' }, icon('info', 16), 'You are editing the SQL directly. Designer changes are ignored until you switch back.'), manualSql.el);
        manualBtn.textContent = 'Back to designer';
      } else {
        manualSql = null;
        manualBtn.textContent = 'Edit SQL manually';
      }
      update();
    },
  }, 'Edit SQL manually');

  async function save() {
    const sql = manualSql ? manualSql.getValue() : createTableSql(model);
    if (!editing) {
      try {
        await execSql(db, sql, { successMessage: 'Table created' });
        const name = /^\s*CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?("(?:[^"]|"")+"|\S+)/i.exec(sql);
        const created = name ? name[1].replace(/^"|"$/g, '').replace(/""/g, '"') : model.name;
        go({ db, table: created, tab: 'structure' });
      } catch (e) {
        problemsBox.replaceChildren(errorBox(e, 'The table could not be created'));
      }
      return;
    }
    const mapping = manualSql
      ? null
      : model.columns.filter((c) => c.name.trim()).map((c) => ({ to: c.name.trim(), from: c.orig }));
    const dropped = original.columns.filter((c) => c.hidden !== 1 && !model.columns.some((m) => m.orig === c.name)).map((c) => c.name);
    const ok = await confirmDialog({
      title: 'Apply structure changes?',
      message: h('div', null,
        h('p', null, 'SQLite applies these changes by rebuilding the table: a new table is created, the data is copied over, the old table is dropped and its indexes and triggers are recreated — all in one transaction.'),
        dropped.length ? h('p', { class: 'danger-text' }, `Data in removed column(s) will be lost: ${dropped.join(', ')}`) : null,
        manualSql ? h('p', { class: 'small muted' }, 'Columns are matched by name because the SQL was edited manually.') : null),
      sql, okLabel: 'Rebuild table', danger: dropped.length > 0,
    });
    if (!ok) return;
    try {
      const r = await api('rebuildTable', { db, table: original.name, createSql: sql, mapping });
      await schemaChanged(db);
      toast('Table structure updated', 'success');
      for (const w of r.warnings) toast(w, 'error', { timeout: 15000 });
      go({ db, table: r.table, tab: 'structure' });
    } catch (e) {
      problemsBox.replaceChildren(errorBox(e, 'The structure could not be changed (nothing was modified)'));
    }
  }

  renderColumns();
  renderConstraints();

  container.replaceChildren(
    h('h1', null, editing ? `Edit structure of ${original.name}` : 'Create table'),
    editing ? h('div', { class: 'alert alert-info' }, icon('info', 16), h('div', { class: 'grow' },
      'Simple changes such as adding or renaming a column can also be made from the ',
      h('a', { href: href({ db, table: route.table, tab: 'structure' }) }, 'Structure'), ' tab without rebuilding the table.')) : null,
    card({
      title: 'Table',
      body: h('div', { class: 'row' }, h('label', null, 'Name'), nameInput,
        opt('withoutRowid', 'WITHOUT ROWID', 'Store rows clustered by the primary key, without a rowid.'),
        opt('strict', 'STRICT', 'Enforce column types (SQLite 3.37+).')),
    }),
    card({
      title: 'Columns',
      actions: [
        h('button', { class: 'btn btn-sm', onclick: () => { model.columns.push(newColumn()); renderColumns(); update(); colBody.lastElementChild.querySelector('input[type=text]').focus(); } }, icon('plus', 14), 'Add column'),
        h('button', { class: 'btn btn-sm', title: 'created_at TEXT DEFAULT CURRENT_TIMESTAMP', onclick: () => { model.columns.push(newColumn({ name: 'created_at', type: 'TEXT', default: 'CURRENT_TIMESTAMP' })); renderColumns(); update(); } }, '+ created_at'),
      ],
      flush: true,
      body: h('div', { class: 'table-wrap', style: { padding: '4px 8px' } }, h('table', { class: 'designer-table' },
        h('thead', null, h('tr', null, h('th'), h('th', null, 'Name'), h('th', null, 'Type'), h('th', { title: 'Primary key' }, 'PK'),
          h('th', { title: 'AUTOINCREMENT' }, 'AI'), h('th', { title: 'NOT NULL' }, 'NN'), h('th', { title: 'UNIQUE' }, 'UQ'),
          h('th', null, 'Default'), h('th', null, 'Other constraints'), h('th'))),
        colBody)),
    }),
    card({
      title: 'Table constraints',
      actions: [
        h('button', {
          class: 'btn btn-sm', onclick: async () => {
            const fk = await foreignKeyDialog(model.columns.filter((x) => x.name.trim()).map((x) => x.name));
            if (fk) { model.constraints.push(fk); renderConstraints(); update(); }
          },
        }, icon('link', 14), 'Foreign key…'),
        h('button', { class: 'btn btn-sm', onclick: () => { model.constraints.push('UNIQUE ()'); renderConstraints(); update(); } }, '+ UNIQUE'),
        h('button', { class: 'btn btn-sm', onclick: () => { model.constraints.push('CHECK ()'); renderConstraints(); update(); } }, '+ CHECK'),
      ],
      body: consBox,
    }),
    card({ title: 'SQL', actions: manualBtn, body: previewBox }),
    problemsBox,
    h('div', { class: 'row mt' }, saveBtn,
      h('a', { class: 'btn', href: editing ? href({ db, table: route.table, tab: 'structure' }) : href({ db }) }, 'Cancel')));
  update();
  if (!editing) nameInput.focus();
}
