// Sample editor: trim, fades, normalise, reverse, gain, slice markers, loop points,
// resampling. Edits rewrite the sample stored in the project (as 16-bit WAV); the
// editor keeps its own undo stack for them, and Duplicate keeps an untouched copy.

import { encodeWav } from './wav.js';
import { bytesToB64, b64ToBytes, uid } from './project.js';
import { detectOnsets, mono } from './dsp.js';

export class SampleEditor {
  constructor(app, el) {
    this.app = app;
    this.el = el;
    this.id = null;
    this.sel = null;      // [a, b] seconds
    this.view = null;     // [v0, v1] seconds
    this.undo = [];
    el.innerHTML = `
      <div class="pr-bar se-bar">
        <select class="se-pick btn ghost"></select>
        <button class="btn sm se-play" title="Play selection (or all)">▶</button>
        <span class="sep"></span>
        <button class="btn sm" data-op="trim" title="Keep only the selection">Trim</button>
        <button class="btn sm" data-op="cut" title="Delete the selection">Cut</button>
        <button class="btn sm" data-op="normalize">Normalize</button>
        <button class="btn sm" data-op="reverse">Reverse</button>
        <button class="btn sm" data-op="fadein">Fade in</button>
        <button class="btn sm" data-op="fadeout">Fade out</button>
        <button class="btn sm" data-op="quieter">−3 dB</button>
        <button class="btn sm" data-op="louder">+3 dB</button>
        <span class="sep"></span>
        <button class="btn sm" data-op="detect" title="Slice at transients">Auto-slice</button>
        <input class="se-sens" type="range" min="0" max="1" step="0.05" value="0.5" title="Slice sensitivity">
        <button class="btn sm" data-op="equal" title="Equal slices">÷ <span class="se-n">8</span></button>
        <button class="btn sm" data-op="clearslices">Clear slices</button>
        <button class="btn sm" data-op="loop" title="Use the selection as the Sampler loop region">Set loop</button>
        <span class="sep"></span>
        <select class="se-resample btn ghost" title="Resample (shrinks the project)"><option value="">Resample…</option><option value="44100:2">44.1k stereo</option><option value="44100:1">44.1k mono</option><option value="22050:1">22.05k mono</option></select>
        <button class="btn sm" data-op="dup">Duplicate</button>
        <button class="btn sm" data-op="undo">Undo edit</button>
        <button class="btn sm" data-op="export">⤓ WAV</button>
        <span class="grow"></span><span class="se-info"></span>
      </div>
      <div class="se-wrap"><canvas class="se-canvas"></canvas><div class="se-empty">Import or record a sample, then pick it here.</div></div>`;
    this.cv = el.querySelector('.se-canvas');
    this.g = this.cv.getContext('2d');
    el.querySelector('.se-pick').addEventListener('change', (e) => this.open(e.target.value));
    el.querySelector('.se-play').addEventListener('click', () => this.play());
    el.querySelectorAll('[data-op]').forEach((b) => b.addEventListener('click', () => this.op(b.dataset.op)));
    el.querySelector('.se-resample').addEventListener('change', (e) => { const v = e.target.value; e.target.value = ''; if (v) this.resample(...v.split(':').map(Number)); });
    this.cv.addEventListener('pointerdown', (e) => this.down(e));
    this.cv.addEventListener('wheel', (e) => this.wheel(e), { passive: false });
    this.cv.addEventListener('dblclick', (e) => this.dbl(e));
    new ResizeObserver(() => this.layout()).observe(el.querySelector('.se-wrap'));
  }

  get sample() { return this.app.project.samples.find((s) => s.id === this.id); }
  get buf() { return this.app.engine.buffers.get(this.id); }

  refreshList() {
    const pick = this.el.querySelector('.se-pick');
    pick.innerHTML = '<option value="">— sample —</option>' + this.app.project.samples.map((s) => `<option value="${s.id}">${esc(s.name)}</option>`).join('');
    if (!this.sample) this.id = null;
    pick.value = this.id || '';
    this.el.querySelector('.se-empty').style.display = this.buf ? 'none' : '';
  }

  open(id) {
    if (id !== this.id) { this.undo = []; this.sel = null; this.view = null; }
    this.id = id || null;
    this.refreshList();
    this.layout();
  }

  layout() {
    const wrap = this.el.querySelector('.se-wrap');
    const dpr = Math.min(2, devicePixelRatio || 1);
    this.W = wrap.clientWidth || 600; this.H = wrap.clientHeight || 160;
    this.cv.width = this.W * dpr; this.cv.height = this.H * dpr;
    this.cv.style.width = this.W + 'px'; this.cv.style.height = this.H + 'px';
    this.g.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.draw();
  }

  xOf(t) { const [a, b] = this.view; return ((t - a) / (b - a)) * this.W; }
  tOf(x) { const [a, b] = this.view; return a + (x / this.W) * (b - a); }

  draw(play = -1) {
    const g = this.g, W = this.W, H = this.H, buf = this.buf, s = this.sample;
    g.clearRect(0, 0, W, H);
    g.fillStyle = '#070a10'; g.fillRect(0, 0, W, H);
    const info = this.el.querySelector('.se-info');
    if (!buf) { info.textContent = ''; return; }
    if (!this.view) this.view = [0, buf.duration];
    const [v0, v1] = this.view;
    info.textContent = `${buf.duration.toFixed(3)}s · ${buf.sampleRate} Hz · ${buf.numberOfChannels === 1 ? 'mono' : 'stereo'} · ${(s.data.length * 0.75 / 1048576).toFixed(2)} MB` + (this.sel ? ` · sel ${(this.sel[1] - this.sel[0]).toFixed(3)}s` : '');
    if (s.loop) { g.fillStyle = 'rgba(77,255,166,.10)'; g.fillRect(this.xOf(s.loop.start), 0, this.xOf(s.loop.end) - this.xOf(s.loop.start), H); }
    const C = buf.numberOfChannels, h = H / C;
    for (let c = 0; c < C; c++) {
      const d = buf.getChannelData(c), mid = h * c + h / 2;
      const i0 = (v0 / buf.duration) * d.length, per = ((v1 - v0) / buf.duration) * d.length / W;
      g.fillStyle = '#3fd8ff';
      for (let x = 0; x < W; x++) {
        let lo = 1, hi = -1;
        const a = Math.floor(i0 + x * per), e = Math.min(d.length, Math.floor(i0 + (x + 1) * per) + 1);
        for (let i = Math.max(0, a); i < e; i++) { const v = d[i]; if (v < lo) lo = v; if (v > hi) hi = v; }
        if (hi >= lo) g.fillRect(x, mid - hi * (h / 2 - 2), 1, Math.max(1, (hi - lo) * (h / 2 - 2)));
      }
      g.fillStyle = 'rgba(255,255,255,.07)'; g.fillRect(0, mid, W, 1);
    }
    if (this.sel) { const a = this.xOf(this.sel[0]), b = this.xOf(this.sel[1]); g.fillStyle = 'rgba(169,139,255,.22)'; g.fillRect(a, 0, b - a, H); g.fillStyle = '#a98bff'; g.fillRect(a, 0, 1, H); g.fillRect(b, 0, 1, H); }
    if (s.slices) {
      g.fillStyle = '#ffb547'; g.font = '9px "JetBrains Mono"';
      [0, ...s.slices].forEach((t, i) => { const x = this.xOf(t); g.fillRect(x, 0, 1, H); g.fillText(String(i), x + 2, 10); });
    }
    if (s.loop) { g.fillStyle = '#4dffa6'; g.fillRect(this.xOf(s.loop.start), 0, 2, H); g.fillRect(this.xOf(s.loop.end) - 2, 0, 2, H); }
    if (play >= 0) { g.fillStyle = '#fff'; g.fillRect(this.xOf(play), 0, 1.5, H); }
  }

  down(e) {
    if (!this.buf || e.button !== 0) return;
    const r = this.cv.getBoundingClientRect(), t0 = this.tOf(e.clientX - r.left);
    if (e.ctrlKey || e.metaKey) { // add a slice marker
      const s = this.sample; s.slices = [...(s.slices || []), t0].filter((x) => x > 0).sort((a, b) => a - b);
      this.saveMeta(); return;
    }
    this.sel = null;
    this.cv.setPointerCapture(e.pointerId);
    const mv = (ev) => {
      const t = Math.max(0, Math.min(this.buf.duration, this.tOf(ev.clientX - r.left)));
      this.sel = Math.abs(t - t0) > 0.001 ? [Math.min(t, t0), Math.max(t, t0)] : null;
      this.draw();
    };
    const up = () => { this.cv.removeEventListener('pointermove', mv); this.cv.removeEventListener('pointerup', up); this.draw(); };
    this.cv.addEventListener('pointermove', mv); this.cv.addEventListener('pointerup', up);
  }

  dbl(e) {
    const s = this.sample;
    if (!s || !s.slices) return;
    const r = this.cv.getBoundingClientRect(), x = e.clientX - r.left;
    const i = s.slices.findIndex((t) => Math.abs(this.xOf(t) - x) < 6);
    if (i >= 0) { s.slices.splice(i, 1); this.saveMeta(); }
  }

  wheel(e) {
    if (!this.buf) return;
    e.preventDefault();
    const r = this.cv.getBoundingClientRect(), t = this.tOf(e.clientX - r.left), D = this.buf.duration;
    const [a, b] = this.view, f = Math.exp(e.deltaY * 0.002);
    let span = Math.min(D, Math.max(0.005, (b - a) * f));
    let na = t - ((t - a) / (b - a)) * span;
    na = Math.max(0, Math.min(D - span, na));
    this.view = [na, na + span];
    this.draw();
  }

  async play() {
    const buf = this.buf;
    if (!buf) return;
    const ctx = await this.app.engine.ensureCtx();
    if (this.src) { try { this.src.stop(); } catch {} this.src = null; return; }
    const [a, b] = this.sel || [0, buf.duration];
    const s = ctx.createBufferSource(); s.buffer = buf; s.connect(this.app.engine.master);
    s.start(0, a, b - a);
    this.src = s;
    const t0 = ctx.currentTime;
    const tick = () => { if (this.src !== s) return this.draw(); this.draw(a + ctx.currentTime - t0); requestAnimationFrame(tick); };
    s.onended = () => { if (this.src === s) this.src = null; this.draw(); };
    tick();
  }

  channels() { const b = this.buf; return Array.from({ length: b.numberOfChannels }, (_, c) => b.getChannelData(c).slice()); }

  async commitData(chs, rate, note) {
    const s = this.sample;
    this.undo.push({ data: s.data, mime: s.mime, slices: s.slices, loop: s.loop, name: s.name });
    if (this.undo.length > 20) this.undo.shift();
    const blob = encodeWav(chs, rate, 16);
    const bytes = await blob.arrayBuffer();
    s.data = bytesToB64(bytes); s.mime = 'audio/wav';
    if (!/\.wav$/i.test(s.name)) s.name = s.name.replace(/\.[a-z0-9]+$/i, '') + '.wav';
    await this.app.engine.decode(s.id, bytes);
    this.afterChange(note);
  }

  afterChange(note) {
    this.view = null;
    this.app.sampleChanged(this.id);
    this.refreshList();
    this.draw();
    if (note) this.app.toast(note);
  }

  saveMeta() { this.app.sampleChanged(this.id); this.draw(); }

  async op(name) {
    const s = this.sample, buf = this.buf;
    if (name === 'undo') {
      const u = this.undo.pop();
      if (!u) return this.app.toast('Nothing to undo in the sample editor');
      Object.assign(s, u);
      await this.app.engine.decode(s.id, b64ToBytes(s.data));
      return this.afterChange('Sample edit undone');
    }
    if (!s || !buf) return;
    const sr = buf.sampleRate, D = buf.duration;
    const [a, b] = this.sel || [0, D];
    const ia = Math.round(a * sr), ib = Math.round(b * sr);
    const chs = this.channels();
    const shift = (t, cut0, cut1, keep) => (keep ? t - cut0 : t < cut0 ? t : t - (cut1 - cut0));
    switch (name) {
      case 'trim': case 'cut': {
        if (!this.sel) return this.app.toast('Select a region first (drag on the waveform)');
        const keep = name === 'trim';
        const out = chs.map((c) => (keep ? c.slice(ia, ib) : concat(c.subarray(0, ia), c.subarray(ib))));
        s.slices = s.slices && s.slices.filter((t) => (keep ? t > a && t < b : t < a || t > b)).map((t) => shift(t, a, b, keep));
        s.loop = null;
        this.sel = null;
        return this.commitData(out, sr, keep ? 'Trimmed' : 'Cut');
      }
      case 'normalize': {
        let pk = 0; for (const c of chs) for (let i = ia; i < ib; i++) pk = Math.max(pk, Math.abs(c[i]));
        if (pk < 1e-6) return;
        const k = Math.pow(10, -1 / 20) / pk; for (const c of chs) for (let i = ia; i < ib; i++) c[i] *= k;
        return this.commitData(chs, sr, 'Normalized to −1 dBFS');
      }
      case 'reverse': for (const c of chs) c.subarray(ia, ib).reverse(); return this.commitData(chs, sr, 'Reversed');
      case 'fadein': case 'fadeout': {
        const n = ib - ia;
        for (const c of chs) for (let i = 0; i < n; i++) { const k = i / n; c[ia + i] *= name === 'fadein' ? k * k : (1 - k) * (1 - k); }
        return this.commitData(chs, sr, name === 'fadein' ? 'Faded in' : 'Faded out');
      }
      case 'louder': case 'quieter': {
        const k = Math.pow(10, (name === 'louder' ? 3 : -3) / 20);
        for (const c of chs) for (let i = ia; i < ib; i++) c[i] = Math.max(-1, Math.min(1, c[i] * k));
        return this.commitData(chs, sr);
      }
      case 'detect': {
        const sens = +this.el.querySelector('.se-sens').value;
        const on = detectOnsets(mono(buf), sr, sens).filter((t) => t > 0.01);
        s.slices = on;
        this.saveMeta();
        return this.app.toast(`${on.length + 1} slices — set a Sampler to Slices mode; notes from its Root up play slice 0, 1, 2…`);
      }
      case 'equal': {
        const n = Math.max(2, parseInt(prompt('Number of equal slices', '8'), 10) || 8);
        this.el.querySelector('.se-n').textContent = n;
        s.slices = Array.from({ length: n - 1 }, (_, i) => ((i + 1) * D) / n);
        return this.saveMeta();
      }
      case 'clearslices': s.slices = null; return this.saveMeta();
      case 'loop':
        if (!this.sel) { s.loop = null; this.saveMeta(); return this.app.toast('Loop region cleared'); }
        s.loop = { start: a, end: b }; this.saveMeta();
        return this.app.toast('Loop region set — Samplers with Loop on will loop this part');
      case 'dup': {
        const copy = { ...s, id: uid('s'), name: s.name.replace(/(\.[a-z0-9]+)?$/i, ' copy$1') };
        this.app.project.samples.push(copy);
        await this.app.engine.decode(copy.id, b64ToBytes(copy.data));
        this.app.sampleChanged(copy.id);
        this.open(copy.id);
        return this.app.toast('Duplicated — editing the copy');
      }
      case 'export': {
        const out = this.sel ? chs.map((c) => c.slice(ia, ib)) : chs;
        this.app.download(encodeWav(out, sr, 16), s.name.replace(/\.[a-z0-9]+$/i, '') + (this.sel ? '_sel' : '') + '.wav');
      }
    }
  }

  async resample(rate, channels) {
    const buf = this.buf;
    if (!buf) return;
    const frames = Math.ceil(buf.duration * rate);
    const ctx = new OfflineAudioContext(channels, frames, rate);
    const src = ctx.createBufferSource(); src.buffer = buf; src.connect(ctx.destination); src.start();
    const r = await ctx.startRendering();
    const before = this.sample.data.length;
    await this.commitData(Array.from({ length: channels }, (_, c) => r.getChannelData(c).slice()), rate);
    this.app.toast(`Resampled to ${rate} Hz ${channels === 1 ? 'mono' : 'stereo'} — ${(before * 0.75 / 1048576).toFixed(1)} → ${(this.sample.data.length * 0.75 / 1048576).toFixed(1)} MB`);
  }
}

function concat(a, b) { const o = new Float32Array(a.length + b.length); o.set(a); o.set(b, a.length); return o; }
function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]); }
