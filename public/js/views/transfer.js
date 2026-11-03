// Export and Import tabs (database and table level).
import {
  h, icon, card, toast, fmtBytes, fmtMs, select, loading, errorBox, plural, esc,
} from '../util.js';
import { apiDownload, apiUpload } from '../api.js';
import { loadSchema, schemaChanged, isReadOnly, href } from '../app.js';
import { FILTER_OPS } from './browse.js';

const radio = (name, value, label, checked, onchange) => h('label', { class: 'check' },
  h('input', { type: 'radio', name, value, checked, onchange }), label);

// ---------------------------------------------------------------------------------------------
// Export

export async function renderExport(container, route) {
  const { db, table } = route;
  const schema = await loadSchema(db);
  const objects = schema.tables.filter((t) => !t.system && t.type !== 'shadow');
  const obj = table ? schema.tables.find((t) => t.name === table) : null;
  let q = null;
  try { q = route.params.q ? JSON.parse(route.params.q) : null; } catch { q = null; }
  const hasFilter = q && ((q.filters && q.filters.length) || q.search);

  let format = table ? 'csv' : 'sql';
  const formats = table
    ? [['csv', 'CSV'], ['tsv', 'TSV'], ['json', 'JSON'], ['sql', 'SQL'], ['markdown', 'Markdown']]
    : [['sql', 'SQL dump'], ['json', 'JSON (one array per table)']];

  // SQL options
  const oStructure = h('input', { type: 'checkbox', checked: true });
  const oData = h('input', { type: 'checkbox', checked: true });
  const oDrop = h('input', { type: 'checkbox' });
  const oIfNot = h('input', { type: 'checkbox' });
  const oTx = h('input', { type: 'checkbox', checked: true });
  const oRows = select([[1, 'one row per INSERT'], [100, '100 rows per INSERT'], [1000, '1,000 rows per INSERT']], 100);
  const sqlOpts = h('div', { class: 'col' },
    h('div', { class: 'row' }, h('label', { class: 'check' }, oStructure, 'Structure (CREATE statements)'), h('label', { class: 'check' }, oData, 'Data (INSERT statements)')),
    h('div', { class: 'row' }, h('label', { class: 'check' }, oDrop, 'Add DROP … IF EXISTS'), table ? null : h('label', { class: 'check' }, oIfNot, 'Use CREATE TABLE IF NOT EXISTS'),
      h('label', { class: 'check' }, oTx, 'Wrap in a transaction')),
    h('div', { class: 'row' }, h('span', null, 'Batch size'), oRows));

  // CSV options
  const cDelim = select([[',', 'Comma ,'], [';', 'Semicolon ;'], ['|', 'Pipe |']], ',');
  const cHeader = h('input', { type: 'checkbox', checked: true });
  const cNull = select([['', 'empty'], ['NULL', 'NULL'], ['\\N', '\\N']], '');
  const cBom = h('input', { type: 'checkbox' });
  const cCrlf = h('input', { type: 'checkbox' });
  const csvOpts = h('div', { class: 'col' },
    h('div', { class: 'row' }, h('span', null, 'Delimiter'), cDelim, h('span', null, 'Write NULL as'), cNull),
    h('div', { class: 'row' }, h('label', { class: 'check' }, cHeader, 'Column names in the first row'),
      h('label', { class: 'check', title: 'Helps Excel detect UTF-8' }, cBom, 'Add UTF-8 BOM (Excel)'), h('label', { class: 'check' }, cCrlf, 'Windows line endings (CRLF)')));

  const onlyFiltered = h('input', { type: 'checkbox', checked: true });
  const boxes = objects.map((t) => h('input', {
    type: 'checkbox', value: t.name,
    checked: route.params.tables ? route.params.tables.split(',').includes(t.name) : true,
  }));
  const tablePicker = table ? null : card({
    title: 'Tables',
    actions: [h('button', { class: 'btn btn-sm', onclick: () => boxes.forEach((b) => { b.checked = true; }) }, 'All'),
      h('button', { class: 'btn btn-sm', onclick: () => boxes.forEach((b) => { b.checked = false; }) }, 'None')],
    body: h('div', { class: 'row', style: { gap: '6px 18px' } }, objects.map((t, i) => h('label', { class: 'check' }, boxes[i], icon(t.type === 'view' ? 'view' : 'table', 13), t.name))),
  });

  const optsBox = h('div');
  const syncOpts = () => {
    if (format === 'sql') optsBox.replaceChildren(sqlOpts);
    else if (format === 'csv' || format === 'tsv') {
      cDelim.disabled = format === 'tsv';
      optsBox.replaceChildren(csvOpts);
    } else optsBox.replaceChildren(h('p', { class: 'muted small' }, format === 'json' ? 'BLOB values are written as base64 strings.' : 'Produces a Markdown table.'));
  };
  syncOpts();

  const exportBtn = h('button', {
    class: 'btn btn-primary',
    onclick: async () => {
      const options = {
        structure: oStructure.checked, data: oData.checked, dropIfExists: oDrop.checked, ifNotExists: oIfNot.checked,
        transaction: oTx.checked, rowsPerInsert: Number(oRows.value),
        delimiter: cDelim.value, header: cHeader.checked, nullText: cNull.value, bom: cBom.checked, crlf: cCrlf.checked,
      };
      if (table && hasFilter && onlyFiltered.checked) Object.assign(options, { filters: q.filters || [], search: q.search, searchMode: q.searchMode, sort: q.sort });
      if (!table) {
        options.tables = boxes.filter((b) => b.checked).map((b) => b.value);
        if (!options.tables.length) { toast('Select at least one table', 'error'); return; }
        if (options.tables.length === boxes.length) delete options.tables;
      }
      exportBtn.disabled = true;
      const orig = exportBtn.textContent;
      exportBtn.textContent = 'Exporting…';
      try {
        const size = await apiDownload('export', { db, table, format, options });
        toast(`Exported ${fmtBytes(size)}`, 'success');
      } catch (e) { toast(e.message, 'error'); } finally {
        exportBtn.disabled = false;
        exportBtn.textContent = orig;
      }
    },
  }, icon('download', 15), 'Export');

  const filterNote = table && hasFilter ? h('div', { class: 'alert alert-info' }, icon('filter', 16), h('div', { class: 'grow' },
    h('label', { class: 'check' }, onlyFiltered, 'Export only rows matching the current Browse filters'),
    h('div', { class: 'small muted mt' }, [...(q.filters || []).map((f) => `${f.col} ${(FILTER_OPS.find(([v]) => v === f.op) || [0, f.op])[1]} ${f.value ?? ''}`),
      q.search ? `search “${q.search}”` : null].filter(Boolean).join(' · ')))) : null;

  container.replaceChildren(
    h('h1', null, table ? `Export ${obj && obj.type === 'view' ? 'view' : 'table'} ${table}` : `Export database ${db}`),
    filterNote,
    card({
      title: 'Format',
      body: [h('div', { class: 'row mb' }, formats.map(([v, label]) => radio('fmt', v, label, v === format, () => { format = v; syncOpts(); }))), optsBox],
    }),
    tablePicker,
    h('div', { class: 'row' }, exportBtn,
      table ? null : h('span', { class: 'muted small' }, 'Tip: the Operations tab can also download the raw .db file.')));
}

// ---------------------------------------------------------------------------------------------
// Import

function sniffDelimiter(line) {
  const counts = [',', ';', '\t', '|'].map((d) => [d, line.split(d).length - 1]);
  counts.sort((a, b) => b[1] - a[1]);
  return counts[0][1] > 0 ? counts[0][0] : ',';
}

function previewCsv(text, delimiter, maxRows = 6) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length && rows.length < maxRows; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else field += c;
    } else if (c === '"' && field === '') quoted = true;
    else if (c === delimiter) { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = ''; rows.push(row); row = [];
    } else field += c;
  }
  if ((field || row.length) && rows.length < maxRows) { row.push(field); rows.push(row); }
  return rows;
}

export async function renderImport(container, route) {
  const { db, table } = route;
  if (isReadOnly()) {
    container.replaceChildren(h('div', { class: 'alert alert-warn' }, icon('lock', 16), 'Importing is disabled in read-only mode.'));
    return;
  }
  const schema = await loadSchema(db);
  const tables = schema.tables.filter((t) => t.type === 'table' && !t.system);
  let file = null;
  let text = null;
  let format = 'sql';

  const fileInput = h('input', { type: 'file', hidden: true, accept: '.sql,.csv,.tsv,.txt,.json' });
  const fileInfo = h('div', { class: 'mt' });
  const zone = h('div', {
    class: 'drop-zone', tabindex: '0', role: 'button', onclick: () => fileInput.click(),
    onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); } },
  }, icon('upload', 26), h('div', null, h('strong', null, 'Drop a file here'), ' or click to choose'),
  h('div', { class: 'small' }, table ? 'CSV, TSV, JSON or SQL' : 'SQL script, CSV, TSV or JSON'));

  // Options
  const fmtSel = select([['sql', 'SQL script'], ['csv', 'CSV / TSV'], ['json', 'JSON array of objects']], 'sql');
  const sTx = h('input', { type: 'checkbox', checked: true });
  const sFk = h('input', { type: 'checkbox', checked: true });
  const sqlOpts = h('div', { class: 'row' }, h('label', { class: 'check' }, sTx, 'Run everything in one transaction (all or nothing)'),
    h('label', { class: 'check' }, sFk, 'Disable foreign key checks during import'));

  const cDelim = select([[',', 'Comma ,'], [';', 'Semicolon ;'], ['\\t', 'Tab'], ['|', 'Pipe |']], ',');
  const cHeader = h('input', { type: 'checkbox', checked: true });
  const cEmptyNull = h('input', { type: 'checkbox', checked: true });
  const target = select([['new', 'Create a new table'], ...tables.map((t) => [t.name, `Existing table: ${t.name}`])], table || 'new');
  const newName = h('input', { type: 'text', placeholder: 'new_table', style: { width: '220px' } });
  const mode = select([['append', 'Append rows'], ['replace', 'Replace all rows (delete existing first)']], 'append');
  const csvRow = h('div', { class: 'row' }, h('span', null, 'Delimiter'), cDelim, h('label', { class: 'check' }, cHeader, 'First row contains column names'),
    h('label', { class: 'check' }, cEmptyNull, 'Treat empty values as NULL'));
  const targetRow = h('div', { class: 'row' }, h('span', null, 'Import into'), target, newName, mode);
  const syncTarget = () => {
    newName.hidden = target.value !== 'new';
    mode.hidden = target.value === 'new';
  };
  target.addEventListener('change', syncTarget);
  syncTarget();

  const optsBox = h('div', { class: 'col' });
  const preview = h('div');
  const resultBox = h('div');

  const syncOpts = () => {
    format = fmtSel.value;
    if (format === 'sql') optsBox.replaceChildren(sqlOpts);
    else if (format === 'csv') optsBox.replaceChildren(csvRow, targetRow);
    else optsBox.replaceChildren(targetRow);
    renderPreview();
  };
  fmtSel.addEventListener('change', syncOpts);
  cDelim.addEventListener('change', () => renderPreview());
  cHeader.addEventListener('change', () => renderPreview());

  function renderPreview() {
    if (!text) { preview.replaceChildren(); return; }
    if (format === 'csv') {
      const d = cDelim.value === '\\t' ? '\t' : cDelim.value;
      const rows = previewCsv(text.slice(0, 200000), d);
      const head = cHeader.checked ? rows.shift() : (rows[0] || []).map((_, i) => `column${i + 1}`);
      preview.replaceChildren(card({
        title: 'Preview (first rows)', flush: true,
        body: h('div', { class: 'datagrid-wrap', style: { maxHeight: '260px' } }, h('table', { class: 'datagrid' },
          h('thead', null, h('tr', null, (head || []).map((c) => h('th', null, c)))),
          h('tbody', null, rows.map((r) => h('tr', null, r.map((v) => h('td', null, v === '' ? h('span', { class: 'v-null' }, cEmptyNull.checked ? 'NULL' : '') : v))))))),
      }));
    } else if (format === 'sql') {
      const snippet = text.slice(0, 1200);
      const pre = h('pre', { class: 'code', style: { maxHeight: '220px' } });
      pre.innerHTML = esc(snippet) + (text.length > 1200 ? '\n…' : '');
      preview.replaceChildren(card({ title: 'Preview', body: pre }));
    } else {
      let info = '';
      try {
        const data = JSON.parse(text);
        const arr = Array.isArray(data) ? data : Object.values(data).find(Array.isArray) || [];
        info = `${plural(arr.length, 'object')}; keys: ${Object.keys(arr[0] || {}).join(', ')}`;
      } catch (e) { info = `Invalid JSON: ${e.message}`; }
      preview.replaceChildren(card({ title: 'Preview', body: h('p', null, info) }));
    }
  }

  async function chooseFile(f) {
    if (!f) return;
    file = f;
    text = await f.text();
    const ext = f.name.split('.').pop().toLowerCase();
    fmtSel.value = ext === 'json' ? 'json' : ext === 'csv' || ext === 'tsv' || ext === 'txt' ? 'csv' : 'sql';
    if (fmtSel.value === 'csv') {
      const firstLine = text.slice(0, text.indexOf('\n') > 0 ? text.indexOf('\n') : 2000);
      const d = ext === 'tsv' ? '\t' : sniffDelimiter(firstLine);
      cDelim.value = d === '\t' ? '\\t' : d;
    }
    if (!table) newName.value = f.name.replace(/\.[^.]+$/, '').replace(/[^\w]+/g, '_').replace(/^(\d)/, '_$1') || 'imported';
    fileInfo.replaceChildren(h('div', { class: 'row' }, icon('file', 16), h('strong', null, f.name), h('span', { class: 'muted' }, fmtBytes(f.size))));
    syncOpts();
  }
  fileInput.addEventListener('change', () => chooseFile(fileInput.files[0]));
  zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('over'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('over'));
  zone.addEventListener('drop', (e) => { e.preventDefault(); zone.classList.remove('over'); chooseFile(e.dataTransfer.files[0]); });

  const importBtn = h('button', {
    class: 'btn btn-primary',
    onclick: async () => {
      if (!file) { toast('Choose a file first', 'error'); return; }
      const params = { db, format };
      if (format === 'sql') {
        params.transaction = sTx.checked ? '1' : '0';
        params.disableFk = sFk.checked ? '1' : '0';
      } else {
        const isNew = target.value === 'new';
        params.table = isNew ? newName.value.trim() : target.value;
        if (!params.table) { toast('Enter a name for the new table', 'error'); newName.focus(); return; }
        params.create = isNew ? '1' : '0';
        params.mode = mode.value;
        if (format === 'csv') {
          params.delimiter = cDelim.value;
          params.header = cHeader.checked ? '1' : '0';
          params.emptyNull = cEmptyNull.checked ? '1' : '0';
        }
      }
      importBtn.disabled = true;
      resultBox.replaceChildren(loading('Importing…'));
      try {
        const r = await apiUpload('import', params, file);
        await schemaChanged(db);
        const lines = format === 'sql'
          ? [`${plural(r.executed, 'statement')} executed in ${fmtMs(r.time)}.`, r.skipped ? `${plural(r.skipped, 'transaction/pragma statement')} skipped.` : null,
            r.fkViolations ? `Warning: ${plural(r.fkViolations, 'foreign key violation')} found after the import.` : null]
          : [`${plural(r.inserted, 'row')} imported into ${r.table} in ${fmtMs(r.time)}.`];
        resultBox.replaceChildren(h('div', { class: `alert ${r.fkViolations ? 'alert-warn' : 'alert-success'}` }, icon('check', 16),
          h('div', { class: 'grow' }, lines.filter(Boolean).map((l) => h('p', null, l)),
            r.table ? h('a', { class: 'btn btn-sm', href: href({ db, table: r.table }) }, icon('grid', 14), `Browse ${r.table}`) : null,
            r.sql ? h('pre', { class: 'code mt' }, r.sql) : null)));
        toast('Import finished', 'success');
      } catch (e) {
        resultBox.replaceChildren(errorBox(e, 'Import failed — no changes were made' + (format === 'sql' && !sTx.checked ? ' after the failing statement' : '')));
      } finally {
        importBtn.disabled = false;
      }
    },
  }, icon('upload', 15), 'Import');

  syncOpts();
  container.replaceChildren(
    h('h1', null, table ? `Import into ${table}` : `Import into ${db}`),
    card({ title: 'File', body: [zone, fileInput, fileInfo] }),
    card({ title: 'Options', body: [h('div', { class: 'row mb' }, h('span', null, 'Format'), fmtSel), optsBox] }),
    preview,
    h('div', { class: 'row mb' }, importBtn),
    resultBox);
  if (table) fmtSel.value = 'csv';
  syncOpts();
}
