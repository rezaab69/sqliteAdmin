// A lightweight SQL editor: a transparent <textarea> over a highlighted <pre>, with line numbers,
// auto-indent, comment toggling and schema-aware autocompletion.
import { h, highlightSql, qi } from './util.js';
import { KEYWORDS, FUNCTIONS } from './shared/sql.js';

const LINE_HEIGHT = 20;
const PAD = 10;
const PAD_X = 12;
let charWidth = 0;

function measureCharWidth(ref) {
  if (charWidth) return charWidth;
  const probe = h('span', { style: { position: 'absolute', visibility: 'hidden', whiteSpace: 'pre', font: getComputedStyle(ref).font } }, 'M'.repeat(100));
  document.body.append(probe);
  charWidth = probe.getBoundingClientRect().width / 100 || 7.8;
  probe.remove();
  return charWidth;
}

const needsQuote = (name) => !/^[A-Za-z_][A-Za-z0-9_$]*$/.test(name) || KEYWORDS.has(name.toUpperCase());
const unquote = (s) => s.replace(/^["`[]|["`\]]$/g, '');

/**
 * @param {object} opts
 * @param {string} [opts.value]
 * @param {() => void} [opts.onRun]      Ctrl+Enter handler
 * @param {(v: string) => void} [opts.onChange]
 * @param {() => object|null} [opts.schema]  returns {tables:[{name, columns:[{name,type}]}]}
 * @param {string} [opts.placeholder]
 * @param {number} [opts.height]
 */
export function createSqlEditor({ value = '', onRun, onChange, schema, placeholder = '', height, readOnly = false } = {}) {
  const gutter = h('div', { class: 'sqled-gutter', 'aria-hidden': 'true' });
  const code = h('code');
  const pre = h('pre', { class: 'sqled-hl', 'aria-hidden': 'true' }, code);
  const ta = h('textarea', {
    class: 'sqled-ta', spellcheck: false, wrap: 'off', autocapitalize: 'off', autocomplete: 'off',
    placeholder, 'aria-label': 'SQL editor', readOnly,
  });
  ta.value = value;
  const el = h('div', { class: 'sqled' }, gutter, h('div', { class: 'sqled-main' }, pre, ta));
  if (height) el.style.height = `${height}px`;

  let lineCount = 0;
  function render() {
    code.innerHTML = highlightSql(ta.value) + '\n';
    const n = ta.value.split('\n').length;
    if (n !== lineCount) {
      lineCount = n;
      gutter.textContent = Array.from({ length: n }, (_, i) => i + 1).join('\n') + '\n\n\n';
    }
    syncScroll();
  }
  function syncScroll() {
    pre.scrollTop = ta.scrollTop;
    pre.scrollLeft = ta.scrollLeft;
    gutter.scrollTop = ta.scrollTop;
  }

  function insertText(text, selectStart, selectEnd) {
    ta.focus();
    // execCommand keeps the browser's undo history intact.
    if (!document.execCommand('insertText', false, text)) {
      ta.setRangeText(text, ta.selectionStart, ta.selectionEnd, 'end');
    }
    if (selectStart !== undefined) ta.setSelectionRange(selectStart, selectEnd ?? selectStart);
    render();
    if (onChange) onChange(ta.value);
  }

  function replaceRange(start, end, text) {
    ta.setSelectionRange(start, end);
    insertText(text);
  }

  // ------------------------------------------------------------------ autocomplete
  let ac = null;

  function closeAc() {
    if (ac) { ac.el.remove(); ac = null; }
  }

  function tableAliases(sql) {
    const map = new Map();
    const re = /\b(?:FROM|JOIN|UPDATE|INTO)\s+("[^"]+"|`[^`]+`|\[[^\]]+\]|[\w$]+)(?:\s+(?:AS\s+)?([\w$]+))?/gi;
    let m;
    while ((m = re.exec(sql))) {
      const table = unquote(m[1]);
      map.set(table.toLowerCase(), table);
      if (m[2] && !KEYWORDS.has(m[2].toUpperCase())) map.set(m[2].toLowerCase(), table);
    }
    return map;
  }

  function candidates(force) {
    const pos = ta.selectionStart;
    const before = ta.value.slice(0, pos);
    const wordMatch = /[\w$]*$/.exec(before);
    const prefix = wordMatch[0];
    const start = pos - prefix.length;
    if (!force && prefix.length < 1) return null;
    if (/^\d/.test(prefix)) return null;
    // Don't complete inside strings or comments.
    const lineBefore = before.slice(before.lastIndexOf('\n') + 1);
    if ((lineBefore.split("'").length - 1) % 2 === 1 || lineBefore.includes('--')) return null;

    const sch = schema ? schema() : null;
    const tables = sch ? sch.tables.filter((t) => !t.system || t.name === 'sqlite_sequence') : [];
    const lower = prefix.toLowerCase();
    const items = [];
    const qual = /("[^"]+"|[\w$]+)\.[\w$]*$/.exec(before);
    if (qual) {
      const aliases = tableAliases(ta.value);
      const tname = aliases.get(unquote(qual[1]).toLowerCase()) || unquote(qual[1]);
      const t = tables.find((x) => x.name.toLowerCase() === tname.toLowerCase());
      if (t) for (const c of t.columns) items.push({ label: c.name, kind: c.type || 'column', insert: needsQuote(c.name) ? qi(c.name) : c.name });
    } else {
      const referenced = new Set([...tableAliases(ta.value).values()].map((t) => t.toLowerCase()));
      const seen = new Set();
      for (const t of tables) {
        if (!referenced.has(t.name.toLowerCase())) continue;
        for (const c of t.columns) {
          if (seen.has(c.name)) continue;
          seen.add(c.name);
          items.push({ label: c.name, kind: `${t.name}`, insert: needsQuote(c.name) ? qi(c.name) : c.name });
        }
      }
      for (const t of tables) items.push({ label: t.name, kind: t.type, insert: needsQuote(t.name) ? qi(t.name) : t.name });
      for (const k of KEYWORDS) items.push({ label: k, kind: 'keyword', insert: k });
      for (const f of FUNCTIONS) items.push({ label: f, kind: 'function', insert: f + '(' });
      if (!referenced.size) {
        for (const t of tables) {
          for (const c of t.columns) {
            if (seen.has(c.name)) continue;
            seen.add(c.name);
            items.push({ label: c.name, kind: t.name, insert: needsQuote(c.name) ? qi(c.name) : c.name });
          }
        }
      }
    }
    const list = items.filter((it) => it.label.toLowerCase().startsWith(lower) && (force || it.label.toLowerCase() !== lower)).slice(0, 60);
    if (!list.length) return null;
    return { list, start, end: pos };
  }

  function openAc(force = false) {
    const c = candidates(force);
    if (!c) { closeAc(); return; }
    if (!ac) {
      ac = { el: h('div', { class: 'ac-popup', role: 'listbox' }), index: 0 };
      document.body.append(ac.el);
    }
    ac.list = c.list;
    ac.start = c.start;
    ac.end = c.end;
    ac.index = Math.min(ac.index, c.list.length - 1);
    renderAc();
    positionAc();
  }

  function renderAc() {
    ac.el.replaceChildren(...ac.list.map((it, i) => h('div', {
      class: `ac-item ${i === ac.index ? 'active' : ''}`, role: 'option',
      onmousedown: (e) => { e.preventDefault(); ac.index = i; acceptAc(); },
    }, h('span', null, it.label), h('span', { class: 'kind' }, it.kind))));
    const active = ac.el.children[ac.index];
    if (active) active.scrollIntoView({ block: 'nearest' });
  }

  function positionAc() {
    const cw = measureCharWidth(ta);
    const before = ta.value.slice(0, ac.start);
    const line = before.split('\n').length - 1;
    const col = before.length - before.lastIndexOf('\n') - 1;
    const r = ta.getBoundingClientRect();
    let x = r.left + PAD_X + col * cw - ta.scrollLeft;
    let y = r.top + PAD + (line + 1) * LINE_HEIGHT - ta.scrollTop + 2;
    const pr = ac.el.getBoundingClientRect();
    if (y + pr.height > window.innerHeight - 8) y = y - pr.height - LINE_HEIGHT - 4;
    x = Math.min(x, window.innerWidth - pr.width - 8);
    ac.el.style.left = `${Math.max(4, x)}px`;
    ac.el.style.top = `${Math.max(4, y)}px`;
  }

  function acceptAc() {
    const it = ac.list[ac.index];
    const { start, end } = ac;
    closeAc();
    replaceRange(start, end, it.insert);
  }

  // ------------------------------------------------------------------ editing helpers
  function currentLines() {
    const v = ta.value;
    const s = v.lastIndexOf('\n', ta.selectionStart - 1) + 1;
    let e = v.indexOf('\n', ta.selectionEnd - (ta.selectionEnd > ta.selectionStart && v[ta.selectionEnd - 1] === '\n' ? 1 : 0));
    if (e < 0) e = v.length;
    return { s, e };
  }

  function toggleComment() {
    const { s, e } = currentLines();
    const block = ta.value.slice(s, e);
    const lines = block.split('\n');
    const allCommented = lines.filter((l) => l.trim()).every((l) => /^\s*--/.test(l));
    const out = lines.map((l) => (allCommented ? l.replace(/^(\s*)-- ?/, '$1') : (l.trim() ? '-- ' + l : l))).join('\n');
    replaceRange(s, e, out);
    ta.setSelectionRange(s, s + out.length);
  }

  function indentSelection(outdent) {
    const { s, e } = currentLines();
    const lines = ta.value.slice(s, e).split('\n');
    const out = lines.map((l) => (outdent ? l.replace(/^ {1,2}|^\t/, '') : '  ' + l)).join('\n');
    replaceRange(s, e, out);
    ta.setSelectionRange(s, s + out.length);
  }

  ta.addEventListener('input', () => {
    render();
    if (onChange) onChange(ta.value);
    const ch = ta.value[ta.selectionStart - 1];
    if (ch && /[\w$.]/.test(ch)) openAc(false);
    else closeAc();
  });
  ta.addEventListener('scroll', () => { syncScroll(); if (ac) positionAc(); });
  ta.addEventListener('blur', () => setTimeout(closeAc, 100));
  ta.addEventListener('click', closeAc);

  ta.addEventListener('keydown', (e) => {
    const mod = e.ctrlKey || e.metaKey;
    if (ac) {
      if (e.key === 'ArrowDown') { e.preventDefault(); ac.index = (ac.index + 1) % ac.list.length; renderAc(); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); ac.index = (ac.index - 1 + ac.list.length) % ac.list.length; renderAc(); return; }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); acceptAc(); return; }
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeAc(); return; }
    }
    if (mod && e.key === 'Enter') { e.preventDefault(); closeAc(); if (onRun) onRun(); return; }
    if (mod && e.key === ' ') { e.preventDefault(); openAc(true); return; }
    if (mod && e.key === '/') { e.preventDefault(); toggleComment(); return; }
    if (readOnly) return;
    if (e.key === 'Tab') {
      e.preventDefault();
      if (ta.selectionStart !== ta.selectionEnd && ta.value.slice(ta.selectionStart, ta.selectionEnd).includes('\n')) indentSelection(e.shiftKey);
      else if (e.shiftKey) indentSelection(true);
      else insertText('  ');
      return;
    }
    if (e.key === 'Enter' && !mod && !e.shiftKey && !e.altKey) {
      const v = ta.value;
      const lineStart = v.lastIndexOf('\n', ta.selectionStart - 1) + 1;
      const indent = /^[ \t]*/.exec(v.slice(lineStart, ta.selectionStart))[0];
      if (indent) { e.preventDefault(); insertText('\n' + indent); }
    }
  });

  render();

  return {
    el,
    textarea: ta,
    getValue: () => ta.value,
    setValue(v) {
      ta.value = v;
      render();
      if (onChange) onChange(v);
    },
    /** The selected text, or the whole content when nothing is selected. */
    getSelectedOrAll() {
      const sel = ta.value.slice(ta.selectionStart, ta.selectionEnd);
      return sel.trim() ? sel : ta.value;
    },
    hasSelection: () => ta.selectionStart !== ta.selectionEnd && ta.value.slice(ta.selectionStart, ta.selectionEnd).trim() !== '',
    insert(text) { insertText(text); },
    focus() { ta.focus(); },
    refresh: render,
  };
}
