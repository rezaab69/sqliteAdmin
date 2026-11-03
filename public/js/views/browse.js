// Table level: Browse (editable data grid), Insert, and Search.
import {
  h, icon, card, toast, fmtNum, fmtMs, fmtBytes, loading, errorBox, store, debounce, showMenu, confirmDialog,
  openModal, renderValue, valueText, isBlob, isNumeric, copyText, select, readFileAsBase64, highlightSql,
  rowsToCsv, rowsToJson, rowsToSql, saveText, qi, sqlLiteral, plural,
} from '../util.js';
import { api, apiBlob } from '../api.js';
import { href, go, browseHref, isReadOnly, execSql } from '../app.js';
import { showValue } from '../grid.js';

export const FILTER_OPS = [
  ['=', '='], ['!=', '≠'], ['<', '<'], ['<=', '≤'], ['>', '>'], ['>=', '≥'],
  ['CONTAINS', 'contains'], ['STARTS WITH', 'starts with'], ['ENDS WITH', 'ends with'],
  ['LIKE', 'LIKE'], ['NOT LIKE', 'NOT LIKE'], ['GLOB', 'GLOB'], ['REGEXP', 'REGEXP'], ['NOT REGEXP', 'NOT REGEXP'],
  ['IN', 'IN (…)'], ['NOT IN', 'NOT IN (…)'], ['BETWEEN', 'BETWEEN'], ['NOT BETWEEN', 'NOT BETWEEN'],
  ['IS NULL', 'IS NULL'], ['IS NOT NULL', 'IS NOT NULL'], ['IS EMPTY', "= ''"], ['IS NOT EMPTY', "≠ ''"],
];
const NO_VALUE_OPS = new Set(['IS NULL', 'IS NOT NULL', 'IS EMPTY', 'IS NOT EMPTY']);
const RANGE_OPS = new Set(['BETWEEN', 'NOT BETWEEN']);

function filterLabel(f) {
  const op = (FILTER_OPS.find(([v]) => v === f.op) || [f.op, f.op])[1];
  if (NO_VALUE_OPS.has(f.op)) return `${f.col} ${op}`;
  const v = f.value === null ? 'NULL' : valueText(f.value);
  if (RANGE_OPS.has(f.op)) return `${f.col} ${op} ${v} AND ${valueText(f.value2)}`;
  return `${f.col} ${op} ${v}`;
}

function parseQ(params) {
  let q = {};
  try { q = JSON.parse(params.q || '{}') || {}; } catch { q = {}; }
  return {
    page: q.page || 1,
    pageSize: q.pageSize || store.get('pageSize', 50),
    sort: Array.isArray(q.sort) ? q.sort : [],
    filters: Array.isArray(q.filters) ? q.filters : [],
    search: q.search || '',
    searchMode: q.searchMode || 'contains',
  };
}

function compactQ(q) {
  const out = {};
  if (q.page > 1) out.page = q.page;
  if (q.pageSize !== store.get('pageSize', 50)) out.pageSize = q.pageSize;
  if (q.sort.length) out.sort = q.sort;
  if (q.filters.length) out.filters = q.filters;
  if (q.search) { out.search = q.search; if (q.searchMode !== 'contains') out.searchMode = q.searchMode; }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Browse

export async function renderBrowse(container, route, { obj }) {
  const { db, table } = route;
  const q = parseQ(route.params);
  const ro = isReadOnly();
  let fullText = store.get('fullText', false);
  let data = null;
  const selected = new Set();

  const info = h('div');
  const toolbar = h('div', { class: 'grid-toolbar' });
  const gridBox = h('div', null, loading());
  const footer = h('div', { class: 'grid-footer' });
  container.replaceChildren(info, toolbar, gridBox, footer);

  const searchInput = h('input', {
    type: 'search', placeholder: 'Search all columns…', value: q.search, 'aria-label': 'Search rows',
    oninput: debounce((e) => { q.search = e.target.value; q.page = 1; load(); }, 350),
  });

  function syncUrl() {
    const c = compactQ(q);
    history.replaceState(null, '', href({ db, table, tab: 'browse', params: Object.keys(c).length ? { q: JSON.stringify(c) } : undefined }));
  }

  async function load() {
    info.querySelector('.spinner-slot')?.replaceChildren(h('span', { class: 'spinner' }));
    try {
      data = await api('browse', { db, table, ...q });
      q.page = data.page;
      selected.clear();
      syncUrl();
      renderAll();
    } catch (e) {
      gridBox.replaceChildren(errorBox(e), q.filters.length || q.search ? h('button', {
        class: 'btn', onclick: () => { q.filters = []; q.search = ''; searchInput.value = ''; load(); },
      }, 'Clear filters') : null);
    }
  }

  function renderAll() {
    renderInfo();
    renderToolbar();
    renderGrid();
    renderFooter();
  }

  function renderInfo() {
    const from = data.total ? (data.page - 1) * data.pageSize + 1 : 0;
    const to = Math.min(data.total, data.page * data.pageSize);
    info.replaceChildren(h('div', { class: 'query-info' },
      h('span', { class: 'success-text' }, icon('check', 14)),
      h('span', null, data.total ? `Rows ${fmtNum(from)}–${fmtNum(to)} of ${fmtNum(data.total)}` : 'No rows', ` · ${fmtMs(data.time)}`),
      h('span', { class: 'sql-inline', title: data.sql, innerHTML: highlightSql(data.sql) }),
      h('a', { class: 'btn btn-sm btn-ghost', href: href({ db, table, tab: 'sql', params: { sql: data.sql.replace(/ LIMIT \d+ OFFSET \d+$/, '') } }), title: 'Open this query in the SQL editor' }, icon('code', 14), 'Edit SQL'),
      h('span', { class: 'spinner-slot' })));
  }

  function renderToolbar() {
    const pages = Math.max(1, Math.ceil(data.total / data.pageSize));
    const pageInput = h('input', {
      type: 'text', value: data.page, 'aria-label': 'Page', class: 'input-sm',
      onchange: (e) => { q.page = Math.max(1, Math.min(pages, Number(e.target.value) || 1)); load(); },
    });
    const nav = (ic, page, title, disabled) => h('button', {
      class: 'icon-btn', title, disabled, onclick: () => { q.page = page; load(); },
    }, icon(ic, 16));
    toolbar.replaceChildren(
      h('div', { class: 'search' }, icon('search', 14), searchInput),
      h('div', { class: 'chips' }, q.filters.map((f, i) => h('span', { class: 'chip' }, filterLabel(f),
        h('button', { title: 'Remove filter', onclick: () => { q.filters.splice(i, 1); q.page = 1; load(); } }, icon('x', 12))))),
      h('button', { class: 'btn btn-sm', onclick: () => addFilterDialog(data.columns, (f) => { q.filters.push(f); q.page = 1; load(); }) }, icon('filter', 14), 'Filter'),
      q.filters.length || q.sort.length ? h('button', {
        class: 'btn btn-sm btn-ghost', onclick: () => { q.filters = []; q.sort = []; q.page = 1; load(); },
      }, 'Reset') : null,
      h('div', { class: 'grow' }),
      h('div', { class: 'pager' },
        nav('chevrons-left', 1, 'First page', data.page <= 1),
        nav('chevron-left', data.page - 1, 'Previous page', data.page <= 1),
        pageInput, h('span', { class: 'muted small' }, `/ ${fmtNum(pages)}`),
        nav('chevron-right', data.page + 1, 'Next page', data.page >= pages),
        nav('chevrons-right', pages, 'Last page', data.page >= pages)),
      select([25, 50, 100, 250, 500, 1000].map((n) => [n, `${n} rows`]), data.pageSize, {
        class: 'input-sm', 'aria-label': 'Rows per page',
        onchange: (e) => { q.pageSize = Number(e.target.value); store.set('pageSize', q.pageSize); q.page = 1; load(); },
      }),
      h('button', {
        class: `btn btn-sm ${fullText ? 'active' : ''}`, title: 'Show full cell contents',
        onclick: () => { fullText = !fullText; store.set('fullText', fullText); renderToolbar(); renderGrid(); },
      }, icon('maximize', 14), fullText ? 'Truncate' : 'Full text'),
      h('button', { class: 'icon-btn', title: 'Refresh', onclick: load }, icon('refresh', 16)),
      data.editable ? h('button', { class: 'btn btn-sm btn-primary', onclick: () => openRowEditor({ db, table, mode: 'insert' }).then((ok) => ok && load()) }, icon('plus', 14), 'Insert') : null);
  }

  function sortState(col) {
    const i = q.sort.findIndex((s) => s.col === col);
    return i < 0 ? null : { ...q.sort[i], index: i };
  }

  function toggleSort(col, multi) {
    const cur = sortState(col);
    const next = !cur ? 'asc' : cur.dir === 'asc' ? 'desc' : null;
    if (!multi) q.sort = [];
    else q.sort = q.sort.filter((s) => s.col !== col);
    if (next) q.sort.push({ col, dir: next });
    q.page = 1;
    load();
  }

  function fetchBlobFor(row, col) {
    return () => apiBlob('blob', { db, table, key: row.k, column: col });
  }

  async function refreshRow(ri) {
    const row = data.rows[ri];
    try {
      const r = await api('getRow', { db, table, key: row.k });
      data.columns.forEach((c, ci) => { if (c.name in r.values) row.v[ci] = r.values[c.name]; });
    } catch { /* row may have moved */ }
  }

  function editableCol(c) {
    return data.editable && !(c.hidden === 2 || c.hidden === 3);
  }

  function startEdit(td, ri, ci) {
    const row = data.rows[ri];
    const col = data.columns[ci];
    const v = row.v[ci];
    if (!editableCol(col) || isBlob(v) || td.classList.contains('editing')) return;
    const text = valueText(v) ?? '';
    const multi = text.includes('\n') || text.length > 60;
    const input = multi
      ? h('textarea', { rows: Math.min(10, Math.max(3, text.split('\n').length + 1)), 'aria-label': col.name })
      : h('input', { type: 'text', 'aria-label': col.name });
    input.value = text;
    if (v === null) input.placeholder = 'NULL';
    td.classList.add('editing');
    td.replaceChildren(input);
    input.focus();
    input.select();
    let done = false;
    const restore = () => {
      td.classList.remove('editing');
      td.replaceChildren(cellContent(row, ci));
    };
    const finish = async (save) => {
      if (done) return;
      done = true;
      const unchanged = input.value === text && !(v === null && input.value !== '');
      if (!save || unchanged) { restore(); return; }
      try {
        const r = await api('updateRow', { db, table, key: row.k, values: { [col.name]: input.value } });
        toast('Row updated', 'success', { sql: r.sql, timeout: 2500 });
        if (data.key.cols.includes(col.name)) { load(); return; }
        await refreshRow(ri);
        restore();
        td.classList.add('flash');
        setTimeout(() => td.classList.remove('flash'), 1300);
      } catch (e) {
        toast(e.message, 'error');
        restore();
      }
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (!multi || e.ctrlKey || e.metaKey)) { e.preventDefault(); finish(true); }
      else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(false); }
      else if (e.key === 'Tab') {
        e.preventDefault();
        const next = e.shiftKey ? td.previousElementSibling : td.nextElementSibling;
        finish(true).then(() => { if (next && next.dataset.ci !== undefined) next.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); });
      }
    });
    input.addEventListener('blur', () => finish(true));
  }

  function cellContent(row, ci) {
    const v = row.v[ci];
    const col = data.columns[ci];
    const frag = document.createDocumentFragment();
    frag.append(renderValue(v, { truncate: fullText ? 0 : 120 }));
    const fk = data.fks[col.name];
    if (fk && v !== null && !isBlob(v)) {
      frag.append(h('a', {
        class: 'fk-link', title: `Go to ${fk.table}.${fk.column} = ${valueText(v)}`,
        href: browseHref(db, fk.table, { filters: [{ col: fk.column, op: '=', value: v }] }),
        onclick: (e) => e.stopPropagation(),
      }, icon('link', 12)));
    }
    return frag;
  }

  async function deleteRows(indexes) {
    const rows = indexes.map((i) => data.rows[i]);
    const ok = await confirmDialog({
      title: `Delete ${plural(rows.length, 'row')}`,
      message: `The selected ${rows.length === 1 ? 'row' : 'rows'} will be permanently deleted from ${table}.`,
      okLabel: 'Delete', danger: true,
    });
    if (!ok) return;
    try {
      const r = await api('deleteRows', { db, table, keys: rows.map((row) => row.k) });
      toast(`${plural(r.changes, 'row')} deleted`, 'success', { sql: r.sql });
      load();
    } catch (e) { toast(e.message, 'error'); }
  }

  function rowValuesObject(row) {
    return Object.fromEntries(data.columns.map((c, ci) => [c.name, row.v[ci]]));
  }

  function cellMenu(e, ri, ci) {
    e.preventDefault();
    const row = data.rows[ri];
    const col = data.columns[ci];
    const v = row.v[ci];
    const addFilter = (op) => { q.filters.push(v === null ? { col: col.name, op: op === '=' ? 'IS NULL' : 'IS NOT NULL' } : { col: col.name, op, value: v }); q.page = 1; load(); };
    showMenu(e.clientX, e.clientY, [
      { label: 'Copy value', icon: 'copy', onClick: () => copyText(valueText(v) ?? 'NULL') },
      { label: 'View value', icon: 'eye', onClick: () => showValue(v, { column: col.name, fetchBlob: isBlob(v) ? fetchBlobFor(row, col.name) : null }) },
      '-',
      { label: `Filter: ${col.name} = this value`, icon: 'filter', onClick: () => addFilter('=') },
      { label: `Filter: ${col.name} ≠ this value`, icon: 'filter', onClick: () => addFilter('!=') },
      data.editable ? '-' : null,
      data.editable && editableCol(col) && !isBlob(v) ? { label: 'Edit cell', icon: 'edit', onClick: () => startEdit(e.target.closest('td'), ri, ci) } : null,
      data.editable && editableCol(col) && v !== null && !col.notnull ? {
        label: 'Set to NULL', icon: 'x', onClick: async () => {
          try {
            const r = await api('updateRow', { db, table, key: row.k, values: { [col.name]: null } });
            toast('Set to NULL', 'success', { sql: r.sql });
            await refreshRow(ri);
            renderGrid();
          } catch (err) { toast(err.message, 'error'); }
        },
      } : null,
      data.editable ? { label: 'Edit row…', icon: 'edit', onClick: () => openRowEditor({ db, table, mode: 'edit', key: row.k }).then((ok) => ok && load()) } : null,
      data.editable ? { label: 'Duplicate row…', icon: 'copy', onClick: () => openRowEditor({ db, table, mode: 'insert', values: rowValuesObject(row) }).then((ok) => ok && load()) } : null,
      data.editable ? { label: 'Delete row', icon: 'trash', danger: true, onClick: () => deleteRows([ri]) } : null,
    ]);
  }

  function renderGrid() {
    if (!data.columns.length) {
      gridBox.replaceChildren(h('div', { class: 'empty' }, 'This object has no columns.'));
      return;
    }
    const editable = data.editable;
    const allBox = h('input', {
      type: 'checkbox', 'aria-label': 'Select all rows', checked: data.rows.length > 0 && selected.size === data.rows.length,
      onchange: (e) => {
        selected.clear();
        if (e.target.checked) data.rows.forEach((_, i) => selected.add(i));
        renderGrid();
        renderFooter();
      },
    });
    const head = h('tr', null,
      editable ? h('th', { class: 'sel' }, allBox) : null,
      editable ? h('th', { class: 'row-actions' }) : null,
      data.columns.map((c) => {
        const s = sortState(c.name);
        const fk = data.fks[c.name];
        return h('th', {
          class: 'sortable',
          title: `${c.name}${c.type ? ` ${c.type}` : ''}${c.pk ? ' · PRIMARY KEY' : ''}${c.notnull ? ' · NOT NULL' : ''}${fk ? ` · → ${fk.table}(${fk.column})` : ''}${c.hidden > 1 ? ' · generated' : ''}\nClick to sort, Shift+click to add to sort`,
          onclick: (e) => toggleSort(c.name, e.shiftKey),
        }, h('div', { class: 'th-inner' },
          c.pk ? icon('key', 12, 'hl-str') : null,
          c.name,
          c.type ? h('span', { class: 'th-type' }, c.type.toLowerCase()) : null,
          fk ? icon('link', 11) : null,
          s ? h('span', { class: 'sort-ind' }, icon(s.dir === 'asc' ? 'arrow-up' : 'arrow-down', 12), q.sort.length > 1 ? s.index + 1 : '') : null));
      }));

    const body = h('tbody');
    data.rows.forEach((row, ri) => {
      const tr = h('tr', { class: selected.has(ri) ? 'selected' : '' });
      if (editable) {
        tr.append(h('td', { class: 'sel' }, h('input', {
          type: 'checkbox', checked: selected.has(ri), 'aria-label': `Select row ${ri + 1}`,
          onchange: (e) => {
            if (e.target.checked) selected.add(ri); else selected.delete(ri);
            tr.classList.toggle('selected', e.target.checked);
            renderFooter();
          },
        })), h('td', { class: 'row-actions nowrap' },
          h('button', { class: 'icon-btn', title: 'Edit row', onclick: () => openRowEditor({ db, table, mode: 'edit', key: row.k }).then((ok) => ok && load()) }, icon('edit', 14)),
          h('button', { class: 'icon-btn', title: 'Duplicate row', onclick: () => openRowEditor({ db, table, mode: 'insert', values: rowValuesObject(row) }).then((ok) => ok && load()) }, icon('copy', 14)),
          h('button', { class: 'icon-btn danger', title: 'Delete row', onclick: () => deleteRows([ri]) }, icon('trash', 14))));
      }
      row.v.forEach((v, ci) => {
        const col = data.columns[ci];
        const td = h('td', {
          class: `${isNumeric(v) ? 'num' : ''} ${editableCol(col) && !isBlob(v) ? 'editable' : ''}`,
          dataset: { ci: String(ci) },
          title: editableCol(col) && !isBlob(v) ? 'Double-click to edit' : null,
          ondblclick: (e) => {
            if (editableCol(col) && !isBlob(v)) startEdit(e.currentTarget, ri, ci);
            else if (!isBlob(v)) showValue(v, { column: col.name });
          },
          oncontextmenu: (e) => cellMenu(e, ri, ci),
        }, cellContent(row, ci));
        if (isBlob(v)) {
          td.addEventListener('click', () => showValue(v, {
            column: col.name, fetchBlob: data.key.kind !== 'none' ? fetchBlobFor(row, col.name) : null,
            actions: data.editable ? [{ label: 'Edit row…', icon: 'edit', onClick: () => openRowEditor({ db, table, mode: 'edit', key: row.k }).then((ok) => ok && load()) }] : [],
          }));
        }
        tr.append(td);
      });
      body.append(tr);
    });

    gridBox.replaceChildren(h('div', { class: 'datagrid-wrap' },
      h('table', { class: `datagrid ${fullText ? 'full-text' : ''}` }, h('thead', null, head), body)),
    data.rows.length ? null : h('div', { class: 'empty' }, q.filters.length || q.search ? 'No rows match the current filters.' : 'This table is empty.',
      data.editable && !q.filters.length && !q.search ? h('div', { class: 'mt' }, h('button', {
        class: 'btn btn-primary', onclick: () => openRowEditor({ db, table, mode: 'insert' }).then((ok) => ok && load()),
      }, icon('plus', 15), 'Insert a row')) : null));
  }

  function renderFooter() {
    const sel = [...selected].sort((a, b) => a - b);
    const rows = sel.map((i) => data.rows[i].v);
    const names = data.columns.map((c) => c.name);
    const exportSel = (fmt) => {
      const base = `${table}-selection`;
      if (fmt === 'csv') saveText(rowsToCsv(names, rows), `${base}.csv`, 'text/csv');
      else if (fmt === 'json') saveText(rowsToJson(names, rows), `${base}.json`, 'application/json');
      else saveText(rowsToSql(table, names, rows), `${base}.sql`, 'application/sql');
    };
    footer.replaceChildren(
      data.editable ? h('div', { class: 'row gap-sm' },
        h('span', { class: 'muted small' }, sel.length ? `${sel.length} selected:` : 'Select rows to act on them'),
        h('button', { class: 'btn btn-sm btn-danger', disabled: !sel.length || ro, onclick: () => deleteRows(sel) }, icon('trash', 14), 'Delete'),
        h('button', {
          class: 'btn btn-sm', disabled: !sel.length,
          onclick: (e) => {
            const r = e.currentTarget.getBoundingClientRect();
            showMenu(r.left, r.bottom + 4, [
              { label: 'CSV', icon: 'file', onClick: () => exportSel('csv') },
              { label: 'JSON', icon: 'file', onClick: () => exportSel('json') },
              { label: 'SQL INSERT statements', icon: 'file', onClick: () => exportSel('sql') },
            ]);
          },
        }, icon('download', 14), 'Export selected', icon('chevron-down', 12))) : null,
      h('div', { class: 'grow' }),
      h('a', {
        class: 'btn btn-sm', href: href({ db, table, tab: 'export', params: { q: JSON.stringify(compactQ(q)) } }),
        title: 'Export every row matching the current filters',
      }, icon('download', 14), `Export ${q.filters.length || q.search ? 'filtered' : 'all'} rows…`));
  }

  await load();
}

// ---------------------------------------------------------------------------------------------
// Filters

export function addFilterDialog(columns, onAdd) {
  const colSel = select(columns.map((c) => [c.name, `${c.name}${c.type ? ` (${c.type})` : ''}`]), columns[0] && columns[0].name);
  const opSel = select(FILTER_OPS, 'CONTAINS');
  const v1 = h('input', { type: 'text', class: 'w-full', placeholder: 'Value' });
  const v2 = h('input', { type: 'text', class: 'w-full', placeholder: 'and…' });
  const hint = h('div', { class: 'hint' });
  const sync = () => {
    const op = opSel.value;
    v1.disabled = NO_VALUE_OPS.has(op);
    v2.hidden = !RANGE_OPS.has(op);
    hint.textContent = op === 'IN' || op === 'NOT IN' ? 'Separate values with commas.'
      : op === 'LIKE' || op === 'NOT LIKE' ? '% matches any text, _ matches one character.'
        : op === 'GLOB' ? '* and ? wildcards, case-sensitive.' : op.includes('REGEXP') ? 'JavaScript regular expression.' : '';
  };
  opSel.addEventListener('change', sync);
  sync();
  const submit = () => {
    const f = { col: colSel.value, op: opSel.value };
    if (!NO_VALUE_OPS.has(f.op)) f.value = v1.value;
    if (RANGE_OPS.has(f.op)) f.value2 = v2.value;
    m.close();
    onAdd(f);
  };
  [v1, v2].forEach((i) => i.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); }));
  const m = openModal({
    title: 'Add filter',
    body: [h('div', { class: 'field' }, h('label', null, 'Column'), colSel),
      h('div', { class: 'field' }, h('label', null, 'Condition'), opSel),
      h('div', { class: 'field' }, h('label', null, 'Value'), v1, v2, hint)],
    footer: [h('button', { class: 'btn', onclick: () => m.close() }, 'Cancel'), h('button', { class: 'btn btn-primary', onclick: submit }, 'Apply filter')],
    initialFocus: v1,
  });
}

// ---------------------------------------------------------------------------------------------
// Row editor (insert / edit / duplicate)

const FUNCTIONS = [
  ['CURRENT_TIMESTAMP', 'CURRENT_TIMESTAMP'], ['CURRENT_DATE', 'CURRENT_DATE'], ['CURRENT_TIME', 'CURRENT_TIME'],
  ["datetime('now', 'localtime')", 'local datetime'], ['unixepoch()', 'unixepoch()'], ['random()', 'random()'],
  ['lower(hex(randomblob(16)))', 'random hex id'], ['randomblob(16)', 'randomblob(16)'],
];

function affinity(type) {
  const t = String(type || '').toUpperCase();
  if (t.includes('INT')) return 'integer';
  if (/CHAR|CLOB|TEXT/.test(t)) return 'text';
  if (t.includes('BLOB') || !t) return 'blob';
  if (/REAL|FLOA|DOUB/.test(t)) return 'real';
  return 'numeric';
}

/**
 * Build the per-column form. `values` maps column name to an API-encoded value.
 * Returns { el, collect() } where collect() returns the values object for the API, or throws.
 */
function buildRowForm(columns, values, mode) {
  const fields = [];
  const rows = [];
  for (const c of columns) {
    if (c.hidden === 1) continue;
    const generated = c.hidden === 2 || c.hidden === 3;
    const orig = values ? values[c.name] : undefined;
    const aff = affinity(c.type);
    const isRowidPk = c.pk === 1 && /^INTEGER$/i.test(c.type) && columns.filter((x) => x.pk).length === 1;
    const hasDefault = c.dflt_value !== null && c.dflt_value !== undefined;
    // Only a preview of BLOB values is available client-side, so a duplicated row cannot copy them.
    const text = orig === undefined || isBlob(orig) ? '' : valueText(orig) ?? '';
    const blobVal = isBlob(orig) && mode === 'edit' ? orig : null;

    const fnOptions = [['value', blobVal ? 'Keep current' : 'Value'], ['NULL', 'NULL']];
    if (mode === 'insert') fnOptions.push(['DEFAULT', hasDefault ? `DEFAULT (${c.dflt_value})` : 'DEFAULT']);
    fnOptions.push(['file', 'From file…'], ['raw', 'SQL expression'], ...FUNCTIONS.map(([v, l]) => [`fn:${v}`, l]));

    let initial = 'value';
    if (generated) initial = 'DEFAULT';
    else if (mode === 'insert' && (orig === undefined || (isRowidPk && values))) initial = (hasDefault || isRowidPk) ? 'DEFAULT' : (!c.notnull ? 'NULL' : 'value');
    else if (orig === null || (mode === 'insert' && isBlob(orig))) initial = 'NULL';

    const fn = select(fnOptions, initial, { class: 'input-sm', 'aria-label': `${c.name} function`, disabled: generated });
    const multiline = aff === 'text' || aff === 'blob' || text.length > 40 || text.includes('\n');
    const input = multiline
      ? h('textarea', { rows: Math.min(8, Math.max(1, text.split('\n').length)), 'aria-label': c.name })
      : h('input', { type: 'text', 'aria-label': c.name, inputmode: aff === 'integer' || aff === 'real' ? 'decimal' : null });
    input.value = isRowidPk && mode === 'insert' && values ? '' : blobVal ? '' : text;
    const file = h('input', { type: 'file', hidden: true });
    const fileLabel = h('span', { class: 'small muted' });
    const blobInfo = blobVal ? h('span', { class: 'v-blob' }, icon('file', 12), `BLOB · ${fmtBytes(blobVal.size)}`) : null;

    const sync = () => {
      const f = fn.value;
      input.hidden = f === 'file' || (f === 'value' && !!blobVal);
      input.disabled = generated || f === 'NULL' || f === 'DEFAULT' || f.startsWith('fn:');
      input.placeholder = f === 'NULL' ? 'NULL' : f === 'DEFAULT' ? 'default value' : f === 'raw' ? "e.g. price * 1.2 or upper('x')" : f.startsWith('fn:') ? f.slice(3) : '';
      if (blobInfo) blobInfo.hidden = f !== 'value';
      fileLabel.hidden = f !== 'file';
      if (f === 'file' && !file.files.length) file.click();
    };
    fn.addEventListener('change', sync);
    file.addEventListener('change', () => { fileLabel.textContent = file.files[0] ? `${file.files[0].name} (${fmtBytes(file.files[0].size)})` : 'No file chosen'; });
    fileLabel.addEventListener('click', () => file.click());
    fileLabel.style.cursor = 'pointer';
    sync();

    fields.push({ c, fn, input, file, orig, text, blobVal, initial, generated });
    rows.push(h('tr', null,
      h('td', null, h('div', { class: 'colname' }, c.pk ? icon('key', 12, 'hl-str') : null, ' ', c.name),
        h('div', { class: 'coltype' }, [c.type || 'any', c.notnull ? 'NOT NULL' : null, generated ? 'GENERATED' : null].filter(Boolean).join(' · '))),
      h('td', null, fn),
      h('td', { style: { width: '100%' } }, input, blobInfo, file, fileLabel)));
  }

  async function collect() {
    const out = {};
    for (const f of fields) {
      if (f.generated) continue;
      const mode2 = f.fn.value;
      let v;
      if (mode2 === 'NULL') v = null;
      else if (mode2 === 'DEFAULT') v = { $default: true };
      else if (mode2 === 'raw') {
        if (!f.input.value.trim()) throw new Error(`Enter an SQL expression for ${f.c.name}`);
        v = { $raw: f.input.value };
      } else if (mode2.startsWith('fn:')) v = { $raw: mode2.slice(3) };
      else if (mode2 === 'file') {
        if (!f.file.files[0]) throw new Error(`Choose a file for ${f.c.name}`);
        v = { $blob: await readFileAsBase64(f.file.files[0]) };
      } else {
        if (f.blobVal) continue;
        v = f.input.value;
      }
      if (mode === 'edit' && mode2 === f.initial) {
        if (mode2 === 'value' && f.input.value === f.text) continue;
        if (mode2 === 'NULL') continue;
      }
      out[f.c.name] = v;
    }
    return out;
  }

  const el = h('table', { class: 'row-form' },
    h('thead', null, h('tr', null, h('th', null, 'Column'), h('th', null, 'Function'), h('th', null, 'Value'))),
    h('tbody', null, rows));
  return { el, collect };
}

/** Open the row editor dialog. Resolves true when a row was saved. */
export async function openRowEditor({ db, table, mode, key, values }) {
  let structure;
  let current = values;
  try {
    structure = await api('structure', { db, table });
    if (mode === 'edit') current = (await api('getRow', { db, table, key })).values;
  } catch (e) {
    toast(e.message, 'error');
    return false;
  }
  return new Promise((resolve) => {
    let saved = false;
    let form = buildRowForm(structure.columns, current, mode);
    const formBox = h('div', null, form.el);
    const status = h('div', { class: 'small' });
    const save = async (again) => {
      status.replaceChildren();
      try {
        const vals = await form.collect();
        if (mode === 'edit' && !Object.keys(vals).length) { m.close(); return; }
        const r = mode === 'edit'
          ? await api('updateRow', { db, table, key, values: vals })
          : await api('insertRow', { db, table, values: vals });
        saved = true;
        toast(mode === 'edit' ? 'Row updated' : `Row inserted${r.lastInsertRowid !== undefined ? ` (rowid ${valueText(r.lastInsertRowid)})` : ''}`, 'success', { sql: r.sql });
        if (again) {
          form = buildRowForm(structure.columns, undefined, 'insert');
          formBox.replaceChildren(form.el);
          status.replaceChildren(h('span', { class: 'success-text' }, icon('check', 13), ' Saved. Enter the next row.'));
          formBox.querySelector('input:not([disabled]), textarea:not([disabled])')?.focus();
        } else m.close();
      } catch (e) {
        status.replaceChildren(h('span', { class: 'danger-text' }, e.message));
      }
    };
    const m = openModal({
      title: mode === 'edit' ? `Edit row in ${table}` : `Insert row into ${table}`,
      size: 'wide',
      body: [formBox],
      footer: [h('div', { class: 'left' }, status),
        h('button', { class: 'btn', onclick: () => m.close() }, 'Cancel'),
        mode === 'insert' ? h('button', { class: 'btn', onclick: () => save(true) }, 'Save & add another') : null,
        h('button', { class: 'btn btn-primary', onclick: () => save(false) }, icon('save', 15), mode === 'edit' ? 'Save changes' : 'Insert')],
      onClose: () => resolve(saved),
    });
    m.el.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); save(false); } });
  });
}

// ---------------------------------------------------------------------------------------------
// Insert tab

export async function renderInsert(container, route) {
  const { db, table } = route;
  if (isReadOnly()) {
    container.replaceChildren(h('div', { class: 'alert alert-warn' }, icon('lock', 16), 'Inserting rows is disabled in read-only mode.'));
    return;
  }
  const structure = await api('structure', { db, table });
  let form = buildRowForm(structure.columns, undefined, 'insert');
  const formBox = h('div', null, form.el);
  const status = h('div');
  const save = async (stay) => {
    try {
      const r = await api('insertRow', { db, table, values: await form.collect() });
      status.replaceChildren(h('div', { class: 'alert alert-success' }, icon('check', 16),
        h('div', { class: 'grow' }, h('strong', null, `1 row inserted${r.lastInsertRowid !== undefined ? ` (rowid ${valueText(r.lastInsertRowid)})` : ''}.`),
          h('pre', { class: 'code mt', innerHTML: highlightSql(r.sql) }))));
      if (stay) {
        form = buildRowForm(structure.columns, undefined, 'insert');
        formBox.replaceChildren(form.el);
      } else {
        toast('1 row inserted', 'success', { sql: r.sql });
        go({ db, table, tab: 'browse' });
      }
    } catch (e) {
      status.replaceChildren(errorBox(e));
    }
  };
  container.replaceChildren(status, card({
    title: `Insert into ${table}`,
    body: [formBox, h('div', { class: 'row mt' },
      h('button', { class: 'btn btn-primary', onclick: () => save(false) }, icon('save', 15), 'Insert and browse'),
      h('button', { class: 'btn', onclick: () => save(true) }, 'Insert and add another'),
      h('span', { class: 'muted small' }, 'Choose DEFAULT to use the column default, or a function to compute the value.'))],
  }));
}

// ---------------------------------------------------------------------------------------------
// Search tab (per-column conditions) and find & replace

export async function renderTableSearch(container, route) {
  const { db, table } = route;
  const structure = await api('structure', { db, table });
  const cols = structure.columns.filter((c) => c.hidden !== 1);
  const inputs = cols.map((c) => {
    const aff = affinity(c.type);
    const op = select([['', '—'], ...FILTER_OPS], '', { class: 'input-sm', 'aria-label': `${c.name} operator` });
    const v1 = h('input', { type: 'text', class: 'input-sm w-full', 'aria-label': `${c.name} value` });
    const v2 = h('input', { type: 'text', class: 'input-sm w-full', placeholder: 'and…', hidden: true });
    const syncOp = () => {
      v2.hidden = !RANGE_OPS.has(op.value);
      v1.disabled = NO_VALUE_OPS.has(op.value);
    };
    op.addEventListener('change', syncOp);
    v1.addEventListener('input', () => { if (v1.value && !op.value) { op.value = aff === 'text' ? 'CONTAINS' : '='; syncOp(); } });
    return { c, op, v1, v2 };
  });
  const run = () => {
    const filters = [];
    for (const { c, op, v1, v2 } of inputs) {
      if (!op.value) continue;
      const f = { col: c.name, op: op.value };
      if (!NO_VALUE_OPS.has(op.value)) f.value = v1.value;
      if (RANGE_OPS.has(op.value)) f.value2 = v2.value;
      filters.push(f);
    }
    go({ db, table, tab: 'browse', params: filters.length ? { q: JSON.stringify({ filters }) } : undefined });
  };
  container.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.tagName === 'INPUT' && e.target.closest('.search-form')) run(); });

  const parts = [card({
    title: `Search in ${table}`,
    className: 'search-form',
    flush: true,
    body: [h('div', { class: 'table-wrap' }, h('table', { class: 'tbl' },
      h('thead', null, h('tr', null, h('th', null, 'Column'), h('th', null, 'Type'), h('th', null, 'Operator'), h('th', { style: { width: '50%' } }, 'Value'))),
      h('tbody', null, inputs.map(({ c, op, v1, v2 }) => h('tr', null,
        h('td', null, h('strong', null, c.name)), h('td', { class: 'mono small' }, c.type || ''), h('td', null, op),
        h('td', null, h('div', { class: 'row nowrap gap-sm' }, v1, v2))))))),
    h('div', { class: 'card-body row' },
      h('button', { class: 'btn btn-primary', onclick: run }, icon('search', 15), 'Search'),
      h('span', { class: 'muted small' }, 'All conditions must match (AND). Results open in Browse.'))],
  })];

  if (structure.type === 'table' && !isReadOnly()) {
    const textCols = cols.filter((c) => !(c.hidden === 2 || c.hidden === 3));
    const col = select(textCols.map((c) => c.name), textCols[0] && textCols[0].name);
    const find = h('input', { type: 'text', placeholder: 'Find' });
    const repl = h('input', { type: 'text', placeholder: 'Replace with' });
    const preview = h('div', { class: 'mt' });
    const buildSql = () => {
      const c = qi(col.value);
      return `UPDATE ${qi(table)}\nSET ${c} = replace(${c}, ${sqlLiteral(find.value)}, ${sqlLiteral(repl.value)})\nWHERE instr(${c}, ${sqlLiteral(find.value)}) > 0;`;
    };
    const doPreview = async () => {
      if (!find.value) { find.focus(); return; }
      try {
        const r = await execSql(db, `SELECT count(*) AS matches FROM ${qi(table)} WHERE instr(${qi(col.value)}, ${sqlLiteral(find.value)}) > 0`);
        const n = r.results[0].rows[0][0];
        preview.replaceChildren(h('div', { class: 'alert alert-info' }, icon('info', 16),
          h('div', { class: 'grow' }, h('p', null, `${plural(n, 'row')} will be changed.`), h('pre', { class: 'code', innerHTML: highlightSql(buildSql()) }),
            n ? h('button', {
              class: 'btn btn-primary mt', onclick: async () => {
                try {
                  const res = await execSql(db, buildSql());
                  toast(`${plural(res.results[0].changes, 'row')} updated`, 'success');
                  preview.replaceChildren();
                } catch (e) { toast(e.message, 'error'); }
              },
            }, 'Replace') : null)));
      } catch (e) { preview.replaceChildren(errorBox(e)); }
    };
    parts.push(card({
      title: 'Find and replace',
      body: [h('div', { class: 'row' }, h('label', null, 'In column'), col, find, repl,
        h('button', { class: 'btn', onclick: doPreview }, 'Preview')),
      h('p', { class: 'muted small mt' }, 'Case-sensitive, replaces every occurrence inside the matching values.'), preview],
    }));
  }
  container.replaceChildren(...parts);
}
