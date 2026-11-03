// DOM helpers, dialogs, formatting and small utilities for the client.
import { tokenize, KEYWORDS, FUNCTIONS, TYPES } from './shared/sql.js';

// ---------------------------------------------------------------------------------------------
// DOM

// Views pass optional children (cond ? node : null) to append/replaceChildren. The native methods
// would render those as the text "null", so skip empty values (and flatten arrays) everywhere.
for (const proto of [Element.prototype, DocumentFragment.prototype]) {
  for (const name of ['append', 'prepend', 'replaceChildren']) {
    const native = proto[name];
    proto[name] = function appendNonEmpty(...nodes) {
      return native.apply(this, nodes.flat(Infinity).filter((n) => n !== null && n !== undefined && n !== false));
    };
  }
}

const PROPS = new Set(['value', 'checked', 'selected', 'disabled', 'readOnly', 'multiple', 'indeterminate',
  'htmlFor', 'innerHTML', 'textContent', 'spellcheck', 'tabIndex', 'draggable']);

export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (PROPS.has(k)) el[k] = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
  }
  append(el, children);
  return el;
}

export function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
  return el;
}

export function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------------------------------------------------------------------------------------------
// Icons (24x24 stroke icons)

const ICONS = {
  database: '<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5"/><path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"/>',
  table: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 10h18M3 15h18M9 10v10"/>',
  view: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  key: '<circle cx="7.5" cy="15.5" r="4.5"/><path d="M10.7 12.3 21 2M16 7l3 3M18 5l2 2"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  trash: '<path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v6M14 11v6"/>',
  edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
  copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1"/>',
  play: '<path d="M7 4.5v15l12.5-7.5z"/>',
  download: '<path d="M12 3v12M7 10l5 5 5-5M5 21h14"/>',
  upload: '<path d="M12 21V9M7 14l5-5 5 5M5 3h14"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  moon: '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>',
  refresh: '<path d="M21 12a9 9 0 1 1-2.6-6.4L21 8"/><path d="M21 3v5h-5"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  'chevron-down': '<path d="m6 9 6 6 6-6"/>',
  'chevron-right': '<path d="m9 6 6 6-6 6"/>',
  'chevron-left': '<path d="m15 6-6 6 6 6"/>',
  'chevrons-left': '<path d="m11 17-5-5 5-5M18 17l-5-5 5-5"/>',
  'chevrons-right': '<path d="m13 17 5-5-5-5M6 17l5-5-5-5"/>',
  link: '<path d="M7 17 17 7M8 7h9v9"/>',
  index: '<path d="M4 6h16M4 12h10M4 18h6"/>',
  trigger: '<path d="M13 2 4 14h7l-1 8 9-12h-7z"/>',
  diagram: '<rect x="3" y="3" width="7" height="6" rx="1"/><rect x="14" y="15" width="7" height="6" rx="1"/><rect x="14" y="3" width="7" height="6" rx="1"/><path d="M10 6h4M17.5 9v6"/>',
  code: '<path d="m8 7-5 5 5 5M16 7l5 5-5 5"/>',
  structure: '<path d="M3 5h6M3 12h6M3 19h6M13 5h8M13 12h8M13 19h8"/>',
  grid: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M3 15h18M9 3v18M15 3v18"/>',
  'plus-square': '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M12 8v8M8 12h8"/>',
  sliders: '<path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6"/>',
  info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/>',
  alert: '<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4M12 17h.01"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  menu: '<path d="M3 6h18M3 12h18M3 18h18"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  filter: '<path d="M22 3H2l8 9.5V19l4 2v-8.5z"/>',
  history: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  bookmark: '<path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/>',
  format: '<path d="M4 6h16M8 12h12M8 18h8M4 12h.01M4 18h.01"/>',
  server: '<rect x="2" y="3" width="20" height="8" rx="2"/><rect x="2" y="13" width="20" height="8" rx="2"/><path d="M6 7h.01M6 17h.01"/>',
  file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/>',
  'arrow-up': '<path d="M12 19V5M5 12l7-7 7 7"/>',
  'arrow-down': '<path d="M12 5v14M19 12l-7 7-7-7"/>',
  image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-5-5L5 21"/>',
  save: '<path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><path d="M17 21v-8H7v8M7 3v5h8"/>',
  tool: '<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.8-3.8a6 6 0 0 1-7.9 7.9l-6.9 6.9a2.1 2.1 0 0 1-3-3l6.9-6.9a6 6 0 0 1 7.9-7.9z"/>',
  columns: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M12 3v18"/>',
  lock: '<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
  eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  maximize: '<path d="M8 3H5a2 2 0 0 0-2 2v3M21 8V5a2 2 0 0 0-2-2h-3M3 16v3a2 2 0 0 0 2 2h3M16 21h3a2 2 0 0 0 2-2v-3"/>',
};

export function icon(name, size = 16, extraClass = '') {
  const span = document.createElement('span');
  span.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" class="${extraClass}">${ICONS[name] || ''}</svg>`;
  return span.firstChild;
}

// ---------------------------------------------------------------------------------------------
// Toasts

let toastBox;
export function toast(message, type = 'info', { sql, timeout } = {}) {
  if (!toastBox) {
    toastBox = h('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' });
    document.body.append(toastBox);
  }
  const ic = { success: 'check', error: 'alert', info: 'info' }[type] || 'info';
  const el = h('div', { class: `toast ${type}` },
    icon(ic, 18, type === 'error' ? 'danger-text' : type === 'success' ? 'success-text' : ''),
    h('div', { class: 'msg' }, message, sql ? h('code', null, sql) : null),
    h('button', { class: 'icon-btn sm', title: 'Dismiss', onclick: () => el.remove() }, icon('x', 14)));
  toastBox.append(el);
  const ms = timeout ?? (type === 'error' ? 9000 : 4000);
  if (ms) setTimeout(() => el.remove(), ms);
  return el;
}

// ---------------------------------------------------------------------------------------------
// Modals

const modalStack = [];
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || !modalStack.length) return;
  const top = modalStack[modalStack.length - 1];
  if (document.querySelector('.ac-popup, .ctx-menu')) return;
  e.preventDefault();
  e.stopPropagation();
  top.close();
}, true);

/**
 * Open a modal dialog. `body` and `footer` may be nodes or arrays of nodes.
 * Returns { close(result), el, body }.
 */
export function openModal({ title, body, footer, size = '', onClose, initialFocus }) {
  const prevFocus = document.activeElement;
  let closed = false;
  const bodyEl = h('div', { class: 'modal-body' }, body);
  const modal = h('div', { class: `modal ${size}`, role: 'dialog', 'aria-modal': 'true', 'aria-label': typeof title === 'string' ? title : 'Dialog' },
    h('div', { class: 'modal-header' },
      h('h2', null, title),
      h('button', { class: 'icon-btn', title: 'Close (Esc)', onclick: () => api.close() }, icon('x'))),
    bodyEl,
    footer ? h('div', { class: 'modal-footer' }, footer) : null);
  const backdrop = h('div', { class: 'modal-backdrop' }, modal);
  document.body.append(backdrop);
  const api = {
    el: modal,
    body: bodyEl,
    close(result) {
      if (closed) return;
      closed = true;
      backdrop.remove();
      const i = modalStack.indexOf(api);
      if (i >= 0) modalStack.splice(i, 1);
      if (prevFocus && prevFocus.focus) prevFocus.focus();
      if (onClose) onClose(result);
    },
  };
  modalStack.push(api);
  requestAnimationFrame(() => {
    const target = initialFocus || modal.querySelector('[autofocus], .modal-body input:not([type=checkbox]):not([type=radio]):not([disabled]), .modal-body textarea, .modal-body select, .modal-footer .btn-primary');
    if (target) target.focus();
  });
  return api;
}

export function confirmDialog({ title = 'Please confirm', message, sql, okLabel = 'OK', danger = false }) {
  return new Promise((resolve) => {
    let result = false;
    const ok = h('button', { class: `btn ${danger ? 'btn-danger solid' : 'btn-primary'}`, onclick: () => { result = true; m.close(); } }, okLabel);
    const m = openModal({
      title,
      body: [
        typeof message === 'string' ? h('p', null, message) : message,
        sql ? codeBlock(sql) : null,
      ],
      footer: [h('button', { class: 'btn', onclick: () => m.close() }, 'Cancel'), ok],
      onClose: () => resolve(result),
      initialFocus: ok,
    });
  });
}

export function promptDialog({ title, label, value = '', placeholder = '', okLabel = 'OK', hint, validate }) {
  return new Promise((resolve) => {
    let result = null;
    const input = h('input', { type: 'text', value, placeholder, class: 'w-full', autofocus: true });
    const err = h('div', { class: 'small danger-text' });
    const submit = () => {
      const v = input.value;
      const problem = validate ? validate(v) : (!v.trim() ? 'A value is required' : null);
      if (problem) { err.textContent = problem; input.focus(); return; }
      result = v;
      m.close();
    };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } });
    const m = openModal({
      title,
      body: h('div', { class: 'field' }, label ? h('label', null, label) : null, input, hint ? h('div', { class: 'hint' }, hint) : null, err),
      footer: [h('button', { class: 'btn', onclick: () => m.close() }, 'Cancel'), h('button', { class: 'btn btn-primary', onclick: submit }, okLabel)],
      onClose: () => resolve(result),
      initialFocus: input,
    });
    requestAnimationFrame(() => input.select());
  });
}

// ---------------------------------------------------------------------------------------------
// Context menu

let openMenu = null;
export function closeMenu() {
  if (openMenu) { openMenu.remove(); openMenu = null; }
}
document.addEventListener('mousedown', (e) => { if (openMenu && !openMenu.contains(e.target)) closeMenu(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenu(); });
window.addEventListener('blur', closeMenu);

export function showMenu(x, y, items) {
  closeMenu();
  const menu = h('div', { class: 'ctx-menu', role: 'menu' },
    items.filter(Boolean).map((it) => (it === '-' ? h('hr') : h('button', {
      class: it.danger ? 'danger' : '', role: 'menuitem',
      onclick: () => { closeMenu(); it.onClick(); },
    }, it.icon ? icon(it.icon, 15) : null, it.label))));
  document.body.append(menu);
  const r = menu.getBoundingClientRect();
  menu.style.left = Math.min(x, window.innerWidth - r.width - 8) + 'px';
  menu.style.top = Math.min(y, window.innerHeight - r.height - 8) + 'px';
  openMenu = menu;
  const first = menu.querySelector('button');
  if (first) first.focus();
}

// ---------------------------------------------------------------------------------------------
// Formatting

export function fmtNum(n) {
  if (n === null || n === undefined) return '—';
  return Number(n).toLocaleString();
}

export function fmtBytes(n) {
  if (n === null || n === undefined) return '—';
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let u = -1;
  do { n /= 1024; u++; } while (n >= 1024 && u < units.length - 1);
  return `${n.toFixed(n < 10 ? 1 : 0)} ${units[u]}`;
}

export function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function fmtMs(ms) {
  if (ms === undefined || ms === null) return '';
  return ms < 1000 ? `${ms.toFixed(ms < 10 ? 2 : 1)} ms` : `${(ms / 1000).toFixed(2)} s`;
}

export const plural = (n, word, pluralWord = word + 's') => `${fmtNum(n)} ${n === 1 ? word : pluralWord}`;

// ---------------------------------------------------------------------------------------------
// Values coming from the API

export const isBlob = (v) => v !== null && typeof v === 'object' && '$blob' in v;
export const isNumeric = (v) => typeof v === 'number' || (v !== null && typeof v === 'object' && ('$bigint' in v || '$real' in v));

/** Text form of a value (null stays null). */
export function valueText(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'object') {
    if ('$bigint' in v) return v.$bigint;
    if ('$real' in v) return v.$real;
    if (isBlob(v)) return v.hex !== undefined ? `x'${v.hex}${v.size > v.hex.length / 2 ? '…' : ''}'` : '[blob]';
    return JSON.stringify(v);
  }
  return String(v);
}

const MIME_LABEL = { 'image/png': 'PNG', 'image/jpeg': 'JPEG', 'image/gif': 'GIF', 'image/webp': 'WEBP', 'application/pdf': 'PDF', 'application/zip': 'ZIP', 'application/gzip': 'GZIP', 'application/x-sqlite3': 'SQLite', 'image/bmp': 'BMP', 'image/x-icon': 'ICO' };

/** Render a value into a node suitable for a table cell. */
export function renderValue(v, { truncate = 150 } = {}) {
  if (v === null || v === undefined) return h('span', { class: 'v-null' }, 'NULL');
  if (isBlob(v)) {
    const label = MIME_LABEL[v.mime];
    return h('span', { class: 'v-blob', title: 'Click to view' },
      icon(v.mime && v.mime.startsWith('image/') ? 'image' : 'file', 12),
      `${label ? label + ' · ' : 'BLOB · '}${fmtBytes(v.size)}`);
  }
  const text = valueText(v);
  if (text === '') return h('span', { class: 'v-empty' }, '(empty)');
  if (truncate && text.length > truncate) return document.createTextNode(text.slice(0, truncate) + '…');
  return document.createTextNode(text);
}

// ---------------------------------------------------------------------------------------------
// SQL highlighting

export function highlightSql(sql) {
  let out = '';
  for (const t of tokenize(sql)) {
    const text = esc(t.text);
    let cls = null;
    switch (t.type) {
      case 'comment': cls = 'hl-cmt'; break;
      case 'string': case 'blob': cls = 'hl-str'; break;
      case 'number': cls = 'hl-num'; break;
      case 'ident': cls = 'hl-ident'; break;
      case 'param': cls = 'hl-param'; break;
      case 'word': {
        const u = t.text.toUpperCase();
        if (KEYWORDS.has(u)) cls = 'hl-kw';
        else if (TYPES.has(u)) cls = 'hl-type';
        else if (FUNCTIONS.has(t.text.toLowerCase())) cls = 'hl-fn';
        break;
      }
      default: break;
    }
    out += cls ? `<span class="${cls}">${text}</span>` : text;
  }
  return out;
}

export function codeBlock(sql, extraClass = '') {
  const pre = h('pre', { class: `code ${extraClass}` });
  pre.innerHTML = highlightSql(sql);
  return pre;
}

/** Simple SQL formatter: upper-cases keywords and breaks lines before major clauses. */
export function formatSql(sql) {
  const BREAK = new Set(['SELECT', 'FROM', 'WHERE', 'GROUP', 'ORDER', 'HAVING', 'LIMIT', 'UNION', 'EXCEPT', 'INTERSECT',
    'VALUES', 'SET', 'JOIN', 'LEFT', 'RIGHT', 'INNER', 'CROSS', 'FULL', 'NATURAL', 'WINDOW', 'RETURNING']);
  const JOIN_MODS = new Set(['LEFT', 'RIGHT', 'INNER', 'CROSS', 'FULL', 'NATURAL', 'OUTER']);
  let out = '';
  const stack = []; // 'p' = plain parenthesis, 'q' = subquery
  const selectAt = new Set();
  let prev = null;
  let space = false;
  const qdepth = () => stack.filter((s) => s === 'q').length;
  const atQueryLevel = () => !stack.length || stack[stack.length - 1] === 'q';
  const nl = (extra = 0) => { out = out.replace(/[ \t]+$/, '') + '\n' + '  '.repeat(qdepth() + extra); };
  for (const t of tokenize(sql)) {
    if (t.type === 'ws') { space = true; continue; }
    if (t.type === 'comment') {
      if (out && !/\s$/.test(out)) out += ' ';
      out += t.text;
      if (t.text.startsWith('--')) nl();
      prev = null;
      space = false;
      continue;
    }
    const u = t.type === 'word' ? t.text.toUpperCase() : null;
    const pu = prev && prev.type === 'word' ? prev.text.toUpperCase() : null;
    const text = u && KEYWORDS.has(u) ? u : t.text;
    if (t.text === ';') {
      out = out.trimEnd() + ';\n\n';
      stack.length = 0;
      selectAt.clear();
      prev = null;
      space = false;
      continue;
    }
    if (t.text === ')' && stack.pop() === 'q') {
      selectAt.delete(qdepth() + 1);
      nl();
    }
    let broke = false;
    if (u === 'SELECT' && prev && prev.text === '(') {
      stack[stack.length - 1] = 'q';
      nl();
      broke = true;
    } else if (u && BREAK.has(u) && prev && prev.text !== '(' && atQueryLevel()
      && !(u === 'JOIN' && JOIN_MODS.has(pu)) && !(JOIN_MODS.has(u) && JOIN_MODS.has(pu))
      && !(u === 'SET' && (pu === 'DELETE' || pu === 'UPDATE')) && !(u === 'FROM' && pu === 'DELETE')) {
      nl();
      broke = true;
    }
    if (!broke && out && !/[\s(.]$/.test(out) && t.text !== ',' && t.text !== ')' && t.text !== '.'
      && (space || (prev && prev.text === ','))) out += ' ';
    out += text;
    if (t.text === '(') stack.push('p');
    if (u === 'SELECT') {
      selectAt.add(qdepth());
      nl(1);
    }
    if (u === 'FROM' && atQueryLevel()) selectAt.delete(qdepth());
    if (t.text === ',' && atQueryLevel() && selectAt.has(qdepth())) nl(1);
    prev = t;
    space = false;
  }
  return out.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

// ---------------------------------------------------------------------------------------------
// Client-side conversions of result sets

function csvCell(v, delim) {
  const s = valueText(v);
  if (s === null) return '';
  return /["\r\n]/.test(s) || s.includes(delim) || s !== s.trim() ? `"${s.replace(/"/g, '""')}"` : s;
}

export function rowsToCsv(columns, rows, delim = ',') {
  return [columns.map((c) => csvCell(c, delim)).join(delim), ...rows.map((r) => r.map((v) => csvCell(v, delim)).join(delim))].join('\n') + '\n';
}

export function rowsToJson(columns, rows) {
  return JSON.stringify(rows.map((r) => Object.fromEntries(columns.map((c, i) => {
    const v = r[i];
    if (v !== null && typeof v === 'object') return [c, '$bigint' in v ? v.$bigint : '$real' in v ? Number(v.$real) : valueText(v)];
    return [c, v];
  }))), null, 2) + '\n';
}

export function sqlLiteral(v) {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') return String(v);
  if (typeof v === 'object') {
    if ('$bigint' in v) return v.$bigint;
    if ('$real' in v) return v.$real;
    if (isBlob(v)) return v.hex !== undefined && v.size === v.hex.length / 2 ? `X'${v.hex.toUpperCase()}'` : 'NULL /* blob omitted */';
  }
  return `'${String(v).replace(/'/g, "''")}'`;
}

export function qi(name) {
  return '"' + String(name).replace(/"/g, '""') + '"';
}

export function rowsToSql(table, columns, rows) {
  const cols = columns.map(qi).join(', ');
  return rows.map((r) => `INSERT INTO ${qi(table)} (${cols}) VALUES (${r.map(sqlLiteral).join(', ')});`).join('\n') + '\n';
}

export function rowsToMarkdown(columns, rows) {
  const cell = (v) => (valueText(v) ?? 'NULL').replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>');
  return [`| ${columns.map(cell).join(' | ')} |`, `| ${columns.map(() => '---').join(' | ')} |`,
    ...rows.map((r) => `| ${r.map(cell).join(' | ')} |`)].join('\n') + '\n';
}

// ---------------------------------------------------------------------------------------------
// Misc

export function saveBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

export function saveText(text, filename, type = 'text/plain') {
  saveBlob(new Blob([text], { type: `${type};charset=utf-8` }), filename);
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = h('textarea', { value: text, style: { position: 'fixed', opacity: '0' } });
    document.body.append(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
  toast('Copied to clipboard', 'success', { timeout: 1500 });
}

export const store = {
  get(key, dflt) {
    try {
      const v = localStorage.getItem('sqla:' + key);
      return v === null ? dflt : JSON.parse(v);
    } catch {
      return dflt;
    }
  },
  set(key, value) {
    try { localStorage.setItem('sqla:' + key, JSON.stringify(value)); } catch { /* storage unavailable */ }
  },
};

export function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

export function readFileAsText(file) {
  return file.text();
}

export function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] || '');
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

export function loading(text = 'Loading…') {
  return h('div', { class: 'loading' }, h('span', { class: 'spinner' }), text);
}

export function errorBox(e, title) {
  return h('div', { class: 'alert alert-error' }, icon('alert', 18, 'danger-text'),
    h('div', { class: 'grow' }, title ? h('strong', null, title) : null, h('pre', { class: 'mono' }, e && e.message ? e.message : String(e))));
}

export function card({ title, actions, body, flush = false, className = '' }) {
  return h('section', { class: `card ${className}` },
    title || actions ? h('div', { class: 'card-header' }, typeof title === 'string' ? h('h2', null, title) : title,
      actions ? h('div', { class: 'actions' }, actions) : null) : null,
    h('div', { class: `card-body ${flush ? 'flush' : ''}` }, body));
}

/** Create a <select> from [value, label] pairs or plain values. */
export function select(options, value, attrs = {}) {
  return h('select', attrs, options.map((o) => {
    const [v, label] = Array.isArray(o) ? o : [o, o];
    return h('option', { value: v, selected: String(v) === String(value) }, label);
  }));
}
