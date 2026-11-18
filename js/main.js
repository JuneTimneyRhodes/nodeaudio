// App shell: wires project, engine, editor and panels together.

import { TYPES, CATEGORIES, inputSockets, mtof } from './nodes.js';
import { Engine, loopSeconds } from './engine.js';
import { Editor, drawWave } from './editor.js';
import { PianoRoll } from './pianoroll.js';
import { TEMPLATES } from './templates.js';
import { makeZip } from './wav.js';
import * as proj from './project.js';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

class App {
  constructor() {
    this.project = proj.emptyProject();
    this.history = new proj.History();
    this.engine = new Engine(() => this.project);
    this.lastRender = new Map();
    this.fileHandle = null;
    this.clipboard = null;
    this.dirty = false;
    this.editor = new Editor(this, $('#canvas'));
    this.roll = new PianoRoll(this, $('#pianoroll'));
    this.engine.onActivity = (id, t) => {
      const ms = (t - this.engine.ctx.currentTime) * 1000;
      setTimeout(() => this.editor.flash(id), Math.max(0, ms));
    };
    this.engine.onStop = () => this.updateTransport();
    this.bindUI();
    this.bindKeys();
    this.loop();
  }

  // ---------------------------------------------------------------- lifecycle
  async boot() {
    const saved = await proj.idbGet('autosave');
    let p = null;
    if (saved) { try { p = proj.migrate(JSON.parse(saved)); } catch (e) { console.warn(e); } }
    await this.load(p || TEMPLATES['SFX bank (space combat)'](), { frame: !p });
  }

  async load(p, { frame = true } = {}) {
    this.engine.stop();
    this.roll.close();
    this.project = p;
    this.lastRender.clear();
    this.engine.buffers.clear();
    await Promise.all(p.samples.map((s) => this.engine.decode(s.id, proj.b64ToBytes(s.data)).catch((e) => this.toast(`Could not decode ${s.name}: ${e.message}`, 'err'))));
    this.history.reset(p);
    this.editor.sel.clear();
    this.editor.render();
    if (frame) requestAnimationFrame(() => this.editor.frameAll());
    this.renderPanels();
    this.saveSoon();
  }

  commit() {
    if (this.history.push(this.project)) { this.dirty = true; this.saveSoon(); }
    this.renderOutputsList();
    this.updateUndo();
  }
  commitSoon() { clearTimeout(this._cs); this._cs = setTimeout(() => this.commit(), 300); }
  saveSoon() {
    clearTimeout(this._as);
    this._as = setTimeout(() => proj.idbSet('autosave', proj.serialize(this.project)), 600);
  }

  structureChanged() {
    this.editor.drawLinks();
    this.engine.rebuild();
    this.commit();
    this.renderOutputsList();
  }

  restore(fn) {
    if (!fn(this.project)) return;
    this.editor.render();
    this.engine.rebuild();
    this.renderPanels();
    this.updateUndo();
    this.saveSoon();
  }

  // ---------------------------------------------------------------- graph ops
  setParam(node, key, value) {
    node.params[key] = value;
    this.engine.setParam(node.id, key, value);
    if (['adsr', 'filter', 'stepseq', 'pianoroll', 'sampler'].includes(node.type)) this.editor.redrawWidgets(node.id);
    if (node.type === 'output' && key === 'name') this.renderOutputsList();
    if (node.type === 'pianoroll' && key === 'length' && this.roll.node === node) this.roll.open(node);
  }

  connect(from, to, silent = false) {
    const fs = (TYPES[this.node(from.node).type].outputs || []).find((s) => s.key === from.port);
    const ts = inputSockets(this.node(to.node).type).find((s) => s.key === to.port);
    if (!fs || !ts || fs.type !== ts.type || from.node === to.node) return;
    if (this.project.links.some((l) => l.from.node === from.node && l.from.port === from.port && l.to.node === to.node && l.to.port === to.port)) return;
    this.project.links.push({ id: proj.uid('l'), from: { ...from }, to: { ...to } });
    if (!silent) this.structureChanged();
  }

  node(id) { return this.project.nodes.find((n) => n.id === id); }
  isActive(id) { return !!(this.engine.graph && this.engine.graph.active.has(id)); }

  uniqueCueName(base) {
    const names = new Set(this.project.nodes.filter((n) => n.type === 'output').map((n) => n.params.name));
    if (!names.has(base)) return base;
    for (let i = 2; ; i++) if (!names.has(`${base}_${i}`)) return `${base}_${i}`;
  }

  // ---------------------------------------------------------------- transport
  async togglePlay() {
    if (this.engine.playing) this.engine.stop();
    else await this.engine.play(null);
    this.updateTransport();
  }
  async toggleSolo(id) {
    if (this.engine.playing && this.engine.solo === id) this.engine.stop();
    else await this.engine.play(id);
    this.updateTransport();
  }
  updateTransport() {
    $('#play').classList.toggle('on', this.engine.playing);
    $('#play').innerHTML = this.engine.playing ? ICON.stop : ICON.play;
    $('#app').classList.toggle('playing', this.engine.playing);
    for (const n of this.project.nodes) if (n.type === 'output') this.editor.redrawWidgets(n.id);
    this.renderOutputsList();
  }

  async previewNote(note) {
    const ctx = await this.engine.ensureCtx();
    const o = ctx.createOscillator(), g = ctx.createGain(), t = ctx.currentTime;
    o.type = 'triangle'; o.frequency.value = mtof(note);
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.25, t + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.35);
    o.connect(g).connect(this.engine.master); o.start(t); o.stop(t + 0.4);
  }

  loop() {
    const frame = () => {
      this.editor.animate();
      this.roll.animate();
      this.drawTransport();
      this.drawMeter();
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  }

  drawTransport() {
    const p = this.project, e = this.engine;
    const pos = e.playing ? e.position() : 0;
    const spb = 60 / p.bpm, beat = pos / spb;
    const bar = Math.floor(beat / 4) + 1, b = Math.floor(beat % 4) + 1, six = Math.floor((beat % 1) * 4) + 1;
    const txt = `${bar}.${b}.${six}`;
    if (this._tp !== txt) { this._tp = txt; $('#pos-bbt').textContent = txt; }
    const secs = pos.toFixed(2) + 's';
    if (this._ts !== secs) { this._ts = secs; $('#pos-sec').textContent = secs; }
    $('#pos-bar').style.transform = `scaleX(${e.playing ? pos / e.L : 0})`;
  }

  drawMeter() {
    const cv = $('#meter'), g = cv.getContext('2d');
    const W = cv.width, H = cv.height;
    g.clearRect(0, 0, W, H);
    const a = this.engine.analyser;
    if (!a || !this.engine.playing) {
      g.strokeStyle = 'rgba(255,255,255,0.12)'; g.beginPath(); g.moveTo(0, H / 2); g.lineTo(W, H / 2); g.stroke(); return;
    }
    const buf = this._mb || (this._mb = new Float32Array(a.fftSize));
    a.getFloatTimeDomainData(buf);
    let pk = 0;
    g.beginPath();
    for (let x = 0; x < W; x++) {
      const v = buf[Math.floor((x / W) * buf.length)];
      pk = Math.max(pk, Math.abs(v));
      const y = H / 2 - v * (H / 2 - 2);
      x ? g.lineTo(x, y) : g.moveTo(x, y);
    }
    for (let i = 0; i < buf.length; i++) pk = Math.max(pk, Math.abs(buf[i]));
    const grad = g.createLinearGradient(0, 0, W, 0);
    grad.addColorStop(0, '#3fd8ff'); grad.addColorStop(0.5, '#a98bff'); grad.addColorStop(1, '#ff5f9e');
    g.strokeStyle = grad; g.lineWidth = 1.5 * (devicePixelRatio > 1 ? 2 : 1); g.stroke();
    this._pk = Math.max(pk, (this._pk || 0) * 0.94);
    const db = 20 * Math.log10(this._pk || 1e-9);
    const el = $('#peak');
    el.textContent = db < -59 ? '-∞' : db.toFixed(1);
    el.classList.toggle('clip', this._pk >= 0.999);
  }

  // ---------------------------------------------------------------- samples
  async importSample(file) {
    try {
      const bytes = await file.arrayBuffer();
      const id = proj.uid('s');
      await this.engine.decode(id, bytes);
      this.project.samples.push({ id, name: file.name, mime: file.type || 'audio/wav', data: proj.bytesToB64(bytes) });
      this.renderSamples();
      this.editor.refreshSampleSelects();
      this.saveSoon();
      this.toast(`Imported ${file.name}`);
      return this.project.samples[this.project.samples.length - 1];
    } catch (e) {
      this.toast(`Could not import ${file.name}: ${e.message || e}`, 'err');
      return null;
    }
  }

  removeSample(id) {
    this.project.samples = this.project.samples.filter((s) => s.id !== id);
    this.engine.buffers.delete(id);
    for (const n of this.project.nodes) if (n.type === 'sampler' && n.params.sample === id) n.params.sample = '';
    this.renderSamples();
    this.editor.refreshSampleSelects();
    this.commit();
    this.saveSoon();
  }

  // ---------------------------------------------------------------- files
  async save(as = false) {
    const text = proj.serialize(this.project);
    const name = proj.safeName(this.project.name) + '.nodeaudio.json';
    if (window.showSaveFilePicker) {
      try {
        if (!this.fileHandle || as) this.fileHandle = await showSaveFilePicker({ suggestedName: name, types: [{ description: 'NodeAudio project', accept: { 'application/json': ['.json'] } }] });
        const w = await this.fileHandle.createWritable();
        await w.write(text); await w.close();
        this.dirty = false;
        this.toast(`Saved ${this.fileHandle.name}`);
        return;
      } catch (e) { if (e.name === 'AbortError') return; console.warn(e); }
    }
    proj.download(new Blob([text], { type: 'application/json' }), name);
    this.dirty = false;
    this.toast(`Saved ${name}`);
  }

  async openFile(file) {
    try {
      const p = proj.migrate(JSON.parse(await file.text()));
      this.fileHandle = null;
      await this.load(p);
      this.toast(`Opened ${file.name}`);
    } catch (e) { this.toast(`Could not open ${file.name}: ${e.message}`, 'err'); }
  }

  async handleFiles(files, at) {
    let i = 0;
    for (const f of files) {
      if (/\.json$/i.test(f.name)) { await this.openFile(f); return; }
      if (f.type.startsWith('audio') || /\.(wav|mp3|ogg|flac|m4a|aiff?|webm)$/i.test(f.name)) {
        const s = await this.importSample(f);
        if (s && at) this.addSampler(s.id, { x: at.x + i * 30, y: at.y + i * 30 });
        i++;
      }
    }
  }

  addSampler(sampleId, at) {
    const n = this.editor.addNode('sampler', at);
    this.setParam(n, 'sample', sampleId);
    this.editor.syncNode(n);
    this.commit();
  }

  // ---------------------------------------------------------------- export
  outputs() { return this.project.nodes.filter((n) => n.type === 'output'); }

  describeFormat() {
    const x = this.project.export;
    return `${x.sampleRate} Hz · ${x.channels === 1 ? 'mono' : 'stereo'} · ${x.bitDepth === 32 ? '32f' : x.bitDepth + '-bit'}`;
  }

  async exportOne(id) {
    const n = this.node(id);
    if (!n) return;
    this.busy(true, `Rendering ${n.params.name}…`);
    try {
      const r = await this.engine.renderWav(id, this.project.export);
      this.lastRender.set(id, r);
      this.editor.redrawWidgets(id);
      proj.download(r.blob, proj.safeName(n.params.name) + '.wav');
      this.toast(`${proj.safeName(n.params.name)}.wav — ${this.describeFormat()} · ${r.seconds.toFixed(2)}s${r.loop ? ' · loop' : ''}`);
      this.renderOutputsList();
    } catch (e) { console.error(e); this.toast('Export failed: ' + e.message, 'err'); }
    this.busy(false);
  }

  async exportAll() {
    const outs = this.outputs().filter((n) => !n.params.mute);
    if (!outs.length) { this.toast('No Output nodes to export', 'err'); return; }
    if (outs.length === 1) return this.exportOne(outs[0].id);
    const files = [], used = new Set();
    try {
      for (const [i, n] of outs.entries()) {
        this.busy(true, `Rendering ${i + 1}/${outs.length}: ${n.params.name}…`);
        const r = await this.engine.renderWav(n.id, this.project.export);
        this.lastRender.set(n.id, r);
        let name = proj.safeName(n.params.name);
        while (used.has(name)) name += '_';
        used.add(name);
        files.push({ name: name + '.wav', blob: r.blob });
      }
      const zip = await makeZip(files);
      proj.download(zip, proj.safeName(this.project.name) + '_cues.zip');
      this.toast(`Exported ${files.length} cues — ${this.describeFormat()}`);
    } catch (e) { console.error(e); this.toast('Export failed: ' + e.message, 'err'); }
    this.busy(false);
    this.editor.redrawWidgets();
    this.renderOutputsList();
  }

  async previewRender(id) {
    // render then play the processed file, so loops can be checked for seams
    const n = this.node(id);
    this.busy(true, `Rendering ${n.params.name}…`);
    try {
      const r = await this.engine.render(id, this.project.export);
      this.lastRender.set(id, r);
      const ctx = await this.engine.ensureCtx();
      const b = ctx.createBuffer(r.channels.length, r.channels[0].length, r.sampleRate);
      r.channels.forEach((c, i) => b.copyToChannel(c, i));
      if (this._pv) try { this._pv.stop(); } catch {}
      const s = ctx.createBufferSource();
      s.buffer = b; s.loop = !!r.loop;
      s.connect(this.engine.master); s.start();
      this._pv = s;
      if (r.loop) setTimeout(() => { try { s.stop(); } catch {} }, Math.max(4000, r.seconds * 3000));
      this.toast(`Previewing rendered ${n.params.name}${r.loop ? ' (looping ×3 to check the seam)' : ''}`);
    } catch (e) { this.toast('Render failed: ' + e.message, 'err'); }
    this.busy(false);
    this.editor.redrawWidgets(id);
  }

  // ---------------------------------------------------------------- UI
  bindUI() {
    $('#play').addEventListener('click', () => this.togglePlay());
    $('#loop').addEventListener('click', () => { this.engine.loop = !this.engine.loop; $('#loop').classList.toggle('on', this.engine.loop); });
    $('#undo').addEventListener('click', () => this.restore((p) => this.history.undo(p)));
    $('#redo').addEventListener('click', () => this.restore((p) => this.history.redo(p)));
    $('#save').addEventListener('click', () => this.save());
    $('#open').addEventListener('click', () => $('#file-open').click());
    $('#file-open').addEventListener('change', (e) => { const f = e.target.files[0]; if (f) this.openFile(f); e.target.value = ''; });
    $('#import').addEventListener('click', () => $('#file-sample').click());
    $('#file-sample').addEventListener('change', async (e) => { for (const f of e.target.files) await this.importSample(f); e.target.value = ''; });
    $('#export-all').addEventListener('click', () => this.exportAll());
    $('#frame').addEventListener('click', () => this.editor.frameAll());

    const tm = $('#templates');
    tm.innerHTML = '<option value="">New from template…</option>' + Object.keys(TEMPLATES).map((k) => `<option>${esc(k)}</option>`).join('');
    tm.addEventListener('change', async () => {
      const k = tm.value; tm.value = '';
      if (!k) return;
      if (this.dirty && !confirm('Replace the current project? Save it first if you want to keep it.')) return;
      this.fileHandle = null;
      await this.load(TEMPLATES[k]());
      this.dirty = false;
    });

    // project fields
    $('#p-name').addEventListener('input', (e) => { this.project.name = e.target.value; });
    $('#p-name').addEventListener('change', () => this.commit());
    const num = (sel, key, min, max) => {
      const el = $(sel);
      el.addEventListener('change', () => {
        const v = Math.max(min, Math.min(max, parseFloat(el.value) || this.project[key]));
        this.project[key] = v; el.value = v;
        this.engine.rebuild(); this.commit(); this.renderProject();
      });
    };
    num('#p-bpm', 'bpm', 20, 400);
    num('#p-len', 'lengthBeats', 0.25, 512);

    // drag & drop onto canvas
    const cv = $('#canvas');
    cv.addEventListener('dragover', (e) => { e.preventDefault(); cv.classList.add('drop'); });
    cv.addEventListener('dragleave', (e) => { if (e.target === cv) cv.classList.remove('drop'); });
    cv.addEventListener('drop', (e) => {
      e.preventDefault(); cv.classList.remove('drop');
      const at = this.editor.toWorld(e.clientX, e.clientY);
      const type = e.dataTransfer.getData('application/x-nodeaudio-type');
      const sid = e.dataTransfer.getData('application/x-nodeaudio-sample');
      if (type) return void this.editor.addNode(type, at);
      if (sid) return void this.addSampler(sid, at);
      if (e.dataTransfer.files.length) this.handleFiles([...e.dataTransfer.files], at);
    });
    document.addEventListener('dragover', (e) => e.preventDefault());
    document.addEventListener('drop', (e) => e.preventDefault());

    // palette
    const pal = $('#palette');
    const search = $('#palette-search');
    const renderPalette = () => {
      const q = search.value.trim().toLowerCase();
      pal.innerHTML = '';
      for (const [ck, c] of Object.entries(CATEGORIES)) {
        const items = Object.entries(TYPES).filter(([k, t]) => t.cat === ck && (!q || (t.title + ' ' + t.desc + ' ' + c.label).toLowerCase().includes(q)));
        if (!items.length) continue;
        const h = document.createElement('div');
        h.className = 'pal-cat'; h.style.setProperty('--cat', c.color); h.textContent = c.label;
        pal.appendChild(h);
        for (const [k, t] of items) {
          const it = document.createElement('div');
          it.className = 'pal-item'; it.draggable = true; it.style.setProperty('--cat', c.color);
          it.innerHTML = `<span class="sw"></span><span>${t.title}</span>`;
          it.title = t.desc;
          it.addEventListener('dragstart', (e) => e.dataTransfer.setData('application/x-nodeaudio-type', k));
          it.addEventListener('click', () => {
            const r = cv.getBoundingClientRect();
            const at = this.editor.toWorld(r.left + r.width / 2 - 110, r.top + r.height / 2 - 80);
            this.editor.addNode(k, at);
          });
          pal.appendChild(it);
        }
      }
    };
    search.addEventListener('input', renderPalette);
    search.addEventListener('keydown', (e) => e.stopPropagation());
    renderPalette();

    // export settings
    const ex = (sel, key, parse) => $(sel).addEventListener('change', (e) => {
      const el = e.target;
      this.project.export[key] = parse(el.type === 'checkbox' ? el.checked : el.value);
      this.commit(); this.renderExport();
    });
    ex('#x-rate', 'sampleRate', (v) => parseInt(v, 10));
    ex('#x-ch', 'channels', (v) => parseInt(v, 10));
    ex('#x-bits', 'bitDepth', (v) => parseInt(v, 10));
    ex('#x-norm', 'normalize', Boolean);
    ex('#x-peak', 'peakDb', (v) => Math.min(0, parseFloat(v) || -1));
    ex('#x-trim', 'trim', Boolean);
    $('#preset-godot').addEventListener('click', () => { Object.assign(this.project.export, proj.GODOT_EXPORT); this.commit(); this.renderExport(); this.toast('Export preset: Godot SFX — 22050 Hz mono 16-bit (matches Synth.MIX_RATE)'); });
    $('#preset-music').addEventListener('click', () => { Object.assign(this.project.export, { sampleRate: 44100, channels: 2, bitDepth: 16, normalize: true, peakDb: -1, trim: false }); this.commit(); this.renderExport(); this.toast('Export preset: Godot music — 44.1 kHz stereo 16-bit'); });

    $('#help-btn').addEventListener('click', () => $('#help').classList.toggle('open'));
    $('#help').addEventListener('click', (e) => { if (e.target.id === 'help' || e.target.closest('.close')) $('#help').classList.remove('open'); });
    window.addEventListener('beforeunload', (e) => { if (this.dirty) { proj.idbSet('autosave', proj.serialize(this.project)); } });
  }

  bindKeys() {
    window.addEventListener('keydown', (e) => {
      if (e.target.closest('input,select,textarea')) return;
      const mod = e.ctrlKey || e.metaKey, k = e.key.toLowerCase();
      if (k === ' ') { e.preventDefault(); this.togglePlay(); }
      else if (mod && k === 'z' && !e.shiftKey) { e.preventDefault(); this.restore((p) => this.history.undo(p)); }
      else if (mod && (k === 'y' || (k === 'z' && e.shiftKey))) { e.preventDefault(); this.restore((p) => this.history.redo(p)); }
      else if (mod && k === 's') { e.preventDefault(); this.save(e.shiftKey); }
      else if (mod && k === 'o') { e.preventDefault(); $('#file-open').click(); }
      else if (mod && k === 'e') { e.preventDefault(); this.exportAll(); }
      else if (mod && k === 'c') { this.clipboard = this.editor.copy(); }
      else if (mod && k === 'v') { const r = $('#canvas').getBoundingClientRect(); this.editor.paste(this.clipboard, this._mouse ? this.editor.toWorld(this._mouse.x, this._mouse.y) : this.editor.toWorld(r.left + 100, r.top + 100)); }
      else if (mod && k === 'd') { e.preventDefault(); this.editor.paste(this.editor.copy()); }
      else if (mod && k === 'a') { e.preventDefault(); this.editor.select(this.project.nodes.map((n) => n.id)); }
      else if (k === 'delete' || k === 'backspace' || k === 'x') { this.editor.deleteSelection(); }
      else if ((k === 'a' && e.shiftKey) || k === 'tab') { e.preventDefault(); const m = this._mouse || { x: innerWidth / 2, y: innerHeight / 2 }; this.openAddMenu(m.x, m.y); }
      else if (k === 'f' || k === 'home') this.editor.frameAll();
      else if (k === 'escape') { this.closeAddMenu(); this.roll.close(); $('#help').classList.remove('open'); }
      else if (k === '?') $('#help').classList.toggle('open');
    });
    window.addEventListener('pointermove', (e) => (this._mouse = { x: e.clientX, y: e.clientY }), { passive: true });
  }

  // ---------------------------------------------------------------- add menu
  openAddMenu(cx, cy, opts = {}) {
    const m = $('#addmenu');
    const at = this.editor.toWorld(cx, cy);
    const from = opts.from;
    m.classList.add('open');
    const W = 260, H = 380;
    m.style.left = Math.min(cx, innerWidth - W - 8) + 'px';
    m.style.top = Math.min(cy, innerHeight - H - 8) + 'px';
    const input = $('input', m), list = $('.am-list', m);
    input.value = '';
    let idx = 0, items = [];
    const ok = (k) => {
      if (!from) return true;
      return from.reverse ? (TYPES[k].outputs || []).some((s) => s.type === from.type) : inputSockets(k).some((s) => s.type === from.type);
    };
    const render = () => {
      const q = input.value.trim().toLowerCase();
      items = Object.entries(TYPES).filter(([k, t]) => ok(k) && (!q || (t.title + ' ' + CATEGORIES[t.cat].label).toLowerCase().includes(q)));
      idx = Math.min(idx, Math.max(0, items.length - 1));
      list.innerHTML = items.map(([k, t], i) => `<div class="am-item${i === idx ? ' on' : ''}" data-k="${k}" style="--cat:${CATEGORIES[t.cat].color}"><span class="sw"></span><span class="t">${t.title}</span><span class="c">${CATEGORIES[t.cat].label}</span></div>`).join('') || '<div class="am-empty">No match</div>';
      $('.am-desc', m).textContent = items[idx] ? items[idx][1].desc : '';
    };
    const pick = (k) => { this.closeAddMenu(); this.editor.addNode(k, at, from); };
    input.oninput = () => { idx = 0; render(); };
    input.onkeydown = (e) => {
      e.stopPropagation();
      if (e.key === 'ArrowDown') { idx = Math.min(items.length - 1, idx + 1); render(); e.preventDefault(); }
      else if (e.key === 'ArrowUp') { idx = Math.max(0, idx - 1); render(); e.preventDefault(); }
      else if (e.key === 'Enter' && items[idx]) pick(items[idx][0]);
      else if (e.key === 'Escape') this.closeAddMenu();
    };
    list.onpointerdown = (e) => { const it = e.target.closest('.am-item'); if (it) { e.preventDefault(); pick(it.dataset.k); } };
    list.onpointermove = (e) => { const it = e.target.closest('.am-item'); if (it) { const i = items.findIndex(([k]) => k === it.dataset.k); if (i !== idx) { idx = i; render(); } } };
    render();
    setTimeout(() => input.focus(), 0);
    this._amClose = (e) => { if (!m.contains(e.target)) this.closeAddMenu(); };
    setTimeout(() => window.addEventListener('pointerdown', this._amClose), 0);
  }
  closeAddMenu() {
    $('#addmenu').classList.remove('open');
    window.removeEventListener('pointerdown', this._amClose);
  }

  openPianoRoll(n) { this.roll.open(n); }

  // ---------------------------------------------------------------- panels
  renderPanels() {
    this.renderProject();
    this.renderExport();
    this.renderSamples();
    this.renderOutputsList();
    this.onSelection();
    this.updateUndo();
    this.updateTransport();
    $('#loop').classList.toggle('on', this.engine.loop);
  }

  renderProject() {
    const p = this.project;
    $('#p-name').value = p.name;
    $('#p-bpm').value = p.bpm;
    $('#p-len').value = p.lengthBeats;
    $('#p-secs').textContent = loopSeconds(p).toFixed(3) + ' s';
  }

  renderExport() {
    const x = this.project.export;
    $('#x-rate').value = x.sampleRate; $('#x-ch').value = x.channels; $('#x-bits').value = x.bitDepth;
    $('#x-norm').checked = x.normalize; $('#x-peak').value = x.peakDb; $('#x-trim').checked = x.trim;
    $('#x-peak').disabled = !x.normalize;
    const godot = x.sampleRate === 22050 && x.channels === 1 && x.bitDepth === 16;
    $('#preset-godot').classList.toggle('on', godot);
    $('#preset-music').classList.toggle('on', x.sampleRate === 44100 && x.channels === 2 && x.bitDepth === 16);
    $('#fmt-line').textContent = this.describeFormat();
  }

  renderSamples() {
    const list = $('#samples');
    if (!this.project.samples.length) {
      list.innerHTML = '<div class="empty">Drop audio files anywhere, or use Import. Samples are embedded in the project JSON.</div>';
      return;
    }
    list.innerHTML = '';
    for (const s of this.project.samples) {
      const it = document.createElement('div');
      it.className = 'smp'; it.draggable = true;
      it.innerHTML = `<canvas width="200" height="28"></canvas><div class="smp-row"><span class="nm" title="${esc(s.name)}">${esc(s.name)}</span><span class="dur"></span><button class="x" title="Remove from project">✕</button></div>`;
      const buf = this.engine.buffers.get(s.id);
      if (buf) {
        drawWave(it.querySelector('canvas').getContext('2d'), buf, 200, 28, '#3fd8ff');
        it.querySelector('.dur').textContent = buf.duration.toFixed(2) + 's';
      }
      it.addEventListener('dragstart', (e) => e.dataTransfer.setData('application/x-nodeaudio-sample', s.id));
      it.querySelector('.x').addEventListener('click', () => { if (confirm(`Remove ${s.name} from the project?`)) this.removeSample(s.id); });
      it.addEventListener('dblclick', async () => {
        const ctx = await this.engine.ensureCtx();
        const src = ctx.createBufferSource(); src.buffer = this.engine.buffers.get(s.id); src.connect(this.engine.master); src.start();
      });
      it.title = 'Drag onto the canvas to make a Sampler · double-click to audition';
      list.appendChild(it);
    }
  }

  renderOutputsList() {
    const list = $('#outputs');
    if (!list) return;
    const outs = this.outputs();
    if (!outs.length) { list.innerHTML = '<div class="empty">Add an Output node — each one is a cue.</div>'; return; }
    list.innerHTML = '';
    for (const n of outs) {
      const r = this.lastRender.get(n.id);
      const it = document.createElement('div');
      it.className = 'cue' + (n.params.mute ? ' muted' : '') + (this.engine.playing && this.engine.solo === n.id ? ' playing' : '');
      it.innerHTML = `
        <div class="cue-top"><span class="nm">${esc(proj.safeName(n.params.name))}.wav</span>${n.params.loop ? '<span class="badge">loop</span>' : ''}</div>
        <div class="cue-meta">${r ? `${r.seconds.toFixed(2)} s · peak ${(20 * Math.log10(r.peak || 1e-9)).toFixed(1)} dB` : (n.params.length || loopSeconds(this.project)).toFixed(2) + ' s' + (n.params.loop ? '' : ` + ${n.params.tail}s tail`)}</div>
        <div class="cue-btns">
          <button class="btn sm solo">${this.engine.playing && this.engine.solo === n.id ? ICON.stop : ICON.play} Live</button>
          <button class="btn sm prev" title="Render with export settings and play the result">Render ▶</button>
          <button class="btn sm accent exp">⤓ WAV</button>
        </div>`;
      it.querySelector('.solo').addEventListener('click', () => this.toggleSolo(n.id));
      it.querySelector('.prev').addEventListener('click', () => this.previewRender(n.id));
      it.querySelector('.exp').addEventListener('click', () => this.exportOne(n.id));
      it.querySelector('.nm').addEventListener('click', () => { this.editor.select([n.id]); this.focusNode(n); });
      list.appendChild(it);
    }
    $('#export-all').textContent = outs.length > 1 ? `Export all ${outs.filter((n) => !n.params.mute).length} cues (.zip)` : 'Export WAV';
  }

  focusNode(n) {
    const r = $('#canvas').getBoundingClientRect(), v = this.project.view;
    v.x = r.width / 2 - (n.x + 110) * v.zoom; v.y = r.height / 2 - (n.y + 80) * v.zoom;
    this.editor.applyView();
  }

  onSelection() {
    const box = $('#inspect');
    if (!box) return;
    const ids = [...this.editor.sel];
    if (ids.length !== 1) {
      box.innerHTML = ids.length ? `<div class="empty">${ids.length} nodes selected</div>` : '<div class="empty">Select a node to see what it does.</div>';
      return;
    }
    const n = this.node(ids[0]), T = TYPES[n.type], c = CATEGORIES[T.cat];
    box.innerHTML = `<div class="ins-title" style="--cat:${c.color}"><span class="sw"></span>${T.title}<span class="c">${c.label}</span></div><p>${T.desc || ''}</p>`;
  }

  updateUndo() {
    $('#undo').disabled = this.history.i <= 0;
    $('#redo').disabled = this.history.i >= this.history.stack.length - 1;
  }

  // ---------------------------------------------------------------- feedback
  toast(msg, kind = '') {
    const t = document.createElement('div');
    t.className = 'toast ' + kind;
    t.textContent = msg;
    $('#toasts').appendChild(t);
    requestAnimationFrame(() => t.classList.add('in'));
    setTimeout(() => { t.classList.remove('in'); setTimeout(() => t.remove(), 300); }, kind === 'err' ? 6000 : 3200);
  }
  busy(on, msg = '') {
    $('#busy').classList.toggle('on', on);
    $('#busy-msg').textContent = msg;
  }
}

const ICON = {
  play: '<svg viewBox="0 0 16 16" width="14" height="14"><path d="M4 2.5v11l9-5.5z" fill="currentColor"/></svg>',
  stop: '<svg viewBox="0 0 16 16" width="14" height="14"><rect x="3.5" y="3.5" width="9" height="9" rx="1.5" fill="currentColor"/></svg>',
};

const app = new App();
window.nodeaudio = app; // handy from the console
app.boot();
