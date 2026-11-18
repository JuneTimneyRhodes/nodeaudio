// Arrangement: a timeline of clips. Each track is bound to one node on the canvas —
// a sequencer (its notes play only inside its clips, from the clip's offset) or a
// source like a Sampler (each clip plays the sample from its offset to the clip end).

import { TYPES, CATEGORIES } from './nodes.js';
import { uid } from './project.js';
import { drawWave } from './editor.js';

const HEAD = 170, ROW = 38, RULER = 24;
const TRACKABLE = new Set(['trigger', 'stepseq', 'pianoroll', 'sampler', 'osc', 'wavetable', 'gs_out', 'granular']);

export class Arrangement {
  constructor(app, el) {
    this.app = app;
    this.el = el;
    this.beatW = 18;
    this.snap = 1;
    el.innerHTML = `
      <div class="pr-bar">
        <label class="tog-inline"><input type="checkbox" class="ar-on"><span>Song mode</span></label>
        <label class="pr-ctl">Bars <input class="ar-bars" type="number" min="1" max="999" step="1"></label>
        <label class="pr-ctl">Snap <select class="ar-snap"><option value="4">bar</option><option value="1" selected>beat</option><option value="0.5">1/8</option><option value="0.25">1/16</option></select></label>
        <label class="pr-ctl">Zoom <input class="ar-zoom" type="range" min="4" max="80" value="18"></label>
        <select class="ar-add btn ghost"></select>
        <span class="pr-help">double-click a lane: add clip · drag: move · drag edge: resize/trim · Alt-drag: copy · right-click: delete · click ruler: jump</span>
      </div>
      <div class="ar-body"><div class="ar-heads"></div><div class="ar-scroll"><canvas class="ar-canvas"></canvas></div></div>`;
    this.heads = el.querySelector('.ar-heads');
    this.scroll = el.querySelector('.ar-scroll');
    this.cv = el.querySelector('.ar-canvas');
    this.g = this.cv.getContext('2d');
    el.querySelector('.ar-on').addEventListener('change', (e) => { this.song.enabled = e.target.checked; this.changed(); this.app.updateTransport(); });
    el.querySelector('.ar-bars').addEventListener('change', (e) => { this.song.bars = Math.max(1, Math.min(999, parseInt(e.target.value, 10) || 16)); this.changed(); });
    el.querySelector('.ar-snap').addEventListener('change', (e) => (this.snap = parseFloat(e.target.value)));
    el.querySelector('.ar-zoom').addEventListener('input', (e) => { this.beatW = +e.target.value; this.layout(); });
    el.querySelector('.ar-add').addEventListener('change', (e) => { const id = e.target.value; e.target.value = ''; if (id) this.addTrack(id); });
    this.scroll.addEventListener('scroll', () => (this.heads.scrollTop = this.scroll.scrollTop));
    this.cv.addEventListener('pointerdown', (e) => this.down(e));
    this.cv.addEventListener('dblclick', (e) => this.dbl(e));
    this.cv.addEventListener('contextmenu', (e) => { e.preventDefault(); const h = this.hit(e); if (h && h.clip) this.removeClip(h.clip); });
    this.cv.addEventListener('pointermove', (e) => { if (!this.drag) { const h = this.hit(e); this.cv.style.cursor = h && h.clip ? (h.edge ? 'ew-resize' : 'grab') : h && h.ruler ? 'pointer' : 'default'; } });
  }

  get song() { return this.app.project.song; }
  get spb() { return 60 / this.app.project.bpm; }

  nodeOf(t) { return this.app.project.nodes.find((n) => n.id === t.node); }
  label(n) {
    if (!n) return '?';
    const T = TYPES[n.type];
    const s = n.params.sample && this.app.project.samples.find((x) => x.id === n.params.sample);
    return n.params.name && n.type !== 'group' ? n.params.name : s ? s.name : T.title;
  }

  render() {
    const s = this.song;
    this.el.querySelector('.ar-on').checked = s.enabled;
    this.el.querySelector('.ar-bars').value = s.bars;
    const avail = this.app.project.nodes.filter((n) => TRACKABLE.has(n.type) && !s.tracks.some((t) => t.node === n.id));
    const add = this.el.querySelector('.ar-add');
    add.innerHTML = `<option value="">+ Track…</option>` + avail.map((n) => `<option value="${n.id}">${TYPES[n.type].title}${this.label(n) !== TYPES[n.type].title ? ' — ' + esc(this.label(n)) : ''}</option>`).join('');
    this.heads.innerHTML = `<div class="ar-spacer"></div>` + s.tracks.map((t) => {
      const n = this.nodeOf(t), c = CATEGORIES[TYPES[n.type].cat].color;
      return `<div class="ar-head${t.mute ? ' muted' : ''}" data-t="${t.id}" style="--cat:${c}"><span class="sw"></span><span class="nm" title="${esc(this.label(n))}">${esc(this.label(n))}</span><button class="m" title="Mute">M</button><button class="x" title="Remove track">✕</button></div>`;
    }).join('') + (s.tracks.length ? '' : `<div class="ar-empty">Add a track with “+ Track”. Each track plays one node (sequencer or sampler) only inside its clips.</div>`);
    this.heads.querySelectorAll('.ar-head').forEach((h) => {
      const t = s.tracks.find((x) => x.id === h.dataset.t);
      h.querySelector('.m').addEventListener('click', () => { t.mute = !t.mute; this.changed(); });
      h.querySelector('.x').addEventListener('click', () => { s.tracks = s.tracks.filter((x) => x !== t); s.clips = s.clips.filter((c) => c.track !== t.id); this.changed(); });
      h.querySelector('.nm').addEventListener('click', () => { const n = this.nodeOf(t); this.app.editor.goTo(0); this.app.editor.select([n.id]); this.app.focusNode(n); });
    });
    this.layout();
  }

  layout() {
    const dpr = Math.min(2, devicePixelRatio || 1);
    this.W = Math.max(this.scroll.clientWidth || 600, this.song.bars * 4 * this.beatW + 40);
    this.H = Math.max(this.scroll.clientHeight || 100, RULER + this.song.tracks.length * ROW + 10);
    this.cv.style.width = this.W + 'px'; this.cv.style.height = this.H + 'px';
    this.cv.width = this.W * dpr; this.cv.height = this.H * dpr;
    this.g.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.draw();
  }

  addTrack(nodeId) {
    const n = this.app.project.nodes.find((x) => x.id === nodeId);
    const t = { id: uid('t'), node: nodeId, mute: false };
    this.song.tracks.push(t);
    this.song.clips.push({ id: uid('c'), track: t.id, start: 0, len: this.defaultLen(n), offset: 0 });
    if (!this.song.enabled) { this.song.enabled = true; this.app.toast('Song mode on — the transport now plays the arrangement'); }
    this.changed();
  }

  defaultLen(n) {
    const T = TYPES[n.type];
    if (T.clipBeats) return T.clipBeats(n.params, this.app.project.bpm);
    const b = this.app.engine.buffers.get(n.params.sample);
    if (b) return Math.max(1, Math.ceil(b.duration / this.spb));
    return 4;
  }

  changed() {
    const s = this.song;
    const end = Math.max(0, ...s.clips.map((c) => c.start + c.len));
    if (end > s.bars * 4) s.bars = Math.ceil(end / 4);
    this.render();
    this.app.engine.rebuild();
    this.app.commit();
  }

  removeClip(c) { this.song.clips = this.song.clips.filter((x) => x !== c); this.changed(); }

  pos(e) {
    const r = this.cv.getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    return { x, y, beat: x / this.beatW, row: Math.floor((y - RULER) / ROW) };
  }
  q(b) { return Math.round(b / this.snap) * this.snap; }
  hit(e) {
    const p = this.pos(e);
    if (p.y < RULER) return { ruler: true, p };
    const t = this.song.tracks[p.row];
    if (!t) return { p };
    for (const c of this.song.clips) {
      if (c.track !== t.id) continue;
      const x0 = c.start * this.beatW, x1 = (c.start + c.len) * this.beatW;
      if (p.x >= x0 && p.x <= x1) return { clip: c, track: t, edge: x1 - p.x < 7 ? 'r' : p.x - x0 < 5 ? 'l' : null, p };
    }
    return { track: t, p };
  }

  dbl(e) {
    const h = this.hit(e);
    if (h.clip) {
      const n = this.nodeOf(h.track);
      if (n.type === 'pianoroll') this.app.openPianoRoll(n);
      if (n.type === 'sampler' && n.params.sample) this.app.openSampleEditor(n.params.sample);
      return;
    }
    if (h.track) {
      const n = this.nodeOf(h.track);
      this.song.clips.push({ id: uid('c'), track: h.track.id, start: Math.max(0, Math.floor(h.p.beat / this.snap) * this.snap), len: this.defaultLen(n), offset: 0 });
      this.changed();
    }
  }

  down(e) {
    if (e.button !== 0) return;
    const h = this.hit(e);
    if (h.ruler) {
      const seek = (ev) => this.app.engine.seek(Math.max(0, this.pos(ev).beat) * this.spb);
      seek(e);
      const mv = (ev) => seek(ev);
      const up = () => { window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up); };
      window.addEventListener('pointermove', mv); window.addEventListener('pointerup', up);
      return;
    }
    if (!h.clip) return;
    let c = h.clip;
    if (e.altKey) { c = { ...c, id: uid('c') }; this.song.clips.push(c); }
    const start = { ...c }, b0 = h.p.beat, mode = h.edge || 'move';
    this.drag = true;
    this.cv.setPointerCapture(e.pointerId);
    const mv = (ev) => {
      const d = this.pos(ev).beat - b0;
      if (mode === 'move') c.start = Math.max(0, this.q(start.start + d));
      else if (mode === 'r') c.len = Math.max(this.snap, this.q(start.len + d));
      else { // left edge trims: moves start and offset together
        const nd = Math.max(-start.offset, Math.min(start.len - this.snap, this.q(d)));
        c.start = start.start + nd; c.offset = start.offset + nd; c.len = start.len - nd;
      }
      this.draw();
    };
    const up = () => { this.drag = false; this.cv.removeEventListener('pointermove', mv); this.cv.removeEventListener('pointerup', up); this.changed(); };
    this.cv.addEventListener('pointermove', mv);
    this.cv.addEventListener('pointerup', up);
  }

  draw(play = -1) {
    const g = this.g, W = this.W, H = this.H, bw = this.beatW, s = this.song;
    if (!g) return;
    g.clearRect(0, 0, W, H);
    g.fillStyle = '#0a0e15'; g.fillRect(0, 0, W, H);
    const end = s.bars * 4 * bw;
    g.fillStyle = 'rgba(255,255,255,.025)'; g.fillRect(0, RULER, end, H);
    s.tracks.forEach((t, i) => { if (i % 2) { g.fillStyle = 'rgba(255,255,255,.018)'; g.fillRect(0, RULER + i * ROW, W, ROW); } });
    for (let b = 0; b <= s.bars * 4; b++) {
      const x = Math.round(b * bw) + 0.5, bar = b % 4 === 0;
      if (!bar && bw < 8) continue;
      g.fillStyle = bar ? 'rgba(255,255,255,.14)' : 'rgba(255,255,255,.05)';
      g.fillRect(x, RULER, 1, H);
      if (bar && (bw * 4 >= 28 || (b / 4) % 4 === 0)) { g.fillStyle = '#8792a8'; g.font = '10px "JetBrains Mono"'; g.fillText(String(b / 4 + 1), x + 3, 15); }
    }
    g.fillStyle = 'rgba(255,255,255,.08)'; g.fillRect(0, RULER - 1, W, 1);
    g.fillStyle = 'rgba(255,95,158,.5)'; g.fillRect(end, 0, 2, H);
    for (const c of s.clips) {
      const ti = s.tracks.findIndex((t) => t.id === c.track);
      if (ti < 0) continue;
      const t = s.tracks[ti], n = this.nodeOf(t), col = CATEGORIES[TYPES[n.type].cat].color;
      const x = c.start * bw, y = RULER + ti * ROW + 4, w = Math.max(4, c.len * bw - 1), h = ROW - 8;
      g.globalAlpha = t.mute ? 0.35 : 1;
      g.fillStyle = col + '33'; g.strokeStyle = col;
      g.beginPath(); g.roundRect ? g.roundRect(x, y, w, h, 5) : g.rect(x, y, w, h); g.fill(); g.stroke();
      g.save(); g.beginPath(); g.rect(x, y, w, h); g.clip();
      this.drawContent(n, c, x, y, w, h, col);
      g.fillStyle = '#fff'; g.font = '600 10px Inter'; g.fillText(this.label(n), x + 5, y + 11);
      g.restore();
      g.globalAlpha = 1;
    }
    if (play >= 0) { g.fillStyle = '#fff'; g.fillRect(play * bw, 0, 1.5, H); g.beginPath(); g.moveTo(play * bw - 5, 0); g.lineTo(play * bw + 6, 0); g.lineTo(play * bw + 0.5, 7); g.fill(); }
  }

  drawContent(n, c, x, y, w, h, col) {
    const g = this.g, bw = this.beatW;
    if (n.type === 'pianoroll') {
      const ns = n.data.notes, L = n.params.length;
      if (!ns.length) return;
      const lo = Math.min(...ns.map((q) => q.n)) - 1, hi = Math.max(...ns.map((q) => q.n)) + 1;
      g.fillStyle = col;
      for (let k = Math.floor(c.offset / L) * L; k < c.offset + c.len; k += L)
        for (const q of ns) {
          const b = k + q.s - c.offset;
          if (b + q.l < 0 || b > c.len) continue;
          g.fillRect(x + b * bw, y + 14 + (1 - (q.n - lo) / Math.max(1, hi - lo)) * (h - 18), Math.max(1, q.l * bw - 1), 2);
        }
    } else if (n.type === 'stepseq') {
      const sd = parseFloat(n.params.rate);
      g.fillStyle = col;
      for (let b = 0; b < c.len; b += sd) {
        const k = Math.round((b + c.offset) / sd), st = n.data.steps[k % n.params.steps];
        if (st && st.on) g.fillRect(x + b * bw, y + h - 6 - (st.semi + 12) / 3, Math.max(1, sd * bw - 1), 3);
      }
    } else if ((n.type === 'sampler' || n.type === 'granular') && this.app.engine.buffers.get(n.params.sample)) {
      const buf = this.app.engine.buffers.get(n.params.sample);
      const secs = c.len * this.spb, off = c.offset * this.spb;
      const span = Math.min(buf.duration - off, secs);
      if (span <= 0) return;
      const d = buf.getChannelData(0), i0 = Math.floor((off / buf.duration) * d.length), i1 = Math.floor(((off + span) / buf.duration) * d.length);
      const fake = { getChannelData: () => d.subarray(i0, i1) };
      g.save(); g.translate(x, y + 12); drawWave(g, fake, Math.max(1, Math.floor((span / this.spb) * bw)), h - 13, col + 'cc'); g.restore();
    }
  }

  animate() {
    if (!this.el.closest('.open') || !this.el.classList.contains('on')) return;
    const e = this.app.engine;
    if (!e.playing || !this.song.enabled) { if (this._p !== -1) { this._p = -1; this.draw(); } return; }
    this._p = e.position() / this.spb;
    this.draw(this._p);
  }
}

function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]); }
