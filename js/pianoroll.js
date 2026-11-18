// Piano roll drawer for Piano Roll nodes.

import { noteName, CATEGORIES } from './nodes.js';

const KEYW = 46, ROWH = 14, LO = 24, HI = 108;
const isBlack = (n) => [1, 3, 6, 8, 10].includes(n % 12);

export class PianoRoll {
  constructor(app, el) {
    this.app = app;
    this.el = el;
    this.node = null;
    this.snap = 0.25;
    this.beatW = 48;
    this.lastLen = 1;
    el.innerHTML = `
      <div class="pr-bar">
        <span class="pr-title">Piano Roll</span>
        <label class="pr-ctl">Snap <select class="pr-snap">
          <option value="1">1 beat</option><option value="0.5">1/8</option><option value="0.25" selected>1/16</option>
          <option value="0.125">1/32</option><option value="0.3333333">1/8T</option><option value="0">off</option></select></label>
        <label class="pr-ctl">Zoom <input class="pr-zoom" type="range" min="16" max="160" value="48"></label>
        <span class="pr-help">click: add · drag: move · drag edge: resize · right-click / double-click: delete · shift-drag ↕: velocity</span>
        <span class="grow"></span>
        <button class="btn sm rec-btn" id="pr-rec" title="Arm recording: notes played on ⌨ / MIDI while the transport runs are written here">● Rec</button>
        <button class="btn ghost pr-clear">Clear</button>
      </div>
      <div class="pr-scroll"><canvas class="pr-canvas"></canvas></div>`;
    this.scroll = el.querySelector('.pr-scroll');
    this.cv = el.querySelector('.pr-canvas');
    this.g = this.cv.getContext('2d');
    el.querySelector('.pr-snap').addEventListener('change', (e) => (this.snap = parseFloat(e.target.value)));
    el.querySelector('.pr-zoom').addEventListener('input', (e) => { this.beatW = +e.target.value; this.layout(); });
    el.querySelector('.pr-clear').addEventListener('click', () => { if (this.node) { this.node.data.notes = []; this.changed(); } });
    this.cv.addEventListener('pointerdown', (e) => this.down(e));
    this.cv.addEventListener('pointermove', (e) => this.hover(e));
    this.cv.addEventListener('contextmenu', (e) => e.preventDefault());
    this.cv.addEventListener('dblclick', (e) => { const h = this.hit(e); if (h) { this.remove(h.note); } });
  }

  open(node) {
    this.node = node;
    this.app.showDock('roll');
    this.el.querySelector('.pr-title').textContent = 'Piano Roll — ' + (node.params.length) + ' beats';
    this.layout();
    // scroll to the notes
    const ns = node.data.notes;
    const mid = ns.length ? ns.reduce((a, b) => a + b.n, 0) / ns.length : 60;
    this.scroll.scrollTop = (HI - mid) * ROWH - this.scroll.clientHeight / 2;
  }
  close() { if (this.node && this.app.hideDock) this.app.hideDock(); this.node = null; }
  get isOpen() { return !!this.node; }

  layout() {
    if (!this.node) { this.g.clearRect(0, 0, this.cv.width, this.cv.height); return; }
    const dpr = Math.min(2, devicePixelRatio || 1);
    this.W = KEYW + this.node.params.length * this.beatW;
    this.H = (HI - LO + 1) * ROWH;
    this.cv.style.width = this.W + 'px'; this.cv.style.height = this.H + 'px';
    this.cv.width = this.W * dpr; this.cv.height = this.H * dpr;
    this.g.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.draw();
  }

  yOf(n) { return (HI - n) * ROWH; }
  pos(e) {
    const r = this.cv.getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    return { x, y, beat: (x - KEYW) / this.beatW, note: HI - Math.floor(y / ROWH) };
  }
  q(b) { return this.snap ? Math.round(b / this.snap) * this.snap : b; }
  qf(b) { return this.snap ? Math.floor(b / this.snap) * this.snap : b; }

  hit(e) {
    const p = this.pos(e);
    const notes = this.node.data.notes;
    for (let i = notes.length - 1; i >= 0; i--) {
      const n = notes[i];
      const x0 = KEYW + n.s * this.beatW, x1 = x0 + n.l * this.beatW, y0 = this.yOf(n.n);
      if (p.x >= x0 && p.x <= x1 && p.y >= y0 && p.y < y0 + ROWH) return { note: n, edge: x1 - p.x < 7 };
    }
    return null;
  }

  hover(e) {
    if (this.dragging) return;
    const h = this.hit(e);
    this.cv.style.cursor = h ? (h.edge ? 'ew-resize' : 'grab') : this.pos(e).x < KEYW ? 'pointer' : 'crosshair';
  }

  remove(n) { this.node.data.notes = this.node.data.notes.filter((x) => x !== n); this.changed(); }

  down(e) {
    if (!this.node) return;
    const p = this.pos(e);
    if (p.x < KEYW) { this.app.previewNote(p.note); return; }
    const h = this.hit(e);
    if (e.button === 2) { if (h) this.remove(h.note); return; }
    if (e.button !== 0) return;
    let n, mode;
    if (h) { n = h.note; mode = e.shiftKey ? 'vel' : h.edge ? 'len' : 'move'; }
    else {
      n = { s: Math.max(0, this.qf(p.beat)), l: this.lastLen, n: p.note, v: 0.9 };
      if (n.s >= this.node.params.length) return;
      this.node.data.notes.push(n);
      mode = 'len';
      this.app.previewNote(n.n);
    }
    const start = { ...n }, p0 = p;
    this.dragging = true;
    this.cv.setPointerCapture(e.pointerId);
    const mv = (ev) => {
      const q = this.pos(ev);
      if (mode === 'move') {
        const ns = Math.max(0, Math.min(this.node.params.length - this.snap, this.q(start.s + q.beat - p0.beat)));
        const nn = Math.max(LO, Math.min(HI, start.n + (q.note - p0.note)));
        if (nn !== n.n) this.app.previewNote(nn);
        n.s = ns; n.n = nn;
      } else if (mode === 'len') {
        const end = this.snap ? Math.max(n.s + this.snap, Math.ceil((q.beat) / this.snap) * this.snap) : Math.max(n.s + 0.05, q.beat);
        n.l = (h ? Math.max(this.snap || 0.05, this.q(start.l + q.beat - p0.beat)) : end - n.s);
        this.lastLen = n.l;
      } else if (mode === 'vel') {
        n.v = Math.max(0.05, Math.min(1, start.v - (q.y - p0.y) / 100));
      }
      this.draw();
      this.app.editor.redrawWidgets(this.node.id);
    };
    const up = () => {
      this.dragging = false;
      this.cv.removeEventListener('pointermove', mv); this.cv.removeEventListener('pointerup', up);
      if (mode !== 'vel') this.lastLen = n.l;
      this.changed();
    };
    this.cv.addEventListener('pointermove', mv);
    this.cv.addEventListener('pointerup', up);
    this.draw();
  }

  changed() { this.draw(); this.app.editor.redrawWidgets(this.node.id); this.app.commit(); }

  draw(pos = -1) {
    if (!this.node) return;
    const g = this.g, W = this.W, H = this.H, bw = this.beatW, len = this.node.params.length;
    g.clearRect(0, 0, W, H);
    for (let n = HI; n >= LO; n--) {
      const y = this.yOf(n);
      g.fillStyle = isBlack(n) ? '#0d1119' : '#121823';
      g.fillRect(KEYW, y, W - KEYW, ROWH);
      if (n % 12 === 0) { g.fillStyle = 'rgba(255,255,255,0.08)'; g.fillRect(KEYW, y + ROWH - 1, W - KEYW, 1); }
    }
    for (let b = 0; b <= len; b += this.snap || 0.25) {
      const x = KEYW + b * bw;
      const bar = Math.abs(b % 4) < 1e-6, beat = Math.abs(b % 1) < 1e-6;
      g.fillStyle = bar ? 'rgba(255,255,255,0.22)' : beat ? 'rgba(255,255,255,0.09)' : 'rgba(255,255,255,0.035)';
      g.fillRect(Math.round(x), 0, 1, H);
    }
    const c = CATEGORIES.seq.color;
    for (const n of this.node.data.notes) {
      const x = KEYW + n.s * bw, y = this.yOf(n.n), w = Math.max(3, n.l * bw - 1);
      g.globalAlpha = n.s >= len ? 0.25 : 1;
      g.fillStyle = c;
      g.globalAlpha *= 0.45 + 0.55 * (n.v ?? 0.9);
      g.beginPath(); g.roundRect ? g.roundRect(x + 0.5, y + 1, w, ROWH - 2, 3) : g.rect(x + 0.5, y + 1, w, ROWH - 2); g.fill();
      g.globalAlpha = 1;
      if (w > 28) { g.fillStyle = '#1a1205'; g.font = '600 9px Inter, sans-serif'; g.fillText(noteName(n.n), x + 4, y + ROWH - 4); }
    }
    for (let n = HI; n >= LO; n--) {
      const y = this.yOf(n);
      g.fillStyle = isBlack(n) ? '#1b2130' : '#d9dee8';
      g.fillRect(0, y, KEYW - 2, ROWH - (isBlack(n) ? 1 : 0.5));
      if (n % 12 === 0) { g.fillStyle = '#4a5363'; g.font = '600 9px Inter, sans-serif'; g.fillText(noteName(n), 4, y + ROWH - 3); }
    }
    if (pos >= 0) { g.fillStyle = '#fff'; g.fillRect(KEYW + pos * bw, 0, 1.5, H); }
  }

  animate() {
    if (!this.node) return;
    const eng = this.app.engine;
    if (!eng.playing || !this.app.isActive(this.node.id)) { if (this._p !== -1) { this._p = -1; this.draw(); } return; }
    const spb = 60 / this.app.project.bpm, clip = this.node.params.length * spb;
    this._p = (eng.position() % clip) / spb;
    this.draw(this._p);
  }
}
