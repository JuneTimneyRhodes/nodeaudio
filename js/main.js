// App shell: wires project, engine, editor, dock panels and side panels together.

import { TYPES, CATEGORIES, inputsOf, outputsOf, mtof } from './nodes.js';
import { Engine, loopSeconds, songSeconds, timelineSeconds, flatten } from './engine.js';
import { Editor, drawWave } from './editor.js';
import { PianoRoll } from './pianoroll.js';
import { Arrangement } from './song.js';
import { SampleEditor } from './sampleeditor.js';
import { RenderView } from './renderview.js';
import { LiveInput } from './live.js';
import { Recorder } from './recorder.js';
import { TEMPLATES } from './templates.js';
import { FACTORY, loadUserPresets, saveUserPresets } from './presets.js';
import { encodeProject, decodeHash } from './share.js';
import { codegen, codegenFile, funcName } from './gamesynth.js';
import { makeZip, encodeWav } from './wav.js';
import * as proj from './project.js';

const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const MB = (b64len) => (b64len * 0.75) / 1048576;

class App {
  constructor() {
    this.project = proj.emptyProject();
    this.history = new proj.History();
    this.engine = new Engine(() => this.project);
    this.lastRender = new Map();   // output params object -> last render result
    this.fileHandle = null;
    this.clipboard = null;
    this.dirty = false;
    this.recArm = false;
    this.pendingRec = new Map();
    this.userPresets = [];
    this.editor = new Editor(this, $('#canvas'));
    this.roll = new PianoRoll(this, $('#pianoroll'));
    this.arr = new Arrangement(this, $('#arrangement'));
    this.sed = new SampleEditor(this, $('#sampleeditor'));
    this.rview = new RenderView(this);
    this.live = new LiveInput(this);
    this.recorder = new Recorder(this);
    this.engine.onActivity = (id, t) => {
      const ms = (t - this.engine.ctx.currentTime) * 1000;
      const local = id.split('/').pop();
      setTimeout(() => this.editor.flash(local), Math.max(0, ms));
    };
    this.engine.onStop = () => this.updateTransport();
    this.engine.onLiveNote = (on, note, vel, id) => this.recordNote(on, note, vel, id);
    this.bindUI();
    this.bindKeys();
    this.loop();
  }

  // ---------------------------------------------------------------- lifecycle
  async boot() {
    let p = null, fromLink = false;
    if (location.hash.includes('p=')) {
      try { p = proj.migrate(await decodeHash(location.hash)); fromLink = true; } catch (e) { this.toast('Could not open the shared link: ' + e.message, 'err'); }
      history.replaceState(null, '', location.pathname);
    }
    if (!p) {
      const saved = await proj.idbGet('autosave');
      if (saved) { try { p = proj.migrate(JSON.parse(saved)); } catch (e) { console.warn(e); } }
    }
    await this.load(p || TEMPLATES['SFX bank (space combat)'](), { frame: !p || fromLink });
    if (fromLink) {
      this.toast('Opened shared project');
      const miss = p.missingSamples || [];
      if (miss.length) this.toast(`${miss.length} sample(s) weren't in the link: ${miss.map((m) => m.name).join(', ')}`, 'err');
    }
    this.userPresets = await loadUserPresets();
    this.renderPresets();
    this.registerSW();
  }

  async load(p, { frame = true } = {}) {
    this.engine.stop();
    this.roll.close();
    this.project = p;
    this.lastRender.clear();
    this.engine.buffers.clear();
    this.engine.gsCache.clear();
    await Promise.all(p.samples.map((s) => this.engine.decode(s.id, proj.b64ToBytes(s.data)).catch((e) => this.toast(`Could not decode ${s.name}: ${e.message}`, 'err'))));
    this.history.reset(p);
    this.editor.path = [];
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
    this.arr.render();
    this.redrawCues();
  }

  restore(fn) {
    if (!fn(this.project)) return;
    this.editor.reresolvePath();
    this.editor.render();
    this.engine.rebuild();
    this.renderPanels();
    this.updateUndo();
    this.saveSoon();
  }

  registerSW() {
    if (!('serviceWorker' in navigator) || !(location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) return;
    navigator.serviceWorker.register('sw.js').catch((e) => console.warn('SW', e));
    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      this._install = e;
      $('#install').hidden = false;
    });
  }

  // ---------------------------------------------------------------- graph ops
  setParam(node, key, value) {
    node.params[key] = value;
    this.engine.setParam(node.params, key, value);
    if (['adsr', 'filter', 'stepseq', 'pianoroll', 'sampler', 'wavetable', 'granular'].includes(node.type)) this.editor.redrawWidgets(node.id);
    if (node.type.startsWith('gs_')) this.redrawCuesSoon();
    if ((node.type === 'output' || node.type === 'gs_out') && key === 'name') { this.renderOutputsList(); this.arr.render(); }
    if (node.type === 'group' && key === 'name') this.editor.renderCrumbs();
    if (node.type === 'pianoroll' && key === 'length' && this.roll.node === node) this.roll.open(node);
  }

  redrawCues() { for (const n of this.editor.G.nodes) if (n.type === 'gs_out') this.editor.redrawWidgets(n.id); }
  redrawCuesSoon() { clearTimeout(this._rc); this._rc = setTimeout(() => this.redrawCues(), 120); }

  connect(from, to, silent = false) {
    const G = this.editor.G, parent = this.editor.parent;
    const fromNode = G.nodes.find((n) => n.id === from.node), toNode = G.nodes.find((n) => n.id === to.node);
    if (!fromNode || !toNode || from.node === to.node) return;
    let fs = outputsOf(fromNode, parent).find((s) => s.key === from.port);
    let ts = inputsOf(toNode, parent).find((s) => s.key === to.port);
    if (!fs || !ts) return;
    // dropping onto a group's "+" socket creates a new socket of the wire's type
    if (ts.type === 'any' && fs.type !== 'any' && parent) {
      const key = 'o' + parent.data.outputs.length + Math.random().toString(36).slice(2, 4);
      parent.data.outputs.push({ key, type: fs.type, label: fs.label });
      to = { node: to.node, port: key }; ts = { type: fs.type };
      this.editor.render();
    } else if (fs.type === 'any' && ts.type !== 'any' && parent) {
      const key = 'i' + parent.data.inputs.length + Math.random().toString(36).slice(2, 4);
      parent.data.inputs.push({ key, type: ts.type, label: ts.label });
      from = { node: from.node, port: key }; fs = { type: ts.type };
      this.editor.render();
    }
    if (fs.type !== ts.type) return;
    if (G.links.some((l) => l.from.node === from.node && l.from.port === from.port && l.to.node === to.node && l.to.port === to.port)) return;
    G.links.push({ id: proj.uid('l'), from: { ...from }, to: { ...to } });
    if (!silent) this.structureChanged();
  }

  node(id) { return this.editor.G.nodes.find((n) => n.id === id); }
  isActive(params) { return this.engine.isActive(params); }

  uniqueCueName(base) {
    const names = new Set(flatten(this.project).nodes.filter((n) => n.type === 'output' || n.type === 'gs_out').map((n) => n.params.name));
    if (!names.has(base)) return base;
    for (let i = 2; ; i++) if (!names.has(`${base}_${i}`)) return `${base}_${i}`;
  }

  // ---------------------------------------------------------------- transport
  async togglePlay() {
    if (this.engine.playing) this.engine.stop();
    else await this.engine.play(null);
    this.updateTransport();
  }
  async toggleSolo(fid) {
    if (this.engine.playing && this.engine.solo === fid) this.engine.stop();
    else await this.engine.play(fid, 0);
    this.updateTransport();
  }
  updateTransport() {
    $('#play').classList.toggle('on', this.engine.playing);
    $('#play').innerHTML = this.engine.playing ? ICON.stop : ICON.play;
    $('#app').classList.toggle('playing', this.engine.playing);
    $('#song-chip').classList.toggle('on', !!this.project.song.enabled);
    for (const n of this.editor.G.nodes) if (n.type === 'output') this.editor.redrawWidgets(n.id);
    this.renderOutputsList();
  }

  async previewNote(note) {
    const ctx = await this.engine.ensureCtx();
    const o = ctx.createOscillator(), g = ctx.createGain(), t = ctx.currentTime;
    o.type = 'triangle'; o.frequency.value = mtof(note);
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.25, t + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.35);
    o.connect(g).connect(this.engine.master); o.start(t); o.stop(t + 0.4);
  }

  /** Live notes recorded into the open Piano Roll while the transport runs. */
  recordNote(on, note, vel, id) {
    const n = this.roll.node;
    if (!this.recArm || !n || !this.engine.playing) return;
    const spb = 60 / this.project.bpm, clip = n.params.length;
    const beat = (this.engine.position() / spb) % clip;
    if (on) {
      const snap = this.roll.snap;
      this.pendingRec.set(id, { s: snap ? Math.round(beat / snap) * snap % clip : beat, n: note, v: Math.round(vel * 100) / 100, t: beat });
    } else {
      const p = this.pendingRec.get(id);
      if (!p) return;
      this.pendingRec.delete(id);
      let l = beat - p.t; if (l <= 0) l += clip;
      const snap = this.roll.snap || 0.0625;
      n.data.notes.push({ s: p.s, l: Math.max(snap, Math.round(l / snap) * snap), n: p.n, v: p.v });
      this.roll.draw(); this.editor.redrawWidgets(n.id); this.commitSoon();
    }
  }

  loop() {
    const frame = () => {
      this.editor.animate();
      this.roll.animate();
      this.arr.animate();
      this.drawTransport();
      this.drawMeter();
      if (this.recorder.active) $('#rec-time').textContent = this.recorder.elapsed().toFixed(1) + 's';
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  }

  drawTransport() {
    const p = this.project, e = this.engine;
    const pos = e.position();
    const spb = 60 / p.bpm, beat = pos / spb;
    const txt = `${Math.floor(beat / 4) + 1}.${Math.floor(beat % 4) + 1}.${Math.floor((beat % 1) * 4) + 1}`;
    if (this._tp !== txt) { this._tp = txt; $('#pos-bbt').textContent = txt; }
    const secs = pos.toFixed(2) + 's';
    if (this._ts !== secs) { this._ts = secs; $('#pos-sec').textContent = secs; }
    $('#pos-bar').style.transform = `scaleX(${Math.min(1, pos / e.L)})`;
  }

  drawMeter() {
    const cv = $('#meter'), g = cv.getContext('2d');
    const W = cv.width, H = cv.height;
    g.clearRect(0, 0, W, H);
    const a = this.engine.analyser;
    if (!a || !(this.engine.playing || this.engine.idle)) {
      g.strokeStyle = 'rgba(255,255,255,0.12)'; g.beginPath(); g.moveTo(0, H / 2); g.lineTo(W, H / 2); g.stroke(); return;
    }
    const buf = this._mb || (this._mb = new Float32Array(a.fftSize));
    a.getFloatTimeDomainData(buf);
    let pk = 0;
    g.beginPath();
    for (let x = 0; x < W; x++) { const v = buf[Math.floor((x / W) * buf.length)]; const y = H / 2 - v * (H / 2 - 2); x ? g.lineTo(x, y) : g.moveTo(x, y); }
    for (let i = 0; i < buf.length; i++) pk = Math.max(pk, Math.abs(buf[i]));
    const grad = g.createLinearGradient(0, 0, W, 0);
    grad.addColorStop(0, '#3fd8ff'); grad.addColorStop(0.5, '#a98bff'); grad.addColorStop(1, '#ff5f9e');
    g.strokeStyle = grad; g.lineWidth = 3; g.stroke();
    this._pk = Math.max(pk, (this._pk || 0) * 0.94);
    const db = 20 * Math.log10(this._pk || 1e-9);
    const el = $('#peak');
    el.textContent = db < -59 ? '-∞' : db.toFixed(1);
    el.classList.toggle('clip', this._pk >= 0.999);
  }

  // ---------------------------------------------------------------- samples
  async importSample(file) {
    try {
      let bytes = await file.arrayBuffer();
      let name = file.name, mime = file.type || 'audio/wav';
      const isVideo = /^video\//.test(file.type) || /\.(mp4|mov|mkv|avi|m4v)$/i.test(file.name);
      const id = proj.uid('s');
      const buf = await this.engine.decode(id, bytes);
      if (isVideo || bytes.byteLength > 25 * 1048576 && !/^audio\/(mpeg|ogg|webm|mp4|aac|flac)/.test(mime)) {
        // keep only the audio: re-encode as 16-bit WAV (video bytes would bloat the project)
        const chs = Array.from({ length: Math.min(2, buf.numberOfChannels) }, (_, c) => buf.getChannelData(c));
        bytes = await encodeWav(chs, buf.sampleRate, 16).arrayBuffer();
        name = name.replace(/\.[a-z0-9]+$/i, '') + '.wav'; mime = 'audio/wav';
      }
      const s = { id, name, mime, data: proj.bytesToB64(bytes) };
      this.project.samples.push(s);
      this.renderSamples();
      this.editor.refreshSampleSelects();
      this.sed.refreshList();
      this.saveSoon();
      const mb = MB(s.data.length);
      this.toast(`Imported ${name} — ${buf.duration.toFixed(1)}s, ${mb.toFixed(1)} MB in project${mb > 8 ? ' · trim it in the Sample editor to keep projects small' : ''}`);
      return s;
    } catch (e) {
      this.toast(`Could not import ${file.name}: ${e.message || e}`, 'err');
      return null;
    }
  }

  removeSample(id) {
    this.project.samples = this.project.samples.filter((s) => s.id !== id);
    this.engine.buffers.delete(id);
    const clear = (G) => G.nodes.forEach((n) => { if (n.params.sample === id) n.params.sample = ''; if (n.type === 'group') clear(n.data); });
    clear(this.project);
    this.sampleChanged(null);
    this.commit();
  }

  sampleChanged() {
    this.renderSamples();
    this.editor.refreshSampleSelects();
    this.sed.refreshList();
    this.arr.draw();
    this.engine.rebuild();
    this.saveSoon();
  }

  openSampleEditor(id) { this.showDock('sample'); this.sed.open(id); }

  // ---------------------------------------------------------------- files
  download(blob, name) { proj.download(blob, name); }

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
      if (/\.json$/i.test(f.name)) {
        const text = await f.text();
        try { const j = JSON.parse(text); if (j.format === 'nodeaudio-presets') { await this.importPresets(j); continue; } } catch {}
        await this.openFile(f); return;
      }
      if (/^(audio|video)\//.test(f.type) || /\.(wav|mp3|ogg|flac|m4a|aiff?|webm|opus|mp4|mov)$/i.test(f.name)) {
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

  async share() {
    if (!window.CompressionStream) return this.toast('This browser cannot make share links', 'err');
    const { url, dropped } = await encodeProject(this.project);
    try { await navigator.clipboard.writeText(url); } catch { prompt('Copy this link', url); }
    this.toast(`Link copied (${(url.length / 1024).toFixed(1)} KB)${dropped ? ` — ${dropped} sample(s) not included; save the JSON to share those` : ''}`);
  }

  // ---------------------------------------------------------------- export
  /** Every Output (including inside groups) with its flattened id. */
  outputs(type = 'output') {
    return flatten(this.project).nodes.filter((n) => n.type === type).map((n) => ({ fid: n.id, node: n.src, params: n.params }));
  }

  describeFormat() {
    const x = this.project.export;
    return `${x.sampleRate} Hz · ${x.channels === 1 ? 'mono' : 'stereo'} · ${x.bitDepth === 32 ? '32f' : x.bitDepth + '-bit'} · ${x.normalize ? (x.normMode === 'lufs' ? x.lufs + ' LUFS' : 'peak ' + x.peakDb + ' dB') : 'no normalize'}`;
  }

  async renderAllVariants(fid) {
    const o = this.outputs().find((x) => x.fid === fid);
    const n = Math.max(1, o.params.variants | 0), out = [];
    for (let v = 0; v < n; v++) out.push(await this.engine.renderWav(fid, this.project.export, v));
    this.lastRender.set(o.params, out[0]);
    return out;
  }

  downloadRender(r) { proj.download(r.blob || encodeWav(r.channels, r.sampleRate, this.project.export.bitDepth, r.loop), proj.safeName(r.name) + '.wav'); }

  async exportOne(fid) {
    const o = this.outputs().find((x) => x.fid === fid);
    if (!o) return;
    this.busy(true, `Rendering ${o.params.name}…`);
    try {
      const rs = await this.renderAllVariants(fid);
      if (rs.length === 1) proj.download(rs[0].blob, proj.safeName(rs[0].name) + '.wav');
      else proj.download(await makeZip(rs.map((r) => ({ name: proj.safeName(r.name) + '.wav', blob: r.blob }))), proj.safeName(o.params.name) + '_variants.zip');
      this.toast(`${proj.safeName(o.params.name)}${rs.length > 1 ? ` ×${rs.length}` : ''} — ${this.describeFormat()} · ${rs[0].seconds.toFixed(2)}s${rs[0].loop ? ' · loop' : ''}`);
    } catch (e) { console.error(e); this.toast('Export failed: ' + e.message, 'err'); }
    this.busy(false);
    this.afterRender();
  }

  /** Render every unmuted cue. Returns [{name, blob}] plus manifest + GDScript. */
  async renderBank() {
    const outs = this.outputs().filter((o) => !o.params.mute);
    const files = [], cues = [], used = new Set();
    for (const [i, o] of outs.entries()) {
      this.busy(true, `Rendering ${i + 1}/${outs.length}: ${o.params.name}…`);
      const rs = await this.renderAllVariants(o.fid);
      const cue = { name: proj.safeName(o.params.name), bus: o.params.bus, loop: !!o.params.loop, files: [], seconds: +rs[0].seconds.toFixed(4), peakDb: +(20 * Math.log10(rs[0].peak || 1e-9)).toFixed(2), lufs: isFinite(rs[0].lufs) ? +rs[0].lufs.toFixed(2) : null };
      for (const r of rs) {
        let name = proj.safeName(r.name);
        while (used.has(name)) name += '_';
        used.add(name);
        files.push({ name: name + '.wav', blob: r.blob });
        cue.files.push(name + '.wav');
      }
      cues.push(cue);
    }
    const x = this.project.export;
    const manifest = { generator: 'NodeAudio', project: this.project.name, sampleRate: x.sampleRate, channels: x.channels, bitDepth: x.bitDepth, normalize: x.normalize ? (x.normMode === 'lufs' ? { lufs: x.lufs, ceilingDb: x.peakDb } : { peakDb: x.peakDb }) : null, cues };
    files.push({ name: 'nodeaudio_cues.json', blob: new Blob([JSON.stringify(manifest, null, 2)], { type: 'application/json' }) });
    const gs = this.outputs('gs_out');
    if (gs.length) {
      const { code, warnings } = codegenFile(flatten(this.project), gs.map((o) => o.fid), this.project.name);
      files.push({ name: 'nodeaudio_cues.gd', blob: new Blob([code], { type: 'text/plain' }) });
      if (warnings.length) this.toast('GDScript: ' + warnings.join('; '), 'err');
    }
    return { files, cues };
  }

  async exportAll() {
    const outs = this.outputs().filter((o) => !o.params.mute);
    if (!outs.length && !this.outputs('gs_out').length) { this.toast('No Output nodes to export', 'err'); return; }
    if (outs.length === 1 && !(outs[0].params.variants > 1) && !this.outputs('gs_out').length) return this.exportOne(outs[0].fid);
    try {
      const { files } = await this.renderBank();
      proj.download(await makeZip(files), proj.safeName(this.project.name) + '_cues.zip');
      this.toast(`Exported ${files.filter((f) => f.name.endsWith('.wav')).length} file(s) + manifest — ${this.describeFormat()}`);
    } catch (e) { console.error(e); this.toast('Export failed: ' + e.message, 'err'); }
    this.busy(false);
    this.afterRender();
  }

  /** Write the bank straight into a folder (e.g. space-rogue-repo/assets/audio/sfx). */
  async exportFolder() {
    if (!window.showDirectoryPicker) return this.toast('Export to folder needs Chrome or Edge — use Export (.zip) instead', 'err');
    let dir = await proj.idbGet('dir:' + this.project.name);
    try {
      if (dir && (await dir.requestPermission({ mode: 'readwrite' })) !== 'granted') dir = null;
      if (!dir) dir = await showDirectoryPicker({ id: 'nodeaudio-export', mode: 'readwrite' });
    } catch (e) { if (e.name !== 'AbortError') this.toast(e.message, 'err'); return; }
    try {
      const { files } = await this.renderBank();
      for (const f of files) { const h = await dir.getFileHandle(f.name, { create: true }); const w = await h.createWritable(); await w.write(f.blob); await w.close(); }
      await proj.idbSet('dir:' + this.project.name, dir);
      this.toast(`Wrote ${files.length} files to “${dir.name}” (overwrites in place next time)`);
    } catch (e) { console.error(e); this.toast('Export failed: ' + e.message, 'err'); }
    this.busy(false);
    this.afterRender();
  }

  async forgetFolder() { await proj.idbSet('dir:' + this.project.name, null); this.toast('Export folder forgotten — you will be asked next time'); }

  async viewRender(fid) {
    const o = this.outputs().find((x) => x.fid === fid);
    this.busy(true, `Rendering ${o.params.name}…`);
    try { const r = await this.engine.renderWav(fid, this.project.export, 0); this.lastRender.set(o.params, r); this.rview.open(r); }
    catch (e) { this.toast('Render failed: ' + e.message, 'err'); }
    this.busy(false);
    this.afterRender();
  }

  afterRender() { this.editor.redrawWidgets(); this.renderOutputsList(); }

  // ---------------------------------------------------------------- Game Synth
  gsNode(fid) { return flatten(this.project).nodes.find((n) => n.id === fid); }
  bakeCue(fid) {
    const g = flatten(this.project), n = g.nodes.find((x) => x.id === fid);
    if (!n) return null;
    return this.engine.gsBufferFor(g, fid, n.params).getChannelData(0);
  }
  async auditionCue(fid) {
    const n = this.gsNode(fid), data = this.bakeCue(fid);
    if (!data) return;
    const ctx = await this.engine.ensureCtx();
    const b = ctx.createBuffer(1, data.length, 22050); b.copyToChannel(data, 0);
    const s = ctx.createBufferSource(); s.buffer = b; s.loop = !!n.params.loop; s.connect(this.engine.master); s.start();
    if (s.loop) setTimeout(() => s.stop(), Math.max(2500, (data.length / 22050) * 3000));
  }
  showCueCode(fid) {
    const { code, warnings } = codegen(flatten(this.project), fid, this.project.name);
    const m = $('#codeview');
    $('.cv-code', m).textContent = code;
    $('.cv-warn', m).textContent = warnings.join(' · ');
    $('.cv-title', m).textContent = funcName(this.gsNode(fid).params.name) + '()';
    m.classList.add('open');
  }
  exportGd() {
    const gs = this.outputs('gs_out');
    if (!gs.length) return this.toast('Add a Synth Cue node (Game Synth) first', 'err');
    const { code, warnings } = codegenFile(flatten(this.project), gs.map((o) => o.fid), this.project.name);
    proj.download(new Blob([code], { type: 'text/plain' }), 'nodeaudio_cues.gd');
    this.toast(`Exported ${gs.length} bake function(s) to nodeaudio_cues.gd${warnings.length ? ' — ' + warnings.join('; ') : ''}`);
  }

  // ---------------------------------------------------------------- presets
  renderPresets() {
    const box = $('#presets');
    const groups = {};
    for (const p of FACTORY) (groups[p.cat] ||= []).push({ ...p, factory: true });
    if (this.userPresets.length) groups['Mine'] = this.userPresets.map((p, i) => ({ ...p, idx: i }));
    box.innerHTML = Object.entries(groups).map(([cat, list]) => `<div class="pal-cat" style="--cat:#5ef2d0">${esc(cat)}</div>` +
      list.map((p) => `<div class="pal-item preset" draggable="true" data-f="${p.factory ? FACTORY.indexOf(FACTORY.find((x) => x.name === p.name)) : ''}" data-u="${p.idx ?? ''}" style="--cat:#5ef2d0"><span class="sw"></span><span class="nm">${esc(p.name)}</span>${p.factory ? '' : '<button class="x" title="Delete preset">✕</button>'}</div>`).join('')).join('');
    box.querySelectorAll('.preset').forEach((it) => {
      const get = () => (it.dataset.f !== '' ? FACTORY[+it.dataset.f].make() : this.userPresets[+it.dataset.u].clip);
      it.addEventListener('click', (e) => { if (e.target.closest('.x')) return; const r = $('#canvas').getBoundingClientRect(); this.editor.paste(get(), this.editor.toWorld(r.left + r.width / 2 - 200, r.top + r.height / 2 - 120)); });
      it.addEventListener('dragstart', (e) => e.dataTransfer.setData('application/x-nodeaudio-clip', get()));
      const x = it.querySelector('.x');
      if (x) x.addEventListener('click', async () => { this.userPresets.splice(+it.dataset.u, 1); await saveUserPresets(this.userPresets); this.renderPresets(); });
    });
  }
  async savePreset() {
    const clip = this.editor.copy();
    if (!clip) return this.toast('Select some nodes to save as a preset', 'err');
    const name = prompt('Preset name', 'My patch');
    if (!name) return;
    this.userPresets.push({ name, clip });
    await saveUserPresets(this.userPresets);
    this.renderPresets();
    this.toast(`Saved preset “${name}”`);
  }
  exportPresets() {
    if (!this.userPresets.length) return this.toast('No presets of your own yet', 'err');
    proj.download(new Blob([JSON.stringify({ format: 'nodeaudio-presets', presets: this.userPresets }, null, 1)], { type: 'application/json' }), 'nodeaudio_presets.json');
  }
  async importPresets(j) {
    this.userPresets.push(...(j.presets || []).filter((p) => p.name && p.clip));
    await saveUserPresets(this.userPresets);
    this.renderPresets();
    this.toast(`Imported ${(j.presets || []).length} preset(s)`);
  }

  // ---------------------------------------------------------------- dock
  showDock(tab) {
    const d = $('#dock');
    d.classList.add('open');
    d.dataset.tab = tab;
    d.querySelectorAll('.dock-tab').forEach((b) => b.classList.toggle('on', b.dataset.tab === tab));
    d.querySelectorAll('.dock-panel').forEach((p) => p.classList.toggle('on', p.dataset.tab === tab));
    requestAnimationFrame(() => { if (tab === 'song') this.arr.render(); if (tab === 'sample') this.sed.layout(); if (tab === 'roll') this.roll.layout(); });
  }
  hideDock() { $('#dock').classList.remove('open'); }
  toggleDock(tab) { const d = $('#dock'); if (d.classList.contains('open') && d.dataset.tab === tab) this.hideDock(); else this.showDock(tab); }

  updateLiveUI() {
    const k = $('#keys');
    k.classList.toggle('on', this.live.keys);
    k.title = this.live.keys ? `Computer keyboard plays notes (A–; = C${this.live.octave}…, Z/X octave, C/V velocity ${this.live.vel.toFixed(1)})` : 'Play notes with the computer keyboard';
    $('#keys-oct').textContent = this.live.keys ? 'C' + this.live.octave : '';
    $('#midi').classList.toggle('on', this.live.midiCount > 0);
  }
  updateRecUI() {
    const on = this.recorder.active;
    $('#rec-bar').hidden = !on;
    $('#rec-kind').textContent = this.recorder.kind === 'tab' ? 'Capturing tab audio' : 'Recording microphone';
  }

  // ---------------------------------------------------------------- UI
  bindUI() {
    const on = (sel, ev, fn) => $(sel).addEventListener(ev, fn);
    on('#play', 'click', () => this.togglePlay());
    on('#rewind', 'click', () => this.engine.rewind());
    on('#loop', 'click', () => { this.engine.loop = !this.engine.loop; $('#loop').classList.toggle('on', this.engine.loop); });
    on('#song-chip', 'click', () => { this.project.song.enabled = !this.project.song.enabled; this.arr.render(); this.engine.rebuild(); this.commit(); this.updateTransport(); if (this.project.song.enabled) this.showDock('song'); });
    on('#monitor', 'change', (e) => { this.engine.setMonitor(e.target.value); this.toast(e.target.value === 'game' ? 'Monitoring through approximations of the game buses (SFX room, SFXFar echo…). Exports stay dry.' : 'Monitoring dry'); });
    on('#keys', 'click', () => this.live.setKeys(!this.live.keys));
    on('#midi', 'click', () => this.live.enableMidi());
    on('#undo', 'click', () => this.restore((p) => this.history.undo(p)));
    on('#redo', 'click', () => this.restore((p) => this.history.redo(p)));
    on('#save', 'click', () => this.save());
    on('#open', 'click', () => $('#file-open').click());
    on('#share', 'click', () => this.share());
    on('#install', 'click', async () => { if (this._install) { this._install.prompt(); this._install = null; $('#install').hidden = true; } });
    on('#file-open', 'change', (e) => { const f = e.target.files[0]; if (f) this.handleFiles([f]); e.target.value = ''; });
    on('#import', 'click', () => $('#file-sample').click());
    on('#file-sample', 'change', async (e) => { for (const f of e.target.files) await this.importSample(f); e.target.value = ''; });
    on('#rec-mic', 'click', () => this.recorder.start('mic'));
    on('#rec-tab', 'click', () => this.recorder.start('tab'));
    on('#rec-stop', 'click', () => this.recorder.stop());
    on('#export-all', 'click', () => this.exportAll());
    on('#export-folder', 'click', () => this.exportFolder());
    on('#export-gd', 'click', () => this.exportGd());
    on('#frame', 'click', () => this.editor.frameAll());
    on('#preset-save', 'click', () => this.savePreset());
    on('#preset-export', 'click', () => this.exportPresets());
    on('#preset-import', 'click', () => $('#file-open').click());
    document.querySelectorAll('.dock-tab').forEach((b) => b.addEventListener('click', () => this.toggleDock(b.dataset.tab)));
    on('#dock-close', 'click', () => this.hideDock());
    on('#pr-rec', 'click', () => { this.recArm = !this.recArm; $('#pr-rec').classList.toggle('on', this.recArm); if (this.recArm) this.toast('Recording armed: play notes (⌨ or MIDI) while the transport runs'); });
    $('#codeview').addEventListener('click', async (e) => {
      if (e.target.id === 'codeview' || e.target.closest('.cv-x')) $('#codeview').classList.remove('open');
      if (e.target.closest('.cv-copy')) { await navigator.clipboard.writeText($('#codeview .cv-code').textContent); this.toast('GDScript copied'); }
    });

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

    on('#p-name', 'input', (e) => { this.project.name = e.target.value; this.editor.renderCrumbs(); });
    on('#p-name', 'change', () => this.commit());
    const num = (sel, key, min, max) => on(sel, 'change', (e) => {
      const v = Math.max(min, Math.min(max, parseFloat(e.target.value) || this.project[key]));
      this.project[key] = v; e.target.value = v;
      this.engine.rebuild(); this.commit(); this.renderProject(); this.arr.render();
    });
    num('#p-bpm', 'bpm', 20, 400);
    num('#p-len', 'lengthBeats', 0.25, 512);

    const cv = $('#canvas');
    cv.addEventListener('dragover', (e) => { e.preventDefault(); cv.classList.add('drop'); });
    cv.addEventListener('dragleave', (e) => { if (e.target === cv) cv.classList.remove('drop'); });
    cv.addEventListener('drop', (e) => {
      e.preventDefault(); cv.classList.remove('drop');
      const at = this.editor.toWorld(e.clientX, e.clientY);
      const type = e.dataTransfer.getData('application/x-nodeaudio-type');
      const sid = e.dataTransfer.getData('application/x-nodeaudio-sample');
      const clip = e.dataTransfer.getData('application/x-nodeaudio-clip');
      if (type) return void this.editor.addNode(type, at);
      if (sid) return void this.addSampler(sid, at);
      if (clip) return void this.editor.paste(clip, at);
      if (e.dataTransfer.files.length) this.handleFiles([...e.dataTransfer.files], at);
    });
    document.addEventListener('dragover', (e) => e.preventDefault());
    document.addEventListener('drop', (e) => { e.preventDefault(); if (e.dataTransfer.files.length && !e.target.closest('#canvas')) this.handleFiles([...e.dataTransfer.files]); });

    const pal = $('#palette'), search = $('#palette-search');
    const renderPalette = () => {
      const q = search.value.trim().toLowerCase();
      pal.innerHTML = '';
      for (const [ck, c] of Object.entries(CATEGORIES)) {
        const items = Object.entries(TYPES).filter(([k, t]) => t.cat === ck && !t.internal && (!q || (t.title + ' ' + t.desc + ' ' + c.label).toLowerCase().includes(q)));
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
          it.addEventListener('click', () => { const r = cv.getBoundingClientRect(); this.editor.addNode(k, this.editor.toWorld(r.left + r.width / 2 - 110, r.top + r.height / 2 - 80)); });
          pal.appendChild(it);
        }
      }
    };
    search.addEventListener('input', renderPalette);
    search.addEventListener('keydown', (e) => e.stopPropagation());
    renderPalette();

    const ex = (sel, key, parse) => on(sel, 'change', (e) => {
      const el = e.target;
      this.project.export[key] = parse(el.type === 'checkbox' ? el.checked : el.value);
      this.commit(); this.renderExport();
    });
    ex('#x-rate', 'sampleRate', (v) => parseInt(v, 10));
    ex('#x-ch', 'channels', (v) => parseInt(v, 10));
    ex('#x-bits', 'bitDepth', (v) => parseInt(v, 10));
    ex('#x-norm', 'normalize', Boolean);
    ex('#x-normmode', 'normMode', String);
    ex('#x-lufs', 'lufs', (v) => Math.max(-40, Math.min(-3, parseFloat(v) || -16)));
    ex('#x-peak', 'peakDb', (v) => Math.min(0, parseFloat(v) || -1));
    ex('#x-trim', 'trim', Boolean);
    on('#preset-godot', 'click', () => { Object.assign(this.project.export, proj.GODOT_EXPORT); this.commit(); this.renderExport(); this.toast('Export preset: Godot SFX — 22050 Hz mono 16-bit (matches Synth.MIX_RATE)'); });
    on('#preset-music', 'click', () => { Object.assign(this.project.export, { sampleRate: 44100, channels: 2, bitDepth: 16, normalize: true, normMode: 'lufs', lufs: -14, peakDb: -1, trim: false }); this.commit(); this.renderExport(); this.toast('Export preset: Godot music — 44.1 kHz stereo 16-bit, −14 LUFS'); });

    on('#help-btn', 'click', () => $('#help').classList.toggle('open'));
    $('#help').addEventListener('click', (e) => { if (e.target.id === 'help' || e.target.closest('.close')) $('#help').classList.remove('open'); });
    window.addEventListener('beforeunload', () => { if (this.dirty) proj.idbSet('autosave', proj.serialize(this.project)); });
    window.addEventListener('resize', () => { if ($('#dock').classList.contains('open')) this.showDock($('#dock').dataset.tab); });
  }

  bindKeys() {
    window.addEventListener('keydown', (e) => {
      if (e.target.closest('input,select,textarea')) return;
      if ($('#codeview').classList.contains('open') || $('#renderview').classList.contains('open')) { if (e.key === 'Escape') { $('#codeview').classList.remove('open'); this.rview.close(); } return; }
      const mod = e.ctrlKey || e.metaKey, k = e.key.toLowerCase();
      if (k === ' ') { e.preventDefault(); this.togglePlay(); }
      else if (mod && k === 'z' && !e.shiftKey) { e.preventDefault(); this.restore((p) => this.history.undo(p)); }
      else if (mod && (k === 'y' || (k === 'z' && e.shiftKey))) { e.preventDefault(); this.restore((p) => this.history.redo(p)); }
      else if (mod && k === 's') { e.preventDefault(); this.save(e.shiftKey); }
      else if (mod && k === 'o') { e.preventDefault(); $('#file-open').click(); }
      else if (mod && k === 'e') { e.preventDefault(); this.exportAll(); }
      else if (mod && k === 'g' && e.shiftKey) { e.preventDefault(); const g = this.editor.G.nodes.find((n) => this.editor.sel.has(n.id) && n.type === 'group'); this.editor.ungroup(g); }
      else if (mod && k === 'g') { e.preventDefault(); this.editor.groupSelection(); }
      else if (mod && k === 'c') { this.clipboard = this.editor.copy(); }
      else if (mod && k === 'v') { const r = $('#canvas').getBoundingClientRect(); this.editor.paste(this.clipboard, this._mouse ? this.editor.toWorld(this._mouse.x, this._mouse.y) : this.editor.toWorld(r.left + 100, r.top + 100)); }
      else if (mod && k === 'd') { e.preventDefault(); this.editor.paste(this.editor.copy()); }
      else if (mod && k === 'a') { e.preventDefault(); this.editor.select(this.editor.G.nodes.map((n) => n.id)); }
      else if (k === 'delete' || k === 'backspace' || (k === 'x' && !this.live.keys)) { this.editor.deleteSelection(); }
      else if (k === 'tab') {
        e.preventDefault();
        const g = this.editor.G.nodes.find((n) => this.editor.sel.has(n.id) && n.type === 'group');
        if (g) this.editor.enter(g); else if (this.editor.path.length) this.editor.exit();
        else { const m = this._mouse || { x: innerWidth / 2, y: innerHeight / 2 }; this.openAddMenu(m.x, m.y); }
      }
      else if (k === 'a' && e.shiftKey) { e.preventDefault(); const m = this._mouse || { x: innerWidth / 2, y: innerHeight / 2 }; this.openAddMenu(m.x, m.y); }
      else if (k === 'home') { this.engine.rewind(); }
      else if (k === 'f') this.editor.frameAll();
      else if (k === 'escape') { this.closeAddMenu(); this.hideDock(); $('#help').classList.remove('open'); }
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
    m.style.left = Math.min(cx, innerWidth - 268) + 'px';
    m.style.top = Math.min(cy, innerHeight - 388) + 'px';
    const input = $('input', m), list = $('.am-list', m);
    input.value = '';
    let idx = 0, items = [];
    const ok = (k) => {
      if (TYPES[k].internal) return false;
      if (!from) return true;
      const probe = { type: k, data: { inputs: [], outputs: [] } };
      return from.reverse ? outputsOf(probe).some((s) => s.type === from.type) : inputsOf(probe).some((s) => s.type === from.type);
    };
    const render = () => {
      const q = input.value.trim().toLowerCase();
      items = Object.entries(TYPES).filter(([k, t]) => ok(k) && (!q || (t.title + ' ' + CATEGORIES[t.cat].label).toLowerCase().includes(q)));
      idx = Math.min(idx, Math.max(0, items.length - 1));
      list.innerHTML = items.map(([k, t], i) => `<div class="am-item${i === idx ? ' on' : ''}" data-k="${k}" style="--cat:${CATEGORIES[t.cat].color}"><span class="sw"></span><span class="t">${t.title}</span><span class="c">${CATEGORIES[t.cat].label}</span></div>`).join('') || '<div class="am-empty">No match</div>';
      $('.am-desc', m).textContent = items[idx] ? items[idx][1].desc : '';
      const on = list.querySelector('.on'); if (on) on.scrollIntoView({ block: 'nearest' });
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
    input.focus();
    setTimeout(() => input.focus(), 0);
    this._amClose = (e) => { if (!m.contains(e.target)) this.closeAddMenu(); };
    setTimeout(() => window.addEventListener('pointerdown', this._amClose), 0);
  }
  closeAddMenu() { $('#addmenu').classList.remove('open'); window.removeEventListener('pointerdown', this._amClose); }

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
    this.updateLiveUI();
    this.arr.render();
    this.sed.refreshList();
    $('#loop').classList.toggle('on', this.engine.loop);
  }

  renderProject() {
    const p = this.project;
    $('#p-name').value = p.name;
    $('#p-bpm').value = p.bpm;
    $('#p-len').value = p.lengthBeats;
    $('#p-secs').textContent = loopSeconds(p).toFixed(3) + ' s' + (p.song.enabled ? ` · song ${songSeconds(p).toFixed(1)} s` : '');
  }

  renderExport() {
    const x = this.project.export;
    $('#x-rate').value = x.sampleRate; $('#x-ch').value = x.channels; $('#x-bits').value = x.bitDepth;
    $('#x-norm').checked = x.normalize; $('#x-peak').value = x.peakDb; $('#x-trim').checked = x.trim;
    $('#x-normmode').value = x.normMode || 'peak'; $('#x-lufs').value = x.lufs ?? -16;
    $('#x-normmode').disabled = $('#x-peak').disabled = !x.normalize;
    $('#x-lufs').disabled = !x.normalize || x.normMode !== 'lufs';
    $('#x-peak-label').textContent = x.normMode === 'lufs' ? 'Ceiling (dBFS)' : 'Peak (dBFS)';
    $('#preset-godot').classList.toggle('on', x.sampleRate === 22050 && x.channels === 1 && x.bitDepth === 16);
    $('#preset-music').classList.toggle('on', x.sampleRate === 44100 && x.channels === 2 && x.bitDepth === 16);
    $('#fmt-line').textContent = this.describeFormat();
  }

  renderSamples() {
    const list = $('#samples');
    const total = this.project.samples.reduce((a, s) => a + MB(s.data.length), 0);
    $('#samples-size').textContent = this.project.samples.length ? `${total.toFixed(1)} MB` : '';
    if (!this.project.samples.length) {
      list.innerHTML = '<div class="empty">Drop audio or video files anywhere, Import, or record the mic / another tab. Samples are embedded in the project JSON.</div>';
      return;
    }
    list.innerHTML = '';
    for (const s of this.project.samples) {
      const it = document.createElement('div');
      it.className = 'smp'; it.draggable = true;
      it.innerHTML = `<canvas width="200" height="28"></canvas><div class="smp-row"><span class="nm" title="${esc(s.name)}">${esc(s.name)}</span><span class="dur"></span><button class="ed" title="Open in Sample editor">✎</button><button class="x" title="Remove from project">✕</button></div>`;
      const buf = this.engine.buffers.get(s.id);
      if (buf) {
        drawWave(it.querySelector('canvas').getContext('2d'), buf, 200, 28, '#3fd8ff');
        it.querySelector('.dur').textContent = buf.duration.toFixed(2) + 's · ' + MB(s.data.length).toFixed(1) + 'MB';
      }
      it.addEventListener('dragstart', (e) => e.dataTransfer.setData('application/x-nodeaudio-sample', s.id));
      it.querySelector('.x').addEventListener('click', () => { if (confirm(`Remove ${s.name} from the project? This cannot be undone.`)) this.removeSample(s.id); });
      it.querySelector('.ed').addEventListener('click', () => this.openSampleEditor(s.id));
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
    const outs = this.outputs(), gs = this.outputs('gs_out');
    list.innerHTML = '';
    if (!outs.length && !gs.length) list.innerHTML = '<div class="empty">Add an Output node — each one is a cue.</div>';
    for (const o of outs) {
      const P = o.params, r = this.lastRender.get(P), playing = this.engine.playing && this.engine.solo === o.fid;
      const it = document.createElement('div');
      it.className = 'cue' + (P.mute ? ' muted' : '') + (playing ? ' playing' : '');
      const len = (P.length || timelineSeconds(this.project)).toFixed(2) + ' s' + (P.loop ? '' : ` + ${P.tail}s tail`);
      it.innerHTML = `
        <div class="cue-top"><span class="nm">${esc(proj.safeName(P.name))}.wav</span>${P.loop ? '<span class="badge">loop</span>' : ''}${P.variants > 1 ? `<span class="badge v">×${P.variants}</span>` : ''}<span class="bus">${esc(P.bus || '')}</span></div>
        <div class="cue-meta">${r ? `${r.seconds.toFixed(2)} s · peak ${(20 * Math.log10(r.peak || 1e-9)).toFixed(1)} dB${isFinite(r.lufs) ? ` · ${r.lufs.toFixed(1)} LUFS` : ''}` : len}</div>
        <div class="cue-btns">
          <button class="btn sm solo">${playing ? ICON.stop : ICON.play} Live</button>
          <button class="btn sm view" title="Render and inspect: waveform, spectrogram, loudness">Inspect</button>
          <button class="btn sm accent exp">⤓ WAV</button>
        </div>`;
      it.querySelector('.solo').addEventListener('click', () => this.toggleSolo(o.fid));
      it.querySelector('.view').addEventListener('click', () => this.viewRender(o.fid));
      it.querySelector('.exp').addEventListener('click', () => this.exportOne(o.fid));
      it.querySelector('.nm').addEventListener('click', () => this.reveal(o.fid));
      list.appendChild(it);
    }
    for (const o of gs) {
      const it = document.createElement('div');
      it.className = 'cue gs';
      it.innerHTML = `<div class="cue-top"><span class="nm">${esc(funcName(o.params.name))}()</span><span class="badge gd">GDScript</span>${o.params.loop ? '<span class="badge">loop</span>' : ''}</div>
        <div class="cue-btns"><button class="btn sm play">${ICON.play} Audition</button><button class="btn sm code">View code</button></div>`;
      it.querySelector('.play').addEventListener('click', () => this.auditionCue(o.fid));
      it.querySelector('.code').addEventListener('click', () => this.showCueCode(o.fid));
      it.querySelector('.nm').addEventListener('click', () => this.reveal(o.fid));
      list.appendChild(it);
    }
    const n = outs.filter((o) => !o.params.mute).reduce((a, o) => a + Math.max(1, o.params.variants | 0), 0);
    $('#export-all').textContent = n > 1 || gs.length ? `Export all (${n} WAV${gs.length ? ' + .gd' : ''})` : 'Export WAV';
    $('#export-gd').hidden = !gs.length;
  }

  /** Select a node by flattened id, entering groups as needed. */
  reveal(fid) {
    const parts = fid.split('/');
    this.editor.path = [];
    let G = this.project;
    for (const gid of parts.slice(0, -1)) { const g = G.nodes.find((n) => n.id === gid); if (!g) break; this.editor.path.push(g); G = g.data; }
    this.editor.render();
    const n = G.nodes.find((x) => x.id === parts[parts.length - 1]);
    if (n) { this.editor.select([n.id]); this.focusNode(n); }
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
      box.innerHTML = ids.length
        ? `<div class="empty">${ids.length} nodes selected</div><div class="ins-btns"><button class="btn sm" data-a="group">Group (Ctrl G)</button><button class="btn sm" data-a="preset">Save as preset</button></div>`
        : '<div class="empty">Select a node to see what it does.</div>';
    } else {
      const n = this.node(ids[0]);
      if (!n) return;
      const T = TYPES[n.type], c = CATEGORIES[T.cat];
      const extra = n.type === 'group' ? '<button class="btn sm" data-a="enter">Enter (Tab)</button><button class="btn sm" data-a="ungroup">Ungroup</button>' : '';
      const track = !this.editor.path.length && ['trigger', 'stepseq', 'pianoroll', 'sampler', 'osc', 'wavetable', 'gs_out', 'granular'].includes(n.type) && !this.project.song.tracks.some((t) => t.node === n.id) ? '<button class="btn sm" data-a="track">Add to arrangement</button>' : '';
      const sedit = n.params.sample ? '<button class="btn sm" data-a="sample">Edit sample</button>' : '';
      box.innerHTML = `<div class="ins-title" style="--cat:${c.color}"><span class="sw"></span>${T.title}<span class="c">${c.label}</span></div><p>${T.desc || ''}</p><div class="ins-btns">${extra}${track}${sedit}<button class="btn sm" data-a="preset">Save as preset</button></div>`;
      box.querySelectorAll('[data-a]').forEach((b) => b.addEventListener('click', () => {
        const a = b.dataset.a;
        if (a === 'enter') this.editor.enter(n);
        if (a === 'ungroup') this.editor.ungroup(n);
        if (a === 'track') { this.arr.addTrack(n.id); this.showDock('song'); }
        if (a === 'sample') this.openSampleEditor(n.params.sample);
      }));
    }
    box.querySelectorAll('[data-a="group"]').forEach((b) => b.addEventListener('click', () => this.editor.groupSelection()));
    box.querySelectorAll('[data-a="preset"]').forEach((b) => b.addEventListener('click', () => this.savePreset()));
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
    setTimeout(() => { t.classList.remove('in'); setTimeout(() => t.remove(), 300); }, kind === 'err' ? 6500 : 3600);
  }
  busy(on, msg = '') { $('#busy').classList.toggle('on', on); $('#busy-msg').textContent = msg; }
}

const ICON = {
  play: '<svg viewBox="0 0 16 16" width="14" height="14"><path d="M4 2.5v11l9-5.5z" fill="currentColor"/></svg>',
  stop: '<svg viewBox="0 0 16 16" width="14" height="14"><rect x="3.5" y="3.5" width="9" height="9" rx="1.5" fill="currentColor"/></svg>',
};

const app = new App();
window.nodeaudio = app; // handy from the console
app.boot();
