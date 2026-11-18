// Rendered-cue inspector: waveform, spectrogram and loudness stats of an export.

import { spectrogram, heat } from './dsp.js';

const db = (x) => (x > 0 ? 20 * Math.log10(x) : -Infinity);
const fmtDb = (x) => (isFinite(x) ? x.toFixed(1) : '-∞');

export class RenderView {
  constructor(app) {
    this.app = app;
    const el = document.createElement('div');
    el.id = 'renderview';
    el.innerHTML = `
      <div class="rv-card">
        <div class="rv-head"><b class="rv-name"></b><span class="rv-fmt"></span><span class="grow"></span>
          <button class="btn sm rv-play">▶ Play</button><button class="btn sm accent rv-dl">⤓ Save</button><button class="btn icon ghost rv-x">✕</button></div>
        <div class="rv-stats"></div>
        <div class="rv-label">Waveform</div>
        <canvas class="rv-wave"></canvas>
        <div class="rv-label">Spectrogram <span>(log frequency)</span></div>
        <canvas class="rv-spec"></canvas>
      </div>`;
    document.body.appendChild(el);
    this.el = el;
    el.addEventListener('click', (e) => { if (e.target === el || e.target.closest('.rv-x')) this.close(); });
    el.querySelector('.rv-play').addEventListener('click', () => this.play());
    el.querySelector('.rv-dl').addEventListener('click', () => this.r && this.app.downloadRender(this.r));
  }

  close() { this.el.classList.remove('open'); this.stopPlay(); }

  open(r) {
    this.r = r;
    this.el.classList.add('open');
    const x = this.app.project.export;
    this.el.querySelector('.rv-name').textContent = r.name + '.' + (r.ext || 'wav');
    this.el.querySelector('.rv-fmt').textContent = `${r.sampleRate} Hz · ${r.channels.length === 1 ? 'mono' : 'stereo'} · ${x.format === 'ogg' ? 'OGG q' + (x.oggQuality ?? 5) : x.bitDepth === 32 ? '32f' : x.bitDepth + '-bit'}${r.loop ? ' · loop' : ''}`;
    const rms = Math.sqrt(r.channels.reduce((s, c) => s + c.reduce((a, v) => a + v * v, 0), 0) / (r.channels.length * r.channels[0].length));
    const stats = [
      ['Length', r.seconds.toFixed(3) + ' s'], ['Peak', fmtDb(db(r.peak)) + ' dBFS'], ['RMS', fmtDb(db(rms)) + ' dBFS'],
      ['Loudness', isFinite(r.lufs) ? r.lufs.toFixed(1) + ' LUFS' : '—'], ['Crest', fmtDb(db(r.peak) - db(rms)) + ' dB'], ['Bus', r.bus || '—'],
    ];
    this.el.querySelector('.rv-stats').innerHTML = stats.map(([k, v]) => `<div><span>${k}</span><b>${v}</b></div>`).join('');
    requestAnimationFrame(() => { this.drawWave(); this.drawSpec(); });
  }

  size(cv, h) {
    const dpr = Math.min(2, devicePixelRatio || 1), w = cv.clientWidth || 800;
    cv.width = w * dpr; cv.height = h * dpr; cv.style.height = h + 'px';
    const g = cv.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0);
    return [g, w, h];
  }

  drawWave() {
    const r = this.r, [g, W, H] = this.size(this.el.querySelector('.rv-wave'), 150);
    g.fillStyle = '#070a10'; g.fillRect(0, 0, W, H);
    const C = r.channels.length, h = H / C;
    r.channels.forEach((d, c) => {
      const mid = h * c + h / 2, step = d.length / W;
      g.strokeStyle = 'rgba(255,255,255,.08)'; g.beginPath(); g.moveTo(0, mid); g.lineTo(W, mid); g.stroke();
      const grad = g.createLinearGradient(0, 0, W, 0); grad.addColorStop(0, '#3fd8ff'); grad.addColorStop(1, '#a98bff');
      g.fillStyle = grad;
      for (let x = 0; x < W; x++) {
        let lo = 1, hi = -1;
        for (let i = Math.floor(x * step), e = Math.min(d.length, Math.floor((x + 1) * step) + 1); i < e; i++) { if (d[i] < lo) lo = d[i]; if (d[i] > hi) hi = d[i]; }
        g.fillRect(x, mid - hi * (h / 2 - 3), 1, Math.max(1, (hi - lo) * (h / 2 - 3)));
      }
    });
    if (r.loop) { g.fillStyle = '#4dffa6'; g.fillRect(0, 0, 2, H); g.fillRect(W - 2, 0, 2, H); g.font = '10px Inter'; g.fillText('loop', 6, 12); }
    g.fillStyle = 'rgba(255,255,255,.5)'; g.font = '10px "JetBrains Mono"';
    for (let s = 0; s <= r.seconds; s += niceStep(r.seconds)) { const x = (s / r.seconds) * W; g.fillRect(x, H - 4, 1, 4); g.fillText(s.toFixed(s < 1 ? 2 : 1) + 's', x + 2, H - 6); }
  }

  drawSpec() {
    const r = this.r, cv = this.el.querySelector('.rv-spec'), [g, W, H] = this.size(cv, 200);
    const mono = r.channels.length === 1 ? r.channels[0] : r.channels[0].map((v, i) => (v + r.channels[1][i]) / 2);
    const { cols, bins } = spectrogram(mono, { size: 1024, maxCols: Math.floor(W) });
    const img = g.createImageData(cols.length, H);
    const nyq = r.sampleRate / 2, lo = Math.log(30), hi = Math.log(nyq);
    for (let x = 0; x < cols.length; x++) {
      for (let y = 0; y < H; y++) {
        const hz = Math.exp(lo + (1 - y / H) * (hi - lo));
        const v = cols[x][Math.min(bins - 1, Math.round((hz / nyq) * bins))];
        const [R, G, B] = heat((v + 90) / 80);
        const o = (y * cols.length + x) * 4;
        img.data[o] = R; img.data[o + 1] = G; img.data[o + 2] = B; img.data[o + 3] = 255;
      }
    }
    const tmp = document.createElement('canvas'); tmp.width = cols.length; tmp.height = H;
    tmp.getContext('2d').putImageData(img, 0, 0);
    g.imageSmoothingEnabled = true;
    g.drawImage(tmp, 0, 0, W, H);
    g.fillStyle = 'rgba(255,255,255,.6)'; g.font = '10px "JetBrains Mono"';
    for (const hz of [100, 1000, 5000, 10000]) {
      if (hz >= nyq) continue;
      const y = (1 - (Math.log(hz) - lo) / (hi - lo)) * H;
      g.fillRect(0, y, 5, 1); g.fillText(hz >= 1000 ? hz / 1000 + 'k' : hz, 8, y + 3);
    }
  }

  async play() {
    this.stopPlay();
    const ctx = await this.app.engine.ensureCtx(), r = this.r;
    const b = ctx.createBuffer(r.channels.length, r.channels[0].length, r.sampleRate);
    r.channels.forEach((c, i) => b.copyToChannel(c, i));
    const s = ctx.createBufferSource(); s.buffer = b; s.loop = !!r.loop;
    s.connect(this.app.engine.master); s.start();
    this.src = s;
    if (r.loop) this._t = setTimeout(() => this.stopPlay(), Math.max(3000, r.seconds * 3000));
  }
  stopPlay() { clearTimeout(this._t); if (this.src) try { this.src.stop(); } catch {} this.src = null; }
}

function niceStep(total) {
  for (const s of [0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 30, 60]) if (total / s <= 10) return s;
  return 120;
}
