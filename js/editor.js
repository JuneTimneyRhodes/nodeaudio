// Node canvas: pan/zoom world, DOM nodes, SVG wires, parameter widgets.

import { TYPES, CATEGORIES, inputSockets, noteName } from './nodes.js';
import { makeNode, uid } from './project.js';

const SVG_OFF = 50000; // the wire layer is a huge SVG offset by this much, so hit-testing works everywhere
const DPR = () => Math.min(2, window.devicePixelRatio || 1);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

let respCtx = null; // shared context for filter-response previews

// ---------------------------------------------------------------- value mapping

function curveOf(spec) {
  if (spec.curve === 'log') return spec.min > 0 ? 'log' : 'cube';
  if (spec.max - spec.min > 2000) return 'cube';
  return 'lin';
}
function toNorm(spec, v) {
  const c = curveOf(spec);
  if (c === 'log') return Math.log(v / spec.min) / Math.log(spec.max / spec.min);
  if (c === 'cube') {
    const m = Math.max(Math.abs(spec.min), Math.abs(spec.max));
    const x = Math.cbrt(v / m);
    return spec.min < 0 ? (x + 1) / 2 : x;
  }
  return (v - spec.min) / (spec.max - spec.min);
}
function fromNorm(spec, n) {
  n = clamp(n, 0, 1);
  const c = curveOf(spec);
  let v;
  if (c === 'log') v = spec.min * Math.pow(spec.max / spec.min, n);
  else if (c === 'cube') {
    const m = Math.max(Math.abs(spec.min), Math.abs(spec.max));
    const x = spec.min < 0 ? n * 2 - 1 : n;
    v = x * x * x * m;
  } else v = spec.min + n * (spec.max - spec.min);
  return quant(spec, v);
}
function quant(spec, v) {
  const s = spec.step || 0.001;
  v = Math.round(v / s) * s;
  return clamp(parseFloat(v.toFixed(6)), spec.min, spec.max);
}
export function fmt(spec, v) {
  if (spec.type === 'note') return noteName(v) + ` (${v})`;
  const u = spec.unit || '';
  if (u === 'Hz' && Math.abs(v) >= 1000) return (v / 1000).toFixed(v >= 10000 ? 1 : 2) + ' kHz';
  if (u === 's' && v < 1 && v > 0) return (v * 1000).toFixed(v < 0.01 ? 1 : 0) + ' ms';
  const dec = spec.step >= 1 ? 0 : spec.step >= 0.1 ? 1 : spec.step >= 0.01 ? 2 : 3;
  return (+v).toFixed(dec) + (u ? ' ' + u : '');
}

// ---------------------------------------------------------------- editor

export class Editor {
  constructor(app, el) {
    this.app = app;
    this.el = el;
    el.classList.add('editor');
    el.innerHTML = `
      <div class="world">
        <svg class="wires" width="${SVG_OFF * 2}" height="${SVG_OFF * 2}" style="left:${-SVG_OFF}px;top:${-SVG_OFF}px">
          <g transform="translate(${SVG_OFF},${SVG_OFF})"><g class="links"></g><path class="drag-wire" d=""/></g>
        </svg>
        <div class="nodes"></div>
      </div>
      <div class="box-select"></div>
      <div class="empty-hint"><b>Right-click</b> or <b>Shift A</b> to add a node · drag sockets to patch · <b>Space</b> play</div>`;
    this.world = el.querySelector('.world');
    this.linksG = el.querySelector('.links');
    this.dragWire = el.querySelector('.drag-wire');
    this.nodesEl = el.querySelector('.nodes');
    this.boxEl = el.querySelector('.box-select');
    this.sel = new Set();
    this.selLink = null;
    this.nodeEls = new Map();
    this.widgets = new Map(); // nodeId -> {draw()}
    this._bind();
  }

  get P() { return this.app.project; }

  // ------------------------------------------------------------ view
  applyView() {
    const v = this.P.view;
    this.world.style.transform = `translate(${v.x}px,${v.y}px) scale(${v.zoom})`;
    const g = 24 * v.zoom;
    this.el.style.backgroundSize = `${g}px ${g}px, ${g * 4}px ${g * 4}px, ${g * 4}px ${g * 4}px`;
    this.el.style.backgroundPosition = `${v.x}px ${v.y}px`;
  }
  toWorld(cx, cy) {
    const r = this.el.getBoundingClientRect(), v = this.P.view;
    return { x: (cx - r.left - v.x) / v.zoom, y: (cy - r.top - v.y) / v.zoom };
  }
  zoomAt(cx, cy, f) {
    const v = this.P.view, r = this.el.getBoundingClientRect();
    const nz = clamp(v.zoom * f, 0.2, 2.5);
    const px = cx - r.left, py = cy - r.top;
    v.x = px - ((px - v.x) * nz) / v.zoom;
    v.y = py - ((py - v.y) * nz) / v.zoom;
    v.zoom = nz;
    this.applyView();
  }
  frameAll() {
    const ns = this.P.nodes;
    if (!ns.length) { Object.assign(this.P.view, { x: 0, y: 0, zoom: 1 }); this.applyView(); return; }
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const n of ns) {
      const el = this.nodeEls.get(n.id);
      const w = el ? el.offsetWidth : 220, h = el ? el.offsetHeight : 150;
      x0 = Math.min(x0, n.x); y0 = Math.min(y0, n.y); x1 = Math.max(x1, n.x + w); y1 = Math.max(y1, n.y + h);
    }
    const r = this.el.getBoundingClientRect(), pad = 60;
    const z = clamp(Math.min((r.width - pad * 2) / (x1 - x0), (r.height - pad * 2) / (y1 - y0)), 0.25, 1.1);
    Object.assign(this.P.view, { zoom: z, x: (r.width - (x1 - x0) * z) / 2 - x0 * z, y: (r.height - (y1 - y0) * z) / 2 - y0 * z });
    this.applyView();
  }

  // ------------------------------------------------------------ render
  render() {
    this.nodesEl.innerHTML = '';
    this.nodeEls.clear();
    this.widgets.clear();
    for (const n of this.P.nodes) this.nodesEl.appendChild(this.buildNode(n));
    for (const id of [...this.sel]) if (!this.nodeEls.has(id)) this.sel.delete(id);
    this.applyView();
    this.refreshSelection();
    this.el.classList.toggle('is-empty', this.P.nodes.length === 0);
    requestAnimationFrame(() => { this.drawLinks(); this.redrawWidgets(); });
  }

  addNodeEl(n) {
    const el = this.buildNode(n);
    this.nodesEl.appendChild(el);
    this.el.classList.remove('is-empty');
    requestAnimationFrame(() => { this.drawLinks(); this.redrawWidgets(n.id); });
    return el;
  }

  buildNode(n) {
    const T = TYPES[n.type], cat = CATEGORIES[T.cat];
    const el = document.createElement('div');
    el.className = `node cat-${T.cat}`;
    el.dataset.id = n.id;
    el.style.setProperty('--cat', cat.color);
    el.style.width = (T.width || 220) + 'px';
    el.style.transform = `translate(${n.x}px,${n.y}px)`;
    const head = document.createElement('header');
    head.innerHTML = `<span class="led"></span><span class="title">${T.title}</span><span class="cat">${cat.label.replace(/s$/, '')}</span>`;
    head.title = T.desc || '';
    el.appendChild(head);
    const body = document.createElement('div');
    body.className = 'body';
    el.appendChild(body);

    for (const o of T.outputs || []) body.appendChild(this.sockRow('out', o, n));
    for (const i of T.inputs || []) body.appendChild(this.sockRow('in', i, n));
    if (T.widget) body.appendChild(this.buildWidget(T.widget, n));
    for (const spec of T.params) body.appendChild(this.paramRow(n, spec));
    this.nodeEls.set(n.id, el);
    return el;
  }

  sockRow(dir, s, n) {
    const row = document.createElement('div');
    row.className = `row sockrow ${dir}`;
    row.innerHTML = dir === 'out'
      ? `<span class="lbl">${s.label}</span><i class="sock ${s.type}" data-dir="out" data-port="${s.key}" data-type="${s.type}" data-node="${n.id}"></i>`
      : `<i class="sock ${s.type}" data-dir="in" data-port="${s.key}" data-type="${s.type}" data-node="${n.id}"></i><span class="lbl">${s.label}</span>`;
    return row;
  }

  paramRow(n, spec) {
    const row = document.createElement('div');
    row.className = 'row param';
    row.dataset.key = spec.key;
    if (spec.mod) row.innerHTML = `<i class="sock audio mod" data-dir="in" data-port="p:${spec.key}" data-type="audio" data-node="${n.id}" title="Modulate ${spec.label}"></i>`;
    row.appendChild(this.field(n, spec));
    return row;
  }

  /** Builds the control for one parameter. Exported for reuse by the side panel. */
  field(n, spec) {
    const v = n.params[spec.key];
    const app = this.app;
    if (spec.type === 'number' || spec.type === 'note') {
      const f = document.createElement('div');
      f.className = 'num';
      f.innerHTML = `<div class="fill"></div><span class="k">${spec.label}</span><span class="v"></span>`;
      if (spec.hint) f.title = spec.hint;
      const sync = () => {
        const x = n.params[spec.key];
        f.querySelector('.v').textContent = fmt(spec, x);
        const nn = spec.min < 0 && curveOf(spec) !== 'log' ? null : toNorm(spec, x);
        const fill = f.querySelector('.fill');
        if (nn == null) {
          const z = toNorm(spec, 0), c = toNorm(spec, x);
          fill.style.left = Math.min(z, c) * 100 + '%'; fill.style.width = Math.abs(c - z) * 100 + '%';
        } else { fill.style.left = '0'; fill.style.width = clamp(nn, 0, 1) * 100 + '%'; }
      };
      f._sync = sync;
      sync();
      f.addEventListener('pointerdown', (e) => {
        if (e.button !== 0 || f.querySelector('input')) return;
        e.stopPropagation();
        f.setPointerCapture(e.pointerId);
        const x0 = e.clientX, start = toNorm(spec, n.params[spec.key]);
        const startV = n.params[spec.key];
        let moved = false;
        const w = Math.max(160, f.offsetWidth);
        const move = (ev) => {
          const dx = ev.clientX - x0;
          if (!moved && Math.abs(dx) < 3) return;
          moved = true;
          f.classList.add('drag');
          const sens = ev.shiftKey ? 0.1 : 1;
          let nv;
          if (spec.type === 'note' || (spec.step >= 1 && spec.max - spec.min <= 64)) nv = clamp(Math.round(startV + (dx * sens) / 8), spec.min, spec.max);
          else nv = fromNorm(spec, start + ((dx / w) * sens) / this.P.view.zoom);
          if (nv !== n.params[spec.key]) { app.setParam(n, spec.key, nv); sync(); }
        };
        const up = () => {
          f.removeEventListener('pointermove', move); f.removeEventListener('pointerup', up);
          f.classList.remove('drag');
          if (moved) app.commit();
          else this.editNum(f, n, spec, sync);
        };
        f.addEventListener('pointermove', move);
        f.addEventListener('pointerup', up);
      });
      f.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        app.setParam(n, spec.key, spec.def); sync(); app.commit();
      });
      f.addEventListener('wheel', (e) => {
        if (!e.altKey) return;
        e.preventDefault(); e.stopPropagation();
        const nn = toNorm(spec, n.params[spec.key]) - Math.sign(e.deltaY) * (e.shiftKey ? 0.002 : 0.02);
        app.setParam(n, spec.key, fromNorm(spec, nn)); sync(); app.commitSoon();
      }, { passive: false });
      return f;
    }
    if (spec.type === 'select') {
      const w = document.createElement('label');
      w.className = 'sel';
      w.innerHTML = `<span class="k">${spec.label}</span>`;
      const s = document.createElement('select');
      for (const [val, lab] of spec.options) { const o = document.createElement('option'); o.value = val; o.textContent = lab; s.appendChild(o); }
      s.value = v;
      s.addEventListener('pointerdown', (e) => e.stopPropagation());
      s.addEventListener('change', () => { app.setParam(n, spec.key, s.value); app.commit(); });
      w.appendChild(s);
      w._sync = () => (s.value = n.params[spec.key]);
      return w;
    }
    if (spec.type === 'bool') {
      const b = document.createElement('button');
      b.className = 'tog' + (v ? ' on' : '');
      b.innerHTML = `<span class="k">${spec.label}</span><span class="sw"></span>`;
      b.addEventListener('pointerdown', (e) => e.stopPropagation());
      b.addEventListener('click', () => { app.setParam(n, spec.key, !n.params[spec.key]); b.classList.toggle('on', !!n.params[spec.key]); app.commit(); });
      b._sync = () => b.classList.toggle('on', !!n.params[spec.key]);
      return b;
    }
    if (spec.type === 'text') {
      const w = document.createElement('label');
      w.className = 'txt';
      w.innerHTML = `<span class="k">${spec.label}</span>`;
      const i = document.createElement('input');
      i.value = v; i.spellcheck = false;
      i.addEventListener('pointerdown', (e) => e.stopPropagation());
      i.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') i.blur(); });
      i.addEventListener('input', () => app.setParam(n, spec.key, i.value.replace(/[^A-Za-z0-9_\-]/g, '_')));
      i.addEventListener('change', () => { i.value = n.params[spec.key]; app.commit(); });
      w.appendChild(i);
      w._sync = () => (i.value = n.params[spec.key]);
      return w;
    }
    if (spec.type === 'sample') {
      const w = document.createElement('label');
      w.className = 'sel';
      w.innerHTML = `<span class="k">${spec.label}</span>`;
      const s = document.createElement('select');
      s.className = 'sample-select';
      const fill = () => {
        s.innerHTML = '<option value="">— none —</option>' + this.P.samples.map((x) => `<option value="${x.id}">${escapeHtml(x.name)}</option>`).join('');
        s.value = n.params[spec.key] || '';
      };
      fill();
      s._fill = fill;
      s.addEventListener('pointerdown', (e) => e.stopPropagation());
      s.addEventListener('change', () => { app.setParam(n, spec.key, s.value); app.commit(); this.redrawWidgets(n.id); });
      w.appendChild(s);
      w._sync = fill;
      return w;
    }
    return document.createElement('div');
  }

  editNum(f, n, spec, sync) {
    const i = document.createElement('input');
    i.className = 'num-edit';
    i.value = n.params[spec.key];
    f.appendChild(i);
    i.focus(); i.select();
    const done = (ok) => {
      if (ok) {
        let x = parseFloat(i.value);
        if (/k$/i.test(i.value.trim())) x *= 1000;
        if (/ms$/i.test(i.value.trim())) x /= 1000;
        if (isFinite(x)) { this.app.setParam(n, spec.key, quant(spec, x)); this.app.commit(); }
      }
      i.remove(); sync();
    };
    i.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') done(true); if (e.key === 'Escape') done(false); });
    i.addEventListener('blur', () => i.isConnected && done(true));
    i.addEventListener('pointerdown', (e) => e.stopPropagation());
  }

  /** Re-sync controls of a node after an external change (undo, panel edit). */
  syncNode(n) {
    const el = this.nodeEls.get(n.id);
    if (!el) return;
    el.querySelectorAll('.num,.sel,.tog,.txt').forEach((f) => f._sync && f._sync());
    this.redrawWidgets(n.id);
  }

  refreshSampleSelects() {
    this.el.querySelectorAll('.sample-select').forEach((s) => s._fill && s._fill());
    this.redrawWidgets();
  }

  // ------------------------------------------------------------ widgets
  buildWidget(kind, n) {
    const wrap = document.createElement('div');
    wrap.className = 'widget w-' + kind;
    const cv = document.createElement('canvas');
    wrap.appendChild(cv);
    const T = TYPES[n.type];
    const W = (T.width || 220) - 20;
    const H = { steps: 78, roll: 64, wave: 54, adsr: 56, filter: 56, scope: 80, output: 40 }[kind] || 60;
    cv.style.width = W + 'px'; cv.style.height = H + 'px';
    cv.width = W * DPR(); cv.height = H * DPR();
    const g = cv.getContext('2d');
    g.scale(DPR(), DPR());
    const w = { draw: () => {}, live: null, W, H, g, cv, n };
    const draw = WIDGETS[kind];
    if (draw) draw.call(this, w, wrap);
    this.widgets.set(n.id, w);
    return wrap;
  }

  redrawWidgets(id) {
    if (id) { const w = this.widgets.get(id); w && w.draw(); return; }
    for (const [, w] of this.widgets) w.draw();
  }

  /** Per-frame: scopes, playheads. */
  animate() {
    for (const [, w] of this.widgets) if (w.live) w.live();
  }

  flash(nodeId) {
    const el = this.nodeEls.get(nodeId);
    if (!el) return;
    el.classList.remove('hit');
    void el.offsetWidth;
    el.classList.add('hit');
  }

  // ------------------------------------------------------------ links
  socketEl(nodeId, port, dir) {
    const el = this.nodeEls.get(nodeId);
    return el && el.querySelector(`.sock[data-dir="${dir}"][data-port="${CSS.escape(port)}"]`);
  }
  sockPos(s) {
    const r = s.getBoundingClientRect(), w = this.world.getBoundingClientRect(), z = this.P.view.zoom;
    return { x: (r.left + r.width / 2 - w.left) / z, y: (r.top + r.height / 2 - w.top) / z };
  }
  static wirePath(a, b) {
    const dx = Math.max(40, Math.abs(b.x - a.x) * 0.5);
    return `M${a.x},${a.y} C${a.x + dx},${a.y} ${b.x - dx},${b.y} ${b.x},${b.y}`;
  }
  drawLinks() {
    const frag = document.createDocumentFragment();
    const connected = new Set();
    for (const l of this.P.links) {
      const a = this.socketEl(l.from.node, l.from.port, 'out'), b = this.socketEl(l.to.node, l.to.port, 'in');
      if (!a || !b) continue;
      connected.add(a); connected.add(b);
      const d = Editor.wirePath(this.sockPos(a), this.sockPos(b));
      const src = this.P.nodes.find((n) => n.id === l.from.node);
      const color = CATEGORIES[TYPES[src.type].cat].color;
      const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
      g.setAttribute('class', `link ${a.dataset.type}${l.to.port.startsWith('p:') ? ' mod' : ''}${this.selLink === l.id ? ' selected' : ''}`);
      g.dataset.id = l.id;
      g.style.setProperty('--c', color);
      g.innerHTML = `<path class="hit" d="${d}"/><path class="glow" d="${d}"/><path class="line" d="${d}"/><path class="flow" d="${d}"/>`;
      frag.appendChild(g);
    }
    this.linksG.replaceChildren(frag);
    this.el.querySelectorAll('.sock').forEach((s) => s.classList.toggle('linked', connected.has(s)));
  }

  // ------------------------------------------------------------ selection
  refreshSelection() {
    for (const [id, el] of this.nodeEls) el.classList.toggle('selected', this.sel.has(id));
    this.app.onSelection && this.app.onSelection();
  }
  select(ids, add = false) {
    if (!add) this.sel.clear();
    for (const id of ids) this.sel.add(id);
    this.selLink = null;
    this.refreshSelection();
    this.drawLinks();
  }

  // ------------------------------------------------------------ interaction
  _bind() {
    const el = this.el;
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      if (e.target.closest('.node')) return;
      this.app.openAddMenu(e.clientX, e.clientY);
    });
    el.addEventListener('dblclick', (e) => {
      if (e.target === el || e.target.classList.contains('world') || e.target.closest('.wires') && !e.target.closest('.link')) this.app.openAddMenu(e.clientX, e.clientY);
    });
    el.addEventListener('wheel', (e) => {
      if (e.target.closest('.node select')) return;
      e.preventDefault();
      const mouseish = e.deltaMode === 1 || (Math.abs(e.deltaY) >= 50 && e.deltaX === 0 && Number.isInteger(e.deltaY));
      if (e.ctrlKey || mouseish) this.zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015)));
      else { this.P.view.x -= e.deltaX; this.P.view.y -= e.deltaY; this.applyView(); }
    }, { passive: false });
    el.addEventListener('pointerdown', (e) => this._down(e));
  }

  _down(e) {
    if (e.target.closest('input,select,button')) return;
    const sock = e.target.closest('.sock');
    const head = e.target.closest('.node header');
    const node = e.target.closest('.node');
    const link = e.target.closest('.link');
    if (e.button === 1 || (e.button === 0 && e.altKey && !sock)) return this._pan(e);
    if (e.button !== 0) return;
    if (sock) return this._wire(e, sock);
    if (link) {
      this.selLink = link.dataset.id; this.sel.clear(); this.refreshSelection(); this.drawLinks();
      return;
    }
    if (node) {
      const id = node.dataset.id;
      if (!head && e.target.closest('.widget')) { if (!this.sel.has(id)) this.select([id], e.shiftKey); return; }
      if (e.shiftKey || e.ctrlKey || e.metaKey) { this.sel.has(id) ? this.sel.delete(id) : this.sel.add(id); this.selLink = null; this.refreshSelection(); this.drawLinks(); }
      else if (!this.sel.has(id)) this.select([id]);
      node.parentElement.appendChild(node); // bring to front
      return this._drag(e);
    }
    if (e.shiftKey || e.ctrlKey || e.metaKey) return this._box(e);
    this.select([]);
    this._pan(e);
  }

  _pan(e) {
    e.preventDefault();
    const v = this.P.view, x0 = e.clientX, y0 = e.clientY, vx = v.x, vy = v.y;
    this.el.classList.add('panning');
    const mv = (ev) => { v.x = vx + ev.clientX - x0; v.y = vy + ev.clientY - y0; this.applyView(); };
    const up = () => { window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up); this.el.classList.remove('panning'); this.app.saveSoon(); };
    window.addEventListener('pointermove', mv);
    window.addEventListener('pointerup', up);
  }

  _drag(e) {
    e.preventDefault();
    const z = this.P.view.zoom, x0 = e.clientX, y0 = e.clientY;
    const moving = this.P.nodes.filter((n) => this.sel.has(n.id)).map((n) => ({ n, x: n.x, y: n.y, el: this.nodeEls.get(n.id) }));
    let moved = false;
    const mv = (ev) => {
      const dx = (ev.clientX - x0) / z, dy = (ev.clientY - y0) / z;
      if (!moved && Math.hypot(dx, dy) < 2) return;
      moved = true;
      const snap = !ev.altKey;
      for (const m of moving) {
        m.n.x = snap ? Math.round((m.x + dx) / 12) * 12 : Math.round(m.x + dx);
        m.n.y = snap ? Math.round((m.y + dy) / 12) * 12 : Math.round(m.y + dy);
        m.el.style.transform = `translate(${m.n.x}px,${m.n.y}px)`;
      }
      this.drawLinks();
    };
    const up = () => { window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up); if (moved) this.app.commit(); };
    window.addEventListener('pointermove', mv);
    window.addEventListener('pointerup', up);
  }

  _box(e) {
    const r = this.el.getBoundingClientRect(), x0 = e.clientX, y0 = e.clientY;
    const base = new Set(this.sel);
    const b = this.boxEl;
    b.style.display = 'block';
    const mv = (ev) => {
      const x = Math.min(x0, ev.clientX), y = Math.min(y0, ev.clientY), w = Math.abs(ev.clientX - x0), h = Math.abs(ev.clientY - y0);
      Object.assign(b.style, { left: x - r.left + 'px', top: y - r.top + 'px', width: w + 'px', height: h + 'px' });
      this.sel = new Set(base);
      for (const [id, nel] of this.nodeEls) {
        const q = nel.getBoundingClientRect();
        if (q.right > x && q.left < x + w && q.bottom > y && q.top < y + h) this.sel.add(id);
      }
      this.refreshSelection();
    };
    const up = () => { window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up); b.style.display = 'none'; };
    window.addEventListener('pointermove', mv);
    window.addEventListener('pointerup', up);
  }

  _wire(e, sock) {
    e.preventDefault();
    e.stopPropagation();
    let from; // {node, port, type, el}
    let detached = null;
    if (sock.dataset.dir === 'out') from = { node: sock.dataset.node, port: sock.dataset.port, type: sock.dataset.type, el: sock };
    else {
      // pick up the newest wire on this input, if any
      const ls = this.P.links.filter((l) => l.to.node === sock.dataset.node && l.to.port === sock.dataset.port);
      if (!ls.length) {
        // dragging backwards from an empty input: find an output to feed it
        from = { node: sock.dataset.node, port: sock.dataset.port, type: sock.dataset.type, el: sock, reverse: true };
      } else {
        detached = ls[ls.length - 1];
        this.P.links = this.P.links.filter((l) => l !== detached);
        const src = this.socketEl(detached.from.node, detached.from.port, 'out');
        from = { node: detached.from.node, port: detached.from.port, type: src.dataset.type, el: src };
        this.drawLinks();
      }
    }
    const a = this.sockPos(from.el);
    const color = CATEGORIES[TYPES[this.P.nodes.find((n) => n.id === from.node).type].cat].color;
    this.dragWire.style.setProperty('--c', color);
    this.dragWire.setAttribute('class', 'drag-wire on ' + from.type);
    this.el.classList.add('wiring', 'wiring-' + from.type, from.reverse ? 'wiring-rev' : 'wiring-fwd');
    let target = null;
    const mv = (ev) => {
      const p = this.toWorld(ev.clientX, ev.clientY);
      const hit = document.elementFromPoint(ev.clientX, ev.clientY);
      const s = hit && hit.closest && hit.closest('.sock');
      target = null;
      this.el.querySelectorAll('.sock.hover').forEach((x) => x.classList.remove('hover'));
      if (s && s.dataset.type === from.type && s.dataset.node !== from.node && s.dataset.dir === (from.reverse ? 'out' : 'in')) { target = s; s.classList.add('hover'); }
      const b = target ? this.sockPos(target) : p;
      this.dragWire.setAttribute('d', from.reverse ? Editor.wirePath(b, a) : Editor.wirePath(a, b));
    };
    const up = (ev) => {
      window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up);
      this.dragWire.setAttribute('class', 'drag-wire'); this.dragWire.setAttribute('d', '');
      this.el.classList.remove('wiring', 'wiring-audio', 'wiring-notes', 'wiring-rev', 'wiring-fwd');
      this.el.querySelectorAll('.sock.hover').forEach((x) => x.classList.remove('hover'));
      if (target) {
        const f = from.reverse ? { node: target.dataset.node, port: target.dataset.port } : { node: from.node, port: from.port };
        const t = from.reverse ? { node: from.node, port: from.port } : { node: target.dataset.node, port: target.dataset.port };
        this.app.connect(f, t);
      } else if (!detached && ev.target.closest && !ev.target.closest('.node')) {
        // dropped on empty canvas: offer to create a node and connect it
        this.app.openAddMenu(ev.clientX, ev.clientY, { from, });
        this.app.structureChanged();
      } else this.app.structureChanged(); // a detached wire was dropped: it stays removed
    };
    window.addEventListener('pointermove', mv);
    window.addEventListener('pointerup', up);
    mv(e);
  }

  // ------------------------------------------------------------ edit ops
  deleteSelection() {
    if (this.selLink) {
      this.P.links = this.P.links.filter((l) => l.id !== this.selLink);
      this.selLink = null;
      this.app.structureChanged();
      return;
    }
    if (!this.sel.size) return;
    this.P.nodes = this.P.nodes.filter((n) => !this.sel.has(n.id));
    this.P.links = this.P.links.filter((l) => !this.sel.has(l.from.node) && !this.sel.has(l.to.node));
    for (const id of this.sel) { const el = this.nodeEls.get(id); el && el.remove(); this.nodeEls.delete(id); this.widgets.delete(id); }
    this.sel.clear();
    this.refreshSelection();
    this.el.classList.toggle('is-empty', this.P.nodes.length === 0);
    this.app.structureChanged();
  }

  copy() {
    const nodes = this.P.nodes.filter((n) => this.sel.has(n.id));
    if (!nodes.length) return null;
    const ids = new Set(nodes.map((n) => n.id));
    return JSON.stringify({ nodes, links: this.P.links.filter((l) => ids.has(l.from.node) && ids.has(l.to.node)) });
  }

  paste(clip, at) {
    if (!clip) return;
    const { nodes, links } = JSON.parse(clip);
    const map = new Map();
    const minX = Math.min(...nodes.map((n) => n.x)), minY = Math.min(...nodes.map((n) => n.y));
    const fresh = nodes.map((n) => {
      const c = JSON.parse(JSON.stringify(n));
      c.id = uid('n'); map.set(n.id, c.id);
      c.x = at ? Math.round(at.x + n.x - minX) : n.x + 36; c.y = at ? Math.round(at.y + n.y - minY) : n.y + 36;
      return c;
    });
    this.P.nodes.push(...fresh);
    for (const l of links) this.P.links.push({ id: uid('l'), from: { node: map.get(l.from.node), port: l.from.port }, to: { node: map.get(l.to.node), port: l.to.port } });
    for (const n of fresh) this.addNodeEl(n);
    this.select(fresh.map((n) => n.id));
    this.app.structureChanged();
  }

  addNode(type, at, connectFrom) {
    const n = makeNode(type, at.x, at.y);
    if (type === 'output') n.params.name = this.app.uniqueCueName('cue');
    this.P.nodes.push(n);
    this.addNodeEl(n);
    if (connectFrom) {
      const want = connectFrom.reverse ? 'out' : 'in';
      const list = want === 'out' ? TYPES[type].outputs || [] : inputSockets(type);
      const s = list.find((x) => x.type === connectFrom.type);
      if (s) {
        if (connectFrom.reverse) this.app.connect({ node: n.id, port: s.key }, { node: connectFrom.node, port: connectFrom.port }, true);
        else this.app.connect({ node: connectFrom.node, port: connectFrom.port }, { node: n.id, port: s.key }, true);
      }
      // move so the connecting socket sits under the cursor rather than the node corner
      if (connectFrom.reverse) n.x -= (TYPES[type].width || 220);
      this.nodeEls.get(n.id).style.transform = `translate(${n.x}px,${n.y}px)`;
    }
    this.select([n.id]);
    this.app.structureChanged();
    return n;
  }
}

function escapeHtml(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]); }

// ---------------------------------------------------------------- widget painters

const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

const WIDGETS = {
  steps(w) {
    const { g, W, H, n, cv } = w;
    const app = this.app;
    const LO = -12, HI = 24;
    const yOf = (semi) => H - 14 - ((semi - LO) / (HI - LO)) * (H - 22);
    let hover = -1, drag = null;
    w.draw = (play = -1) => {
      const steps = n.params.steps, cw = W / steps, color = CATEGORIES.seq.color;
      g.clearRect(0, 0, W, H);
      g.fillStyle = 'rgba(255,255,255,0.03)'; g.fillRect(0, 0, W, H);
      const y0 = yOf(0);
      for (let i = 0; i < steps; i++) {
        const s = n.data.steps[i], x = i * cw;
        if (i % 4 === 0) { g.fillStyle = 'rgba(255,255,255,0.04)'; g.fillRect(x, 0, cw * Math.min(4, steps - i), H - 10); }
        if (i === play) { g.fillStyle = 'rgba(255,181,71,0.18)'; g.fillRect(x, 0, cw, H - 10); }
        const y = yOf(s.semi);
        g.fillStyle = s.on ? color : 'rgba(255,255,255,0.10)';
        g.globalAlpha = s.on ? 0.35 + 0.65 * (s.vel ?? 1) : 1;
        const top = Math.min(y, y0 - 3), bot = Math.max(y, y0 + 3);
        roundRect(g, x + 2, top, cw - 4, bot - top, 2); g.fill();
        g.globalAlpha = 1;
        g.fillStyle = s.on ? color : 'rgba(255,255,255,0.15)';
        g.fillRect(x + 2, H - 7, cw - 4, 3);
      }
      g.strokeStyle = 'rgba(255,255,255,0.12)'; g.beginPath(); g.moveTo(0, y0 + 0.5); g.lineTo(W, y0 + 0.5); g.stroke();
      const show = drag ? drag.i : hover;
      if (show >= 0 && show < steps) {
        const s = n.data.steps[show];
        g.fillStyle = '#fff'; g.font = '600 10px Inter, sans-serif'; g.textAlign = 'center';
        const tx = clamp(show * cw + cw / 2, 18, W - 18);
        g.fillText(noteName(n.params.root + s.semi), tx, 10);
      }
    };
    let lastPlay = -2;
    w.live = () => {
      const eng = app.engine;
      if (!eng.playing || !eng.graph || !app.isActive(n.id)) { if (lastPlay !== -1) { lastPlay = -1; w.draw(); } return; }
      const sd = (60 / app.project.bpm) * parseFloat(n.params.rate);
      const k = Math.floor(eng.position() / sd + 1e-6) % n.params.steps;
      if (k !== lastPlay) { lastPlay = k; w.draw(k); }
    };
    const idx = (e) => { const r = cv.getBoundingClientRect(); return clamp(Math.floor(((e.clientX - r.left) / r.width) * n.params.steps), 0, n.params.steps - 1); };
    cv.addEventListener('pointermove', (e) => { if (!drag) { hover = idx(e); w.draw(lastPlay); } });
    cv.addEventListener('pointerleave', () => { hover = -1; w.draw(lastPlay); });
    cv.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.stopPropagation();
      cv.setPointerCapture(e.pointerId);
      const i = idx(e), s = n.data.steps[i];
      if (e.ctrlKey || e.metaKey) { s.semi = 0; w.draw(); app.commit(); return; }
      drag = { i, y: e.clientY, semi: s.semi, moved: false, paint: !s.on };
      const mv = (ev) => {
        const dy = ev.clientY - drag.y;
        const j = idx(ev);
        if (j !== drag.i && !drag.moved) {
          // horizontal paint: toggle steps along the stroke to the stroke's starting state
          n.data.steps[j].on = drag.paint; drag.painting = true; w.draw(); return;
        }
        if (drag.painting) { n.data.steps[j].on = drag.paint; w.draw(); return; }
        if (!drag.moved && Math.abs(dy) < 4) return;
        drag.moved = true; s.on = true;
        s.semi = clamp(Math.round(drag.semi - dy / 4), LO, HI);
        w.draw();
      };
      const up = () => {
        cv.removeEventListener('pointermove', mv); cv.removeEventListener('pointerup', up);
        if (!drag.moved && !drag.painting) s.on = !s.on;
        drag = null; w.draw(); app.commit();
      };
      cv.addEventListener('pointermove', mv);
      cv.addEventListener('pointerup', up);
    });
    cv.title = 'Click: toggle · drag ↕: pitch · drag ↔: paint · Ctrl+click: reset pitch';
    w.draw();
  },

  roll(w, wrap) {
    const { g, W, H, n, cv } = w;
    const app = this.app;
    const btn = document.createElement('button');
    btn.className = 'mini-btn'; btn.textContent = 'Edit notes';
    btn.addEventListener('pointerdown', (e) => e.stopPropagation());
    btn.addEventListener('click', () => app.openPianoRoll(n));
    wrap.appendChild(btn);
    cv.addEventListener('dblclick', (e) => { e.stopPropagation(); app.openPianoRoll(n); });
    w.draw = (pos = -1) => {
      g.clearRect(0, 0, W, H);
      g.fillStyle = 'rgba(255,255,255,0.03)'; g.fillRect(0, 0, W, H);
      const len = n.params.length, notes = n.data.notes;
      for (let b = 0; b < len; b += 4) { g.fillStyle = 'rgba(255,255,255,0.04)'; if ((b / 4) % 2 === 0) g.fillRect((b / len) * W, 0, (4 / len) * W, H); }
      if (notes.length) {
        let lo = Math.min(...notes.map((x) => x.n)) - 2, hi = Math.max(...notes.map((x) => x.n)) + 2;
        if (hi - lo < 12) { const c = (hi + lo) / 2; lo = c - 6; hi = c + 6; }
        g.fillStyle = CATEGORIES.seq.color;
        for (const x of notes) {
          if (x.s >= len) continue;
          const y = H - ((x.n - lo) / (hi - lo)) * H;
          roundRect(g, (x.s / len) * W, y - 2, Math.max(2, (x.l / len) * W - 1), 4, 1.5); g.fill();
        }
      } else { g.fillStyle = 'rgba(255,255,255,0.3)'; g.font = '11px Inter'; g.textAlign = 'center'; g.fillText('empty clip — double-click to edit', W / 2, H / 2 + 4); }
      if (pos >= 0) { g.fillStyle = '#fff'; g.fillRect(pos * W, 0, 1, H); }
    };
    w.live = () => {
      const eng = app.engine;
      if (!eng.playing || !app.isActive(n.id)) { if (w._p !== -1) { w._p = -1; w.draw(); } return; }
      const clip = (n.params.length * 60) / app.project.bpm;
      w._p = (eng.position() % clip) / clip; w.draw(w._p);
    };
    w.draw();
  },

  wave(w, wrap) {
    const { g, W, H, n, cv } = w;
    const app = this.app;
    w.draw = () => {
      g.clearRect(0, 0, W, H);
      g.fillStyle = 'rgba(255,255,255,0.03)'; g.fillRect(0, 0, W, H);
      const buf = app.engine.buffers.get(n.params.sample);
      if (!buf) {
        g.fillStyle = 'rgba(255,255,255,0.35)'; g.font = '11px Inter'; g.textAlign = 'center';
        g.fillText('drop an audio file here', W / 2, H / 2 + 4); return;
      }
      drawWave(g, buf, W, H, CATEGORIES.source.color, n.params.reverse);
      const st = Math.min(1, n.params.start / buf.duration);
      if (st > 0) { g.fillStyle = 'rgba(0,0,0,0.45)'; g.fillRect(0, 0, st * W, H); }
      g.fillStyle = 'rgba(255,255,255,0.55)'; g.font = '10px "JetBrains Mono", monospace'; g.textAlign = 'right';
      g.fillText(buf.duration.toFixed(2) + 's', W - 4, H - 4);
    };
    wrap.addEventListener('dragover', (e) => { e.preventDefault(); e.stopPropagation(); wrap.classList.add('drop'); });
    wrap.addEventListener('dragleave', () => wrap.classList.remove('drop'));
    wrap.addEventListener('drop', async (e) => {
      e.preventDefault(); e.stopPropagation(); wrap.classList.remove('drop');
      const sid = e.dataTransfer.getData('application/x-nodeaudio-sample');
      if (sid) { app.setParam(n, 'sample', sid); app.commit(); this.syncNode(n); return; }
      const f = [...e.dataTransfer.files].find((x) => x.type.startsWith('audio') || /\.(wav|mp3|ogg|flac|m4a|aiff?)$/i.test(x.name));
      if (f) { const s = await app.importSample(f); if (s) { app.setParam(n, 'sample', s.id); app.commit(); this.syncNode(n); } }
    });
    w.draw();
  },

  adsr(w) {
    const { g, W, H, n } = w;
    w.draw = () => {
      const P = n.params;
      g.clearRect(0, 0, W, H);
      g.fillStyle = 'rgba(255,255,255,0.03)'; g.fillRect(0, 0, W, H);
      const tw = (x) => Math.log(1 + x * 40);
      const a = tw(P.a), d = tw(P.d), h = tw(Math.max(0.05, P.hold - P.a - P.d)) * 0.6, r = tw(P.r);
      const tot = a + d + h + r, sx = (W - 8) / tot, top = 6, bot = H - 4, sy = bot - top;
      const x1 = 4 + a * sx, x2 = x1 + d * sx, x3 = x2 + h * sx, x4 = x3 + r * sx;
      const sus = bot - P.s * sy;
      g.beginPath(); g.moveTo(4, bot);
      g.quadraticCurveTo(4 + a * sx * 0.3, top, x1, top);
      g.quadraticCurveTo(x1 + d * sx * 0.15, sus, x2, sus);
      g.lineTo(x3, sus);
      g.quadraticCurveTo(x3 + r * sx * 0.15, bot, x4, bot);
      const c = CATEGORIES.mod.color;
      g.strokeStyle = c; g.lineWidth = 1.6; g.stroke();
      g.lineTo(4, bot); g.closePath();
      const grad = g.createLinearGradient(0, top, 0, bot); grad.addColorStop(0, c + '55'); grad.addColorStop(1, c + '00');
      g.fillStyle = grad; g.fill();
    };
    w.draw();
  },

  filter(w) {
    const { g, W, H, n } = w;
    const N = 120;
    const freqs = new Float32Array(N), mag = new Float32Array(N), ph = new Float32Array(N);
    for (let i = 0; i < N; i++) freqs[i] = 20 * Math.pow(1000, i / (N - 1));
    w.draw = () => {
      if (!respCtx) respCtx = new OfflineAudioContext(1, 1, 44100);
      const f = respCtx.createBiquadFilter();
      const P = n.params;
      f.type = P.type; f.frequency.value = P.cutoff; f.Q.value = P.q; f.gain.value = P.gain;
      f.getFrequencyResponse(freqs, mag, ph);
      const k = parseInt(P.slope, 10) || 1;
      g.clearRect(0, 0, W, H);
      g.fillStyle = 'rgba(255,255,255,0.03)'; g.fillRect(0, 0, W, H);
      g.strokeStyle = 'rgba(255,255,255,0.06)';
      for (const hz of [100, 1000, 10000]) { const x = (Math.log(hz / 20) / Math.log(1000)) * W; g.beginPath(); g.moveTo(x, 0); g.lineTo(x, H); g.stroke(); }
      const yOf = (m) => { const db = 20 * Math.log10(Math.max(1e-5, Math.pow(m, k))); return H / 2 - (db / 30) * (H / 2); };
      g.beginPath();
      for (let i = 0; i < N; i++) { const x = (i / (N - 1)) * W, y = clamp(yOf(mag[i]), 0, H); i ? g.lineTo(x, y) : g.moveTo(x, y); }
      const c = CATEGORIES.fx.color;
      g.strokeStyle = c; g.lineWidth = 1.6; g.stroke();
      g.lineTo(W, H); g.lineTo(0, H); g.closePath();
      const grad = g.createLinearGradient(0, 0, 0, H); grad.addColorStop(0, c + '44'); grad.addColorStop(1, c + '00');
      g.fillStyle = grad; g.fill();
    };
    w.draw();
  },

  scope(w) {
    const { g, W, H, n } = w;
    const app = this.app;
    let data = null;
    w.draw = () => {
      g.clearRect(0, 0, W, H);
      g.fillStyle = 'rgba(0,0,0,0.25)'; g.fillRect(0, 0, W, H);
      g.strokeStyle = 'rgba(255,255,255,0.07)'; g.beginPath(); g.moveTo(0, H / 2); g.lineTo(W, H / 2); g.stroke();
      const a = app.engine.analyserFor(n.id);
      if (!a) return;
      const c = CATEGORIES.util.color;
      g.strokeStyle = '#d6e4ff'; g.lineWidth = 1.4; g.shadowColor = c; g.shadowBlur = 6;
      g.beginPath();
      if (n.params.mode === 'spectrum') {
        if (!data || data.length !== a.frequencyBinCount) data = new Uint8Array(a.frequencyBinCount);
        a.getByteFrequencyData(data);
        const nyq = app.engine.ctx.sampleRate / 2;
        for (let x = 0; x < W; x++) {
          const hz = 20 * Math.pow(1000, x / W), b = Math.min(data.length - 1, Math.floor((hz / nyq) * data.length));
          const y = H - (data[b] / 255) * H;
          x ? g.lineTo(x, y) : g.moveTo(x, y);
        }
      } else {
        const buf = new Float32Array(a.fftSize);
        a.getFloatTimeDomainData(buf);
        let z = 0; // trigger on rising zero crossing for a stable trace
        for (let i = 1; i < buf.length / 2; i++) if (buf[i - 1] < 0 && buf[i] >= 0) { z = i; break; }
        const span = 1024;
        for (let x = 0; x < W; x++) { const v = buf[z + Math.floor((x / W) * span)] || 0; const y = H / 2 - v * (H / 2 - 2); x ? g.lineTo(x, y) : g.moveTo(x, y); }
      }
      g.stroke(); g.shadowBlur = 0;
    };
    w.live = () => w.draw();
    w.draw();
  },

  output(w, wrap) {
    const { g, W, H, n, cv } = w;
    const app = this.app;
    cv.remove();
    wrap.classList.add('w-output-bar');
    wrap.innerHTML = `
      <button class="mini-btn solo" title="Play only this cue">▶ Solo</button>
      <button class="mini-btn exp" title="Render this cue to WAV">⤓ WAV</button>
      <span class="info"></span>`;
    const solo = wrap.querySelector('.solo');
    wrap.querySelectorAll('button').forEach((b) => b.addEventListener('pointerdown', (e) => e.stopPropagation()));
    solo.addEventListener('click', () => app.toggleSolo(n.id));
    wrap.querySelector('.exp').addEventListener('click', () => app.exportOne(n.id));
    w.draw = () => {
      solo.classList.toggle('on', app.engine.playing && app.engine.solo === n.id);
      const info = app.lastRender.get(n.id);
      wrap.querySelector('.info').textContent = info ? `${info.seconds.toFixed(2)}s · pk ${(20 * Math.log10(info.peak || 1e-9)).toFixed(1)}dB` : '';
    };
    w.draw();
  },
};

export function drawWave(g, buf, W, H, color, rev = false) {
  const d = buf.getChannelData(0), step = d.length / W;
  g.fillStyle = color;
  for (let x = 0; x < W; x++) {
    let lo = 1, hi = -1;
    const i0 = Math.floor((rev ? W - 1 - x : x) * step), i1 = Math.min(d.length, i0 + Math.max(1, Math.floor(step)));
    for (let i = i0; i < i1; i++) { const v = d[i]; if (v < lo) lo = v; if (v > hi) hi = v; }
    const y0 = H / 2 - hi * (H / 2 - 2), y1 = H / 2 - lo * (H / 2 - 2);
    g.fillRect(x, y0, 1, Math.max(1, y1 - y0));
  }
}

function roundRect(g, x, y, w, h, r) {
  g.beginPath();
  g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath();
}
