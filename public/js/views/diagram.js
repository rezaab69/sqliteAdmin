// Designer tab: an entity-relationship diagram of tables, views and foreign keys.
import { h, icon, store, saveText } from '../util.js';
import { loadSchema, go, href } from '../app.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const BOX_W = 220;
const HEAD_H = 28;
const ROW_H = 20;
const PAD = 40;

function svg(tag, attrs = {}, ...children) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== null && v !== undefined) el.setAttribute(k, v);
  for (const c of children) if (c !== null && c !== undefined) el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return el;
}

const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

/** Place tables in columns by foreign-key depth: referenced (parent) tables on the left. */
function autoLayout(tables) {
  const byName = new Map(tables.map((t) => [t.name.toLowerCase(), t]));
  const depth = new Map();
  const visit = (t, stack) => {
    if (depth.has(t.name)) return depth.get(t.name);
    if (stack.has(t.name)) return 0;
    stack.add(t.name);
    let d = 0;
    for (const fk of t.fks || []) {
      const parent = byName.get(fk.table.toLowerCase());
      if (parent && parent !== t) d = Math.max(d, visit(parent, stack) + 1);
    }
    stack.delete(t.name);
    depth.set(t.name, d);
    return d;
  };
  tables.forEach((t) => visit(t, new Set()));
  const columns = [];
  for (const t of tables) {
    const d = t.type === 'view' ? Math.max(0, ...depth.values()) + 1 : depth.get(t.name);
    (columns[d] ||= []).push(t);
  }
  const pos = {};
  let x = PAD;
  for (const col of columns.filter(Boolean)) {
    let y = PAD;
    for (const t of col) {
      pos[t.name] = { x, y };
      y += HEAD_H + t.columns.length * ROW_H + 10 + 36;
    }
    x += BOX_W + 110;
  }
  return pos;
}

export async function renderDiagram(container, route) {
  const { db } = route;
  const schema = await loadSchema(db);
  const tables = schema.tables.filter((t) => !t.system && t.type !== 'shadow');
  if (!tables.length) {
    container.replaceChildren(h('div', { class: 'empty' }, icon('diagram', 40), h('p', null, 'No tables to show yet.'),
      h('a', { class: 'btn btn-primary', href: href({ db, tab: 'newtable' }) }, 'Create a table')));
    return;
  }
  const key = `er:${db}`;
  let pos = { ...autoLayout(tables), ...store.get(key, {}) };
  let scale = store.get('er:scale', 1);

  const root = svg('svg', { xmlns: SVG_NS });
  const linkLayer = svg('g');
  const tableLayer = svg('g');
  root.append(linkLayer, tableLayer);
  const wrap = h('div', { class: 'er-wrap' }, root);

  const heightOf = (t) => HEAD_H + t.columns.length * ROW_H + 8;
  const groups = new Map();
  const links = [];

  for (const t of tables) {
    const g = svg('g', { class: `er-table ${t.type === 'view' ? 'view' : ''}` });
    const hgt = heightOf(t);
    g.append(
      svg('rect', { class: 'box', width: BOX_W, height: hgt, rx: 6 }),
      svg('rect', { class: 'head', width: BOX_W, height: HEAD_H, rx: 6 }),
      svg('rect', { class: 'head', y: HEAD_H - 6, width: BOX_W, height: 6 }),
      svg('text', { class: 'title', x: 10, y: 18 }, clip(t.name, 26), t.type === 'view' ? ' (view)' : ''));
    t.columns.forEach((c, i) => {
      const y = HEAD_H + i * ROW_H + 15;
      g.append(svg('text', { x: 10, y, class: c.pk ? 'pk' : '' }, c.pk ? '🔑 ' : '', clip(c.name, 20)),
        svg('text', { x: BOX_W - 8, y, class: 'type', 'text-anchor': 'end' }, clip((c.type || '').toLowerCase(), 12)));
    });
    tableLayer.append(g);
    groups.set(t.name, { g, t });
  }

  const colIndex = (t, name) => Math.max(0, t.columns.findIndex((c) => c.name.toLowerCase() === String(name).toLowerCase()));
  for (const t of tables) {
    for (const fk of t.fks || []) {
      const parent = tables.find((x) => x.name.toLowerCase() === fk.table.toLowerCase());
      if (!parent) continue;
      const path = svg('path', { class: 'er-link' });
      path.append(svg('title', {}, `${t.name}(${fk.from.join(', ')}) → ${parent.name}(${fk.to.join(', ')})`));
      linkLayer.append(path);
      links.push({ path, child: t, parent, from: colIndex(t, fk.from[0]), to: colIndex(parent, fk.to[0]) });
    }
  }

  function drawLinks() {
    for (const l of links) {
      const a = pos[l.child.name];
      const b = pos[l.parent.name];
      const y1 = a.y + HEAD_H + l.from * ROW_H + ROW_H / 2;
      const y2 = b.y + HEAD_H + l.to * ROW_H + ROW_H / 2;
      let x1;
      let x2;
      let c1;
      let c2;
      if (l.child === l.parent) {
        x1 = a.x + BOX_W; x2 = a.x + BOX_W; c1 = x1 + 50; c2 = x2 + 50;
      } else if (a.x > b.x + BOX_W) {
        x1 = a.x; x2 = b.x + BOX_W; c1 = x1 - 60; c2 = x2 + 60;
      } else if (a.x + BOX_W < b.x) {
        x1 = a.x + BOX_W; x2 = b.x; c1 = x1 + 60; c2 = x2 - 60;
      } else {
        x1 = a.x; x2 = b.x; c1 = x1 - 60; c2 = x2 - 60;
      }
      l.path.setAttribute('d', `M${x1},${y1} C${c1},${y1} ${c2},${y2} ${x2},${y2}`);
      l.path.setAttribute('marker-end', 'url(#er-arrow)');
    }
  }

  function place() {
    let maxX = 0;
    let maxY = 0;
    for (const [name, { g, t }] of groups) {
      const p = pos[name];
      g.setAttribute('transform', `translate(${p.x},${p.y})`);
      maxX = Math.max(maxX, p.x + BOX_W);
      maxY = Math.max(maxY, p.y + heightOf(t));
    }
    const w = maxX + PAD * 2;
    const hgt = maxY + PAD * 2;
    root.setAttribute('viewBox', `0 0 ${w} ${hgt}`);
    root.setAttribute('width', w * scale);
    root.setAttribute('height', hgt * scale);
    drawLinks();
  }

  root.prepend(svg('defs', {}, svg('marker', { id: 'er-arrow', viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse' },
    svg('path', { d: 'M0,0 L10,5 L0,10 z', fill: 'var(--text-3)' }))));

  // Dragging and hover highlighting
  for (const [name, { g, t }] of groups) {
    g.addEventListener('pointerenter', () => {
      g.classList.add('hover');
      links.forEach((l) => { if (l.child === t || l.parent === t) l.path.classList.add('hover'); });
    });
    g.addEventListener('pointerleave', () => {
      g.classList.remove('hover');
      links.forEach((l) => l.path.classList.remove('hover'));
    });
    g.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      g.setPointerCapture(e.pointerId);
      const start = { x: e.clientX, y: e.clientY, px: pos[name].x, py: pos[name].y };
      let moved = false;
      tableLayer.append(g);
      const move = (ev) => {
        const dx = (ev.clientX - start.x) / scale;
        const dy = (ev.clientY - start.y) / scale;
        if (Math.abs(dx) + Math.abs(dy) > 3) moved = true;
        pos[name] = { x: Math.max(0, Math.round(start.px + dx)), y: Math.max(0, Math.round(start.py + dy)) };
        place();
      };
      const up = () => {
        g.removeEventListener('pointermove', move);
        g.removeEventListener('pointerup', up);
        if (moved) store.set(key, pos);
        else if (e.target.classList.contains('title')) go({ db, table: name, tab: 'structure' });
      };
      g.addEventListener('pointermove', move);
      g.addEventListener('pointerup', up);
    });
  }

  const zoom = (f) => {
    scale = Math.min(2, Math.max(0.3, Math.round(scale * f * 100) / 100));
    store.set('er:scale', scale);
    place();
  };

  const exportSvg = () => {
    const css = getComputedStyle(document.documentElement);
    const v = (n) => css.getPropertyValue(n).trim();
    const clone = root.cloneNode(true);
    clone.setAttribute('width', root.viewBox.baseVal.width);
    clone.setAttribute('height', root.viewBox.baseVal.height);
    clone.prepend(svg('style', {}, `
      .er-table rect.box{fill:${v('--surface')};stroke:${v('--border-strong')}}
      .er-table rect.head{fill:${v('--primary')}} .er-table.view rect.head{fill:#7c3aed}
      text{font:12px system-ui,sans-serif;fill:${v('--text')}} text.title{fill:#fff;font-weight:600}
      text.type{fill:${v('--text-3')};font-size:11px} text.pk{fill:#d97706;font-weight:700}
      .er-link{fill:none;stroke:${v('--text-3')};stroke-width:1.4} marker path{fill:${v('--text-3')}}`));
    clone.prepend(svg('rect', { width: '100%', height: '100%', fill: v('--surface-2') }));
    saveText(new XMLSerializer().serializeToString(clone), `${db.replace(/\.[^.]+$/, '')}-schema.svg`, 'image/svg+xml');
  };

  container.replaceChildren(
    h('div', { class: 'grid-toolbar' },
      h('span', { class: 'muted small' }, `${tables.length} objects · ${links.length} relations. Drag tables to arrange them; click a title to open it.`),
      h('div', { class: 'grow' }),
      h('button', { class: 'icon-btn', title: 'Zoom out', onclick: () => zoom(1 / 1.2) }, '−'),
      h('button', { class: 'icon-btn', title: 'Reset zoom', onclick: () => { scale = 1; store.set('er:scale', 1); place(); } }, '1:1'),
      h('button', { class: 'icon-btn', title: 'Zoom in', onclick: () => zoom(1.2) }, '+'),
      h('button', { class: 'btn btn-sm', onclick: () => { pos = autoLayout(tables); store.set(key, {}); place(); } }, icon('refresh', 14), 'Auto layout'),
      h('button', { class: 'btn btn-sm', onclick: exportSvg }, icon('download', 14), 'Export SVG')),
    wrap);
  place();
}
