// Read-only result grid and the value viewer dialog.
import {
  h, icon, renderValue, isBlob, isNumeric, valueText, openModal, copyText, fmtBytes, saveBlob, toast,
} from './util.js';

function compareValues(a, b) {
  if (a === null || a === undefined) return b === null || b === undefined ? 0 : -1;
  if (b === null || b === undefined) return 1;
  const na = typeof a === 'number' ? a : isNumeric(a) ? Number(valueText(a)) : NaN;
  const nb = typeof b === 'number' ? b : isNumeric(b) ? Number(valueText(b)) : NaN;
  if (!Number.isNaN(na) && !Number.isNaN(nb)) return na - nb;
  return String(valueText(a)).localeCompare(String(valueText(b)), undefined, { numeric: true });
}

/** Render a read-only grid for a query result set. Header clicks sort client-side. */
export function resultGrid(columns, rows, { fullText = false } = {}) {
  let order = rows.map((_, i) => i);
  let sortCol = -1;
  let sortDir = 1;
  const tbody = h('tbody');
  const headRow = h('tr', null, h('th', { class: 'rownum' }, '#'));
  columns.forEach((c, ci) => {
    const ind = h('span', { class: 'sort-ind' });
    headRow.append(h('th', {
      class: 'sortable',
      title: `${c.name}${c.type ? ` (${c.type})` : ''}${c.table ? ` — ${c.table}.${c.column}` : ''}\nClick to sort`,
      onclick: () => {
        if (sortCol === ci) sortDir = -sortDir;
        else { sortCol = ci; sortDir = 1; }
        order = rows.map((_, i) => i).sort((a, b) => sortDir * compareValues(rows[a][ci], rows[b][ci]));
        headRow.querySelectorAll('.sort-ind').forEach((s) => s.replaceChildren());
        ind.replaceChildren(icon(sortDir > 0 ? 'arrow-up' : 'arrow-down', 12));
        renderBody();
      },
    }, h('div', { class: 'th-inner' }, c.name, c.type ? h('span', { class: 'th-type' }, c.type.toLowerCase()) : null, ind)));
  });

  function renderBody() {
    const frag = document.createDocumentFragment();
    order.forEach((ri, n) => {
      const r = rows[ri];
      frag.append(h('tr', null, h('td', { class: 'rownum' }, n + 1),
        r.map((v, ci) => h('td', {
          class: isNumeric(v) ? 'num' : '',
          title: typeof v === 'string' && v.length > 60 ? 'Double-click to view the full value' : null,
          ondblclick: () => showValue(v, { column: columns[ci].name }),
          onclick: isBlob(v) ? () => showValue(v, { column: columns[ci].name }) : null,
        }, renderValue(v, { truncate: fullText ? 0 : 150 })))));
    });
    tbody.replaceChildren(frag);
  }
  renderBody();
  return h('div', { class: 'datagrid-wrap' },
    h('table', { class: `datagrid ${fullText ? 'full-text' : ''}` }, h('thead', null, headRow), tbody));
}

export function hexDump(bytes, max = 2048) {
  const lines = [];
  const n = Math.min(bytes.length, max);
  for (let off = 0; off < n; off += 16) {
    const chunk = bytes.subarray(off, Math.min(off + 16, n));
    const hex = [...chunk].map((b) => b.toString(16).padStart(2, '0')).join(' ');
    const ascii = [...chunk].map((b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : '.')).join('');
    lines.push(`${off.toString(16).padStart(8, '0')}  ${hex.padEnd(47)}  |${ascii}|`);
  }
  if (bytes.length > max) lines.push(`… ${fmtBytes(bytes.length - max)} more`);
  return lines.join('\n');
}

const hexToBytes = (hex) => new Uint8Array((hex.match(/../g) || []).map((b) => parseInt(b, 16)));

/**
 * Show a value in a dialog. For BLOBs, `fetchBlob` (optional) loads the full content so it can be
 * previewed and downloaded. `actions` adds extra footer buttons.
 */
export function showValue(v, { column = 'Value', fetchBlob, actions = [] } = {}) {
  const body = h('div');
  const footer = [];
  if (isBlob(v)) {
    body.append(h('div', { class: 'row mb' },
      h('span', { class: 'badge blue' }, v.mime || 'application/octet-stream'),
      h('span', { class: 'badge' }, fmtBytes(v.size))));
    const preview = h('div');
    body.append(preview);
    if (v.hex) preview.append(h('pre', { class: 'code' }, hexDump(hexToBytes(v.hex))));
    if (fetchBlob) {
      let loaded = null;
      fetchBlob().then((blob) => {
        loaded = blob;
        preview.replaceChildren();
        if (v.mime && v.mime.startsWith('image/')) {
          const url = URL.createObjectURL(blob);
          preview.append(h('div', { style: { textAlign: 'center', marginBottom: '12px', background: 'var(--surface-2)', borderRadius: '6px', padding: '10px' } },
            h('img', { src: url, alt: column, style: { maxWidth: '100%', maxHeight: '50vh', imageRendering: blob.size < 2048 ? 'pixelated' : 'auto', minWidth: '48px' } })));
        }
        return blob.arrayBuffer().then((buf) => preview.append(h('pre', { class: 'code' }, hexDump(new Uint8Array(buf)))));
      }).catch((e) => preview.append(h('div', { class: 'danger-text' }, e.message)));
      footer.push(h('button', {
        class: 'btn', onclick: async () => {
          try {
            const blob = loaded || await fetchBlob();
            const ext = (v.mime || '').split('/')[1] || 'bin';
            saveBlob(blob, `${column}.${ext.replace('x-', '').replace('jpeg', 'jpg')}`);
          } catch (e) { toast(e.message, 'error'); }
        },
      }, icon('download', 15), 'Download'));
    } else if (v.size > v.hex.length / 2) {
      body.append(h('p', { class: 'muted small' }, `Showing the first ${v.hex.length / 2} bytes.`));
    }
  } else {
    const text = valueText(v);
    if (text === null) {
      body.append(h('p', { class: 'v-null' }, 'NULL'));
    } else {
      let pretty = null;
      if (/^\s*[[{]/.test(text)) {
        try { pretty = JSON.stringify(JSON.parse(text), null, 2); } catch { /* not JSON */ }
      }
      const pre = h('pre', { class: 'code', style: { maxHeight: '60vh' } }, pretty ?? text);
      if (pretty) {
        let showPretty = true;
        body.append(h('div', { class: 'row mb' }, h('span', { class: 'badge green' }, 'JSON'),
          h('button', {
            class: 'btn btn-sm', onclick: (e) => {
              showPretty = !showPretty;
              pre.textContent = showPretty ? pretty : text;
              e.currentTarget.textContent = showPretty ? 'Show raw' : 'Pretty print';
            },
          }, 'Show raw')));
      }
      body.append(pre, h('p', { class: 'muted small mt' }, `${text.length.toLocaleString()} characters`));
      footer.push(h('button', { class: 'btn', onclick: () => copyText(text) }, icon('copy', 15), 'Copy'));
    }
  }
  const m = openModal({
    title: column,
    size: 'wide',
    body,
    footer: [...actions.map((a) => h('button', { class: 'btn', onclick: () => { m.close(); a.onClick(); } }, a.icon ? icon(a.icon, 15) : null, a.label)),
      ...footer, h('button', { class: 'btn btn-primary', onclick: () => m.close() }, 'Close')],
  });
  return m;
}
