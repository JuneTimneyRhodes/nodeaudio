// Visualizer dock panel: the master output (or any Scope node) through the visualiser
// modes, with fullscreen for showing a track off. In fullscreen, 1–7 switch modes and
// the controls fade away until the mouse moves.

import { Viz, MODES } from './visualizer.js';
import { flatten } from './engine.js';

export class VizPanel {
  constructor(app, el) {
    this.app = app;
    this.el = el;
    this.src = null; // Scope node params, or null for the master output
    el.innerHTML = `
      <div class="pr-bar vz-bar">
        <div class="vz-modes">${MODES.map(([k, l], i) => `<button class="chip sm" data-m="${k}" title="${l} (${i + 1} in fullscreen)">${l}</button>`).join('')}</div>
        <span class="grow"></span>
        <label class="pr-ctl">Source <select class="vz-src"></select></label>
        <button class="btn sm vz-fs" title="Fullscreen (Esc to leave)">⛶ Fullscreen</button>
      </div>
      <div class="vz-wrap"><canvas class="vz-canvas"></canvas><div class="vz-hint">Press Play — the master output drives this.</div></div>`;
    this.cv = el.querySelector('.vz-canvas');
    this.viz = new Viz(this.cv);
    let saved = null;
    try { saved = localStorage.getItem('nodeaudio.vizMode'); } catch {}
    this.setMode(MODES.some(([k]) => k === saved) ? saved : 'nebula');
    el.querySelectorAll('[data-m]').forEach((b) => b.addEventListener('click', () => this.setMode(b.dataset.m)));
    el.querySelector('.vz-src').addEventListener('change', (e) => { this.src = this.scopes[+e.target.value] || null; });
    el.querySelector('.vz-fs').addEventListener('click', () => this.toggleFullscreen());
    new ResizeObserver(() => this.viz.fit(this.cv.clientWidth, this.cv.clientHeight)).observe(el.querySelector('.vz-wrap'));
    document.addEventListener('fullscreenchange', () => this.setFs(document.fullscreenElement === el));
    el.addEventListener('pointermove', () => this.poke());
    window.addEventListener('keydown', (e) => {
      if (!this.fs || e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === 'Escape' && this.max) { this.setFs(false); e.preventDefault(); e.stopPropagation(); return; }
      const i = parseInt(e.key, 10);
      if (i >= 1 && i <= MODES.length) { this.setMode(MODES[i - 1][0]); e.preventDefault(); e.stopPropagation(); }
    }, true);
  }

  get fs() { return this.el.classList.contains('fs'); }

  /** fs: real fullscreen, or (when the browser refuses it) filling the window. */
  setFs(on, max = false) {
    this.max = on && max;
    this.el.classList.toggle('fs', on);
    this.el.classList.toggle('max', this.max);
    this.el.querySelector('.vz-fs').textContent = on ? '✕ Exit fullscreen' : '⛶ Fullscreen';
    this.poke();
  }

  get visible() {
    if (this.fs) return true;
    const dock = document.getElementById('dock');
    return dock.classList.contains('open') && dock.dataset.tab === 'viz';
  }

  setMode(m) {
    this.viz.setMode(m);
    this.el.querySelectorAll('[data-m]').forEach((b) => b.classList.toggle('on', b.dataset.m === m));
    try { localStorage.setItem('nodeaudio.vizMode', m); } catch {}
  }

  refreshSources() {
    this.scopes = flatten(this.app.project).nodes.filter((n) => n.type === 'scope').map((n) => n.params);
    const sel = this.el.querySelector('.vz-src');
    sel.innerHTML = '<option value="-1">Master output</option>' + this.scopes.map((_, i) => `<option value="${i}">Scope ${i + 1}</option>`).join('');
    const i = this.scopes.indexOf(this.src);
    if (i < 0) this.src = null;
    sel.value = String(i);
  }

  open(params = null) {
    this.src = params;
    this.refreshSources();
    this.app.showDock('viz');
  }

  toggleFullscreen() {
    if (document.fullscreenElement === this.el) return void document.exitFullscreen();
    if (this.max) return this.setFs(false);
    // embedded browsers and some iframes refuse the Fullscreen API: fill the window instead
    const fallback = () => this.setFs(true, true);
    if (!this.el.requestFullscreen || document.fullscreenEnabled === false) return fallback();
    // some hosts claim support but leave the request pending forever: give it a moment
    let settled = false;
    this.el.requestFullscreen().then(() => (settled = true), () => { settled = true; fallback(); });
    setTimeout(() => { if (!settled && document.fullscreenElement !== this.el) fallback(); }, 700);
  }

  /** Show the controls; hide them again after a pause while fullscreen. */
  poke() {
    this.el.classList.remove('idle');
    clearTimeout(this._idle);
    if (this.el.classList.contains('fs')) this._idle = setTimeout(() => this.el.classList.add('idle'), 2200);
  }

  animate() {
    if (!this.visible) return;
    const source = this.app.engine.vizSource(this.src);
    this.el.querySelector('.vz-hint').hidden = !!source;
    this.viz.frame(source);
  }
}
