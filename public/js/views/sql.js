// SQL tab: editor, templates, history, saved queries and multi-statement results.
import {
  h, icon, card, toast, fmtNum, fmtMs, qi, select, openModal, highlightSql, errorBox, loading, copyText,
  rowsToCsv, rowsToJson, rowsToSql, rowsToMarkdown, saveText, formatSql, fmtDate, promptDialog, valueText, plural,
  store, showMenu,
} from '../util.js';
import { api, apiDownload } from '../api.js';
import {
  state, setTx, schemaChanged, loadSchema, addHistory, getHistory, clearHistory, getSaved, saveQuery, deleteSaved,
} from '../app.js';
import { createSqlEditor } from '../sqleditor.js';
import { resultGrid } from '../grid.js';

const draftKey = (db, table) => `sqla:draft:${db}:${table || ''}`;
function getDraft(db, table) {
  try { return sessionStorage.getItem(draftKey(db, table)); } catch { return null; }
}
function setDraft(db, table, sql) {
  try { sessionStorage.setItem(draftKey(db, table), sql); } catch { /* ignore */ }
}

function templates(table, columns) {
  const t = qi(table);
  const cols = columns.map((c) => qi(c.name));
  const nonPk = columns.filter((c) => !c.pk);
  const pk = columns.filter((c) => c.pk);
  const where = pk.length ? pk.map((c) => `${qi(c.name)} = ?`).join(' AND ') : '1 = 0';
  return [
    ['SELECT *', `SELECT * FROM ${t} WHERE 1 LIMIT 100;`],
    ['SELECT columns', `SELECT ${cols.join(', ')}\nFROM ${t}\nWHERE 1\nLIMIT 100;`],
    ['INSERT', `INSERT INTO ${t} (${nonPk.map((c) => qi(c.name)).join(', ')})\nVALUES (${nonPk.map(() => '?').join(', ')});`],
    ['UPDATE', `UPDATE ${t}\nSET ${nonPk.map((c) => `${qi(c.name)} = ?`).join(',\n    ')}\nWHERE ${where};`],
    ['DELETE', `DELETE FROM ${t}\nWHERE ${where};`],
    ['COUNT / GROUP BY', `SELECT ${cols[1] || cols[0]}, count(*) AS n\nFROM ${t}\nGROUP BY 1\nORDER BY n DESC;`],
  ];
}

const DB_TEMPLATES = [
  ['CREATE TABLE', 'CREATE TABLE new_table (\n  id INTEGER PRIMARY KEY,\n  name TEXT NOT NULL,\n  created_at TEXT DEFAULT CURRENT_TIMESTAMP\n);'],
  ['CREATE VIEW', 'CREATE VIEW view_name AS\nSELECT *\nFROM table_name;'],
  ['CREATE INDEX', 'CREATE INDEX idx_name ON table_name (column_name);'],
  ['CREATE TRIGGER', 'CREATE TRIGGER trigger_name\nAFTER UPDATE ON table_name\nFOR EACH ROW\nBEGIN\n  UPDATE table_name SET updated_at = CURRENT_TIMESTAMP WHERE rowid = NEW.rowid;\nEND;'],
  ['WITH (CTE)', 'WITH recent AS (\n  SELECT * FROM table_name ORDER BY rowid DESC LIMIT 10\n)\nSELECT * FROM recent;'],
  ['List tables', "SELECT type, name, tbl_name FROM sqlite_schema ORDER BY type, name;"],
  ['Table info', "SELECT * FROM pragma_table_info('table_name');"],
  ['Database size', 'SELECT page_count * page_size AS bytes FROM pragma_page_count(), pragma_page_size();'],
];

function planTree(rows) {
  // EXPLAIN QUERY PLAN rows: id, parent, notused, detail
  const children = new Map();
  for (const r of rows) {
    const parent = r[1];
    if (!children.has(parent)) children.set(parent, []);
    children.get(parent).push(r);
  }
  const build = (parent) => {
    const list = children.get(parent);
    if (!list) return null;
    return h('ul', { style: { listStyle: 'none', paddingLeft: parent === 0 ? '0' : '20px', margin: '0' } }, list.map((r) => {
      const detail = String(r[3]);
      const scan = /^SCAN/.test(detail) && !/USING (COVERING )?INDEX/.test(detail);
      return h('li', { style: { padding: '3px 0' } },
        h('span', { class: `mono ${scan ? 'danger-text' : ''}`, title: scan ? 'Full table scan — an index may help' : '' }, parent === 0 ? '' : '└ ', detail),
        build(r[0]));
    }));
  };
  return build(0);
}

export async function renderSql(container, route) {
  const { db, table } = route;
  const schema = await loadSchema(db);
  const tableInfo = table ? schema.tables.find((t) => t.name === table) : null;

  const initial = route.params.sql || getDraft(db, table) || (table ? `SELECT * FROM ${qi(table)} LIMIT 100;` : '');
  const results = h('div');
  const editor = createSqlEditor({
    value: initial,
    onRun: () => run(),
    onChange: (v) => setDraft(db, table, v),
    schema: () => state.schema,
    placeholder: 'Type SQL here. Ctrl+Enter runs it, Ctrl+Space shows suggestions.',
    height: store.get('sqlEditorHeight', 240),
  });
  new ResizeObserver(() => { if (editor.el.offsetHeight > 60) store.set('sqlEditorHeight', editor.el.offsetHeight); }).observe(editor.el);
  if (route.params.sql) setDraft(db, table, route.params.sql);

  const maxRows = select([[100, '100 rows'], [1000, '1,000 rows'], [5000, '5,000 rows'], [20000, '20,000 rows']], store.get('sqlMaxRows', 1000), {
    class: 'input-sm', title: 'Maximum rows shown per result', onchange: (e) => store.set('sqlMaxRows', Number(e.target.value)),
  });

  async function run(explain = false) {
    let sql = editor.getSelectedOrAll().trim();
    if (!sql) { editor.focus(); return; }
    if (explain) {
      const first = sql.replace(/^\s*EXPLAIN\s+(QUERY\s+PLAN\s+)?/i, '');
      sql = `EXPLAIN QUERY PLAN ${first}`;
    }
    results.replaceChildren(loading('Running…'));
    let r;
    try {
      r = await api('query', { db, sql, maxRows: Number(maxRows.value) });
    } catch (e) {
      results.replaceChildren(errorBox(e));
      return;
    }
    if (!explain) addHistory(db, sql);
    setTx(db, r.inTransaction);
    if (r.schemaChanged) schemaChanged(db);
    renderResults(r, explain);
  }

  function resultActions(res, index) {
    const names = res.columns.map((c) => c.name);
    const base = `result-${index + 1}`;
    const single = res.sql && /^\s*(SELECT|WITH|VALUES|PRAGMA)\b/i.test(res.sql);
    return h('div', { class: 'row gap-sm' },
      h('button', { class: 'btn btn-sm btn-ghost', title: 'Copy as tab-separated text', onclick: () => copyText(rowsToCsv(names, res.rows, '\t')) }, icon('copy', 13), 'Copy'),
      h('button', { class: 'btn btn-sm btn-ghost', onclick: () => saveText(rowsToCsv(names, res.rows), `${base}.csv`, 'text/csv') }, 'CSV'),
      h('button', { class: 'btn btn-sm btn-ghost', onclick: () => saveText(rowsToJson(names, res.rows), `${base}.json`, 'application/json') }, 'JSON'),
      h('button', { class: 'btn btn-sm btn-ghost', onclick: () => saveText(rowsToSql(table || 'result', names, res.rows), `${base}.sql`, 'application/sql') }, 'SQL'),
      h('button', { class: 'btn btn-sm btn-ghost', onclick: () => copyText(rowsToMarkdown(names, res.rows)) }, 'Markdown'),
      res.truncated && single ? h('button', {
        class: 'btn btn-sm', title: 'Run the query again on the server and download every row',
        onclick: () => apiDownload('export', { db, sql: res.sql, format: 'csv' }).catch((e) => toast(e.message, 'error')),
      }, icon('download', 13), 'All rows (CSV)') : null);
  }

  function renderResults(r, explain) {
    const cards = [];
    const failedAt = r.failed ? r.results.length - 1 : -1;
    const okCount = r.results.length - (r.failed ? 1 : 0);
    cards.push(h('div', { class: `alert ${r.failed ? 'alert-error' : 'alert-success'}` },
      icon(r.failed ? 'alert' : 'check', 16),
      h('div', { class: 'grow' },
        r.failed
          ? `Statement ${failedAt + 1} failed.${okCount ? ` ${plural(okCount, 'statement')} ran before it.` : ''}${r.skipped ? ` ${plural(r.skipped, 'statement')} skipped.` : ''}${r.rolledBack ? ' The transaction was rolled back.' : ''}`
          : `${plural(r.results.length, 'statement')} executed in ${fmtMs(r.time)}.`)));
    r.results.forEach((res, i) => {
      const header = [
        h('span', { class: res.error ? 'danger-text' : 'success-text' }, icon(res.error ? 'alert' : 'check', 14)),
        h('span', { class: 'sql-inline', title: res.sql, innerHTML: highlightSql(res.sql.replace(/\s+/g, ' ')) }),
        h('span', { class: 'muted small nowrap' }, fmtMs(res.time)),
      ];
      let body;
      if (res.error) {
        body = h('div', { class: 'card-body' }, h('pre', { class: 'mono danger-text', style: { margin: 0, whiteSpace: 'pre-wrap' } }, res.error));
      } else if (res.columns) {
        header.push(h('span', { class: 'badge' }, res.truncated ? `first ${fmtNum(res.rows.length)} rows` : plural(res.rows.length, 'row')));
        if (explain) body = h('div', { class: 'card-body' }, planTree(res.rows) || h('span', { class: 'muted' }, 'No plan.'));
        else body = [h('div', { class: 'card-body', style: { padding: '6px 10px', borderBottom: '1px solid var(--border)' } }, resultActions(res, i)),
          res.rows.length ? resultGrid(res.columns, res.rows) : h('div', { class: 'card-body muted' }, `No rows. Columns: ${res.columns.map((c) => c.name).join(', ')}`)];
      } else {
        const bits = [];
        if (res.changes !== undefined) bits.push(`${plural(res.changes, 'row')} affected`);
        if (res.lastInsertRowid !== undefined && res.changes) bits.push(`last insert rowid ${valueText(res.lastInsertRowid)}`);
        header.push(h('span', { class: 'badge green' }, bits.join(' · ') || 'OK'));
        body = null;
      }
      cards.push(h('section', { class: 'card result-card' }, h('div', { class: 'card-header' }, header), body));
    });
    results.replaceChildren(...cards);
  }

  // ---- side panel: tables / columns to insert
  const sideList = h('ul');
  const sideSelect = h('select', { class: 'input-sm', 'aria-label': 'Table' },
    h('option', { value: '' }, 'Tables'),
    schema.tables.filter((t) => !t.system).map((t) => h('option', { value: t.name, selected: t.name === table }, t.name)));
  const fillSide = () => {
    const t = schema.tables.find((x) => x.name === sideSelect.value);
    const items = t
      ? t.columns.map((c) => h('li', null, h('button', { title: 'Insert column name', onclick: () => editor.insert(qi(c.name)) }, c.pk ? icon('key', 11, 'hl-str') : null, c.name, h('span', { class: 't' }, (c.type || '').toLowerCase()))))
      : schema.tables.filter((x) => !x.system).map((x) => h('li', null, h('button', { title: 'Insert table name', onclick: () => editor.insert(qi(x.name)) }, icon(x.type === 'view' ? 'view' : 'table', 12), x.name)));
    sideList.replaceChildren(...items);
  };
  sideSelect.addEventListener('change', fillSide);
  fillSide();

  const tpl = table && tableInfo ? templates(table, tableInfo.columns) : DB_TEMPLATES;
  const tplButtons = table
    ? tpl.map(([label, sql]) => h('button', { class: 'btn btn-sm', onclick: () => { editor.setValue(sql); editor.focus(); } }, label))
    : [h('button', {
      class: 'btn btn-sm', onclick: (e) => {
        const rect = e.currentTarget.getBoundingClientRect();
        showMenu(rect.left, rect.bottom + 4, tpl.map(([label, sql]) => ({ label, onClick: () => { editor.setValue(sql); editor.focus(); } })));
      },
    }, 'Templates', icon('chevron-down', 12))];

  const toolbar = h('div', { class: 'sql-toolbar' },
    h('button', { class: 'btn btn-primary', onclick: () => run(), title: 'Run (Ctrl+Enter). Runs only the selection if text is selected.' }, icon('play', 14), 'Run'),
    h('button', { class: 'btn', onclick: () => run(true), title: 'Show how SQLite will execute the query' }, icon('diagram', 14), 'Explain'),
    h('button', { class: 'btn', onclick: () => editor.setValue(formatSql(editor.getValue())), title: 'Format SQL' }, icon('format', 14), 'Format'),
    h('button', { class: 'btn', onclick: () => { editor.setValue(''); editor.focus(); } }, 'Clear'),
    h('span', { style: { width: '6px' } }),
    ...tplButtons,
    h('div', { class: 'grow' }),
    h('button', { class: 'btn btn-sm', onclick: () => historyDialog(db, editor) }, icon('history', 14), 'History'),
    h('button', { class: 'btn btn-sm', onclick: () => savedDialog(db, editor) }, icon('bookmark', 14), 'Saved'),
    maxRows);

  container.replaceChildren(
    h('div', { class: 'sql-layout' },
      h('div', { style: { minWidth: '0' } }, editor.el),
      h('div', { class: 'sql-side' }, h('div', { class: 'side-head' }, 'Click to insert'), sideSelect, sideList)),
    toolbar,
    results);
  editor.focus();
  if (route.params.run === '1') run();
}

function historyDialog(db, editor) {
  const list = getHistory(db);
  const m = openModal({
    title: 'Query history',
    size: 'wide',
    body: list.length ? h('div', { class: 'col' }, list.map((item) => h('div', { class: 'card', style: { marginBottom: '0' } },
      h('div', { class: 'card-header', style: { padding: '6px 12px' } }, h('span', { class: 'small muted' }, fmtDate(item.at)),
        h('div', { class: 'actions' },
          h('button', { class: 'btn btn-sm', onclick: () => copyText(item.sql) }, icon('copy', 13)),
          h('button', { class: 'btn btn-sm btn-primary', onclick: () => { editor.setValue(item.sql); m.close(); editor.focus(); } }, 'Use'))),
      h('pre', { class: 'code', style: { border: '0', margin: '0', maxHeight: '140px' }, innerHTML: highlightSql(item.sql) }))))
      : h('div', { class: 'empty' }, 'No queries run yet on this database.'),
    footer: [list.length ? h('button', { class: 'btn btn-danger', onclick: () => { clearHistory(db); m.close(); toast('History cleared', 'success'); } }, 'Clear history') : null,
      h('button', { class: 'btn btn-primary', onclick: () => m.close() }, 'Close')],
  });
}

function savedDialog(db, editor) {
  const body = h('div');
  const render = () => {
    const list = getSaved(db);
    body.replaceChildren(list.length ? h('table', { class: 'tbl' }, h('tbody', null, list.map((q) => h('tr', null,
      h('td', null, h('strong', null, q.name), h('div', { class: 'small muted mono', style: { maxWidth: '520px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, q.sql)),
      h('td', { class: 'actions' },
        h('button', { class: 'btn btn-sm btn-primary', onclick: () => { editor.setValue(q.sql); m.close(); editor.focus(); } }, 'Use'),
        h('button', { class: 'icon-btn sm danger', title: 'Delete', onclick: () => { deleteSaved(db, q.name); render(); } }, icon('trash', 14)))))))
      : h('div', { class: 'empty' }, 'No saved queries yet. Save the current query to reuse it later.'));
  };
  render();
  const m = openModal({
    title: 'Saved queries',
    size: 'wide',
    body,
    footer: [h('button', {
      class: 'btn', onclick: async () => {
        const sql = editor.getValue().trim();
        if (!sql) { toast('The editor is empty', 'error'); return; }
        const name = await promptDialog({ title: 'Save query', label: 'Name', value: sql.split('\n')[0].slice(0, 40), okLabel: 'Save' });
        if (!name) return;
        saveQuery(db, name, sql);
        render();
        toast('Query saved', 'success');
      },
    }, icon('save', 14), 'Save current query'), h('button', { class: 'btn btn-primary', onclick: () => m.close() }, 'Close')],
  });
}
