// Audio visualisers, shared by the Visualizer panel (master output) and Scope nodes.
//
// A Viz owns one canvas and draws one frame per call from a source of analysers:
//   { mono: AnalyserNode, L: AnalyserNode, R: AnalyserNode }  (any may be null)
// With no source (nothing playing yet) every mode decays to rest instead of freezing.

import { heat } from './dsp.js';

export const MODES = [
  ['bars', 'Spectrum'], ['waterfall', 'Waterfall'], ['wave', 'Scope'], ['vector', 'Stereo'],
  ['radial', 'Radial'], ['nebula', 'Nebula'], ['meters', 'Meters'],
];

const TAU = Math.PI * 2;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const db = (x) => (x > 1e-9 ? 20 * Math.log10(x) : -120);

export class Viz {
  constructor(canvas, { compact = false } = {}) {
    this.cv = canvas;
    this.g = canvas.getContext('2d');
    this.mode = 'bars';
    this.compact = compact;
    this.s = {};          // per-mode state
    this.t0 = performance.now();
  }

  setMode(m) { if (m !== this.mode) { this.mode = m; this.s = {}; } }

  /** Match the canvas to its CSS size (call when the container resizes). */
  fit(w, h) {
    const dpr = Math.min(2, devicePixelRatio || 1);
    w = Math.max(10, Math.round(w ?? this.cv.clientWidth)); h = Math.max(10, Math.round(h ?? this.cv.clientHeight));
    if (w === this.W && h === this.H) return;
    this.W = w; this.H = h;
    this.cv.width = w * dpr; this.cv.height = h * dpr;
    this.g.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.s = {};
  }

  /** Pull this frame's data from the analysers (or silence). */
  read(src) {
    const a = src && src.mono, L = src && src.L, R = src && src.R;
    const n = a ? a.frequencyBinCount : 1024;
    // time buffers follow the stereo analysers' size (they can be smaller than the mono FFT)
    const fft = L && R ? L.fftSize : a ? Math.min(a.fftSize, 4096) : 2048;
    const f = this._f && this._f.length === n ? this._f : (this._f = new Float32Array(n));
    const tl = this._tl && this._tl.length === fft ? this._tl : (this._tl = new Float32Array(fft));
    const tr = this._tr && this._tr.length === fft ? this._tr : (this._tr = new Float32Array(fft));
    if (a && !(L && R) && a.fftSize !== fft) { const full = new Float32Array(a.fftSize); a.getFloatTimeDomainData(full); tl.set(full.subarray(0, fft)); }
    if (a) a.getFloatFrequencyData(f); else f.fill(-120);
    if (L && R) { L.getFloatTimeDomainData(tl); R.getFloatTimeDomainData(tr); }
    else if (a) { if (a.fftSize === fft) a.getFloatTimeDomainData(tl); tr.set(tl); }
    else { tl.fill(0); tr.fill(0); }
    const rate = (a && a.context.sampleRate) || 44100;
    return { f, tl, tr, rate, nyq: rate / 2, n };
  }

  /** dB at a frequency, interpolated between FFT bins (smooth low end). */
  at(d, hz) {
    const x = Math.max(1, Math.min(d.n - 1.001, (hz / d.nyq) * d.n)), i = Math.floor(x), t = x - i;
    return d.f[i] * (1 - t) + d.f[i + 1] * t;
  }

  /** Average linear magnitude in [lo, hi) Hz, 0..~1. */
  band(d, lo, hi) {
    const i0 = Math.max(1, Math.floor((lo / d.nyq) * d.n)), i1 = Math.min(d.n, Math.max(i0 + 1, Math.ceil((hi / d.nyq) * d.n)));
    let s = 0;
    for (let i = i0; i < i1; i++) s += Math.pow(10, d.f[i] / 20);
    return s / (i1 - i0);
  }

  frame(src) {
    if (!this.W) this.fit();
    const d = this.read(src);
    const fn = this['draw_' + this.mode] || this.draw_bars;
    fn.call(this, d);
  }

  bg(alpha = 1) {
    const g = this.g;
    g.globalCompositeOperation = 'source-over';
    g.fillStyle = `rgba(6,9,15,${alpha})`;
    g.fillRect(0, 0, this.W, this.H);
  }

  // ------------------------------------------------------------ spectrum bars
  draw_bars(d) {
    const g = this.g, W = this.W, H = this.H, s = this.s;
    const N = clamp(Math.floor(W / (this.compact ? 7 : 13)), 16, 96);
    if (!s.v || s.v.length !== N) { s.v = new Float32Array(N); s.cap = new Float32Array(N); }
    this.bg();
    const lo = Math.log(25), hi = Math.log(Math.min(16000, d.nyq));
    const pad = this.compact ? 2 : 18, bw = (W - 4) / N, base = H - pad;
    const grad = g.createLinearGradient(0, base, 0, 4);
    grad.addColorStop(0, '#3fd8ff'); grad.addColorStop(0.55, '#a98bff'); grad.addColorStop(1, '#ff5f9e');
    for (let b = 0; b < N; b++) {
      const f0 = Math.exp(lo + ((hi - lo) * b) / N), f1 = Math.exp(lo + ((hi - lo) * (b + 1)) / N);
      const i0 = Math.max(1, Math.ceil((f0 / d.nyq) * d.n)), i1 = Math.floor((f1 / d.nyq) * d.n);
      // wide bars take the loudest bin they cover; narrow (low) bars interpolate
      let m = this.at(d, Math.sqrt(f0 * f1));
      for (let i = i0; i <= i1 && i < d.n; i++) m = Math.max(m, d.f[i]);
      const v = clamp((m + 90) / 80, 0, 1);
      s.v[b] = v > s.v[b] ? v : s.v[b] * 0.9 + v * 0.1;
      s.cap[b] = Math.max(s.v[b], s.cap[b] - 0.008);
      const h = s.v[b] * (base - 6), x = 2 + b * bw;
      g.fillStyle = grad;
      g.fillRect(x + 1, base - h, Math.max(1, bw - 2), h);
      g.fillStyle = 'rgba(255,255,255,.85)';
      g.fillRect(x + 1, base - s.cap[b] * (base - 6) - 2, Math.max(1, bw - 2), 2);
    }
    if (!this.compact) {
      g.fillStyle = 'rgba(255,255,255,.4)'; g.font = '10px "JetBrains Mono", monospace';
      for (const hz of [50, 100, 500, 1000, 5000, 10000]) {
        if (hz > d.nyq) continue;
        const x = 2 + ((Math.log(hz) - lo) / (hi - lo)) * (W - 4);
        g.fillRect(x, base + 2, 1, 4);
        g.fillText(hz >= 1000 ? hz / 1000 + 'k' : String(hz), x + 3, H - 4);
      }
    }
  }

  // ------------------------------------------------------------ scrolling spectrogram
  draw_waterfall(d) {
    const g = this.g, W = this.W, H = this.H, s = this.s;
    if (!s.off) {
      s.off = document.createElement('canvas'); s.off.width = W; s.off.height = H;
      s.og = s.off.getContext('2d'); s.og.fillStyle = '#06090f'; s.og.fillRect(0, 0, W, H);
      s.col = s.og.createImageData(1, H);
    }
    // scroll by elapsed time, not per frame, so the speed is the same at any frame rate
    const now = performance.now();
    s.acc = (s.acc || 0) + Math.min(0.25, (now - (s.last || now)) / 1000) * (this.compact ? 40 : 90);
    s.last = now;
    const step = Math.floor(s.acc);
    if (step < 1) { g.drawImage(s.off, 0, 0, W, H); return; }
    s.acc -= step;
    s.og.drawImage(s.off, -step, 0);
    const lo = Math.log(30), hi = Math.log(Math.min(16000, d.nyq)), px = s.col.data;
    for (let y = 0; y < H; y++) {
      const hz = Math.exp(lo + (1 - y / H) * (hi - lo));
      const [r, gg, b] = heat((this.at(d, hz) + 100) / 80);
      px[y * 4] = r; px[y * 4 + 1] = gg; px[y * 4 + 2] = b; px[y * 4 + 3] = 255;
    }
    for (let k = 0; k < step; k++) s.og.putImageData(s.col, W - 1 - k, 0);
    g.drawImage(s.off, 0, 0, W, H);
    if (!this.compact) {
      g.fillStyle = 'rgba(255,255,255,.5)'; g.font = '10px "JetBrains Mono", monospace';
      for (const hz of [100, 1000, 10000]) {
        if (hz > d.nyq) continue;
        const y = (1 - (Math.log(hz) - lo) / (hi - lo)) * H;
        g.fillRect(0, y, 5, 1); g.fillText(hz >= 1000 ? hz / 1000 + 'k' : String(hz), 8, y + 3);
      }
    }
  }

  // ------------------------------------------------------------ oscilloscope
  draw_wave(d) {
    const g = this.g, W = this.W, H = this.H;
    this.bg();
    g.strokeStyle = 'rgba(255,255,255,.06)';
    g.beginPath(); g.moveTo(0, H / 2); g.lineTo(W, H / 2); g.stroke();
    let z = 0;
    for (let i = 1; i < d.tl.length / 2; i++) if (d.tl[i - 1] < 0 && d.tl[i] >= 0) { z = i; break; }
    const span = Math.min(d.tl.length - z, 1024);
    const trace = (buf, color) => {
      g.beginPath();
      for (let x = 0; x < W; x++) { const v = buf[z + Math.floor((x / W) * span)] || 0; const y = H / 2 - v * (H / 2 - 4); x ? g.lineTo(x, y) : g.moveTo(x, y); }
      g.strokeStyle = color; g.lineWidth = this.compact ? 1.3 : 1.8; g.shadowColor = color; g.shadowBlur = 8; g.stroke(); g.shadowBlur = 0;
    };
    g.globalCompositeOperation = 'lighter';
    trace(d.tr, 'rgba(255,95,158,.75)');
    trace(d.tl, 'rgba(63,216,255,.9)');
    g.globalCompositeOperation = 'source-over';
  }

  // ------------------------------------------------------------ goniometer (stereo field)
  draw_vector(d) {
    const g = this.g, W = this.W, H = this.H;
    this.bg(0.22);
    const meterH = this.compact ? 0 : 22;
    const cx = W / 2, cy = (H - meterH) / 2, r = Math.min(W, H - meterH) * 0.46;
    g.strokeStyle = 'rgba(255,255,255,.07)';
    g.beginPath(); g.moveTo(cx - r, cy); g.lineTo(cx + r, cy); g.moveTo(cx, cy - r); g.lineTo(cx, cy + r);
    g.moveTo(cx - r * 0.7, cy - r * 0.7); g.lineTo(cx + r * 0.7, cy + r * 0.7); g.moveTo(cx + r * 0.7, cy - r * 0.7); g.lineTo(cx - r * 0.7, cy + r * 0.7); g.stroke();
    g.globalCompositeOperation = 'lighter';
    g.fillStyle = 'rgba(120,230,255,.55)';
    let sl = 0, sr = 0, slr = 0;
    for (let i = 0; i < d.tl.length; i += 2) {
      const l = d.tl[i], rr = d.tr[i];
      sl += l * l; sr += rr * rr; slr += l * rr;
      // mid up, side across: a mono signal is a vertical line
      g.fillRect(cx + (rr - l) * r * 0.71, cy - (l + rr) * r * 0.71, 1.4, 1.4);
    }
    g.globalCompositeOperation = 'source-over';
    if (!meterH) return;
    const corr = sl * sr > 1e-12 ? slr / Math.sqrt(sl * sr) : 1;
    this.s.corr = this.s.corr == null ? corr : this.s.corr * 0.85 + corr * 0.15;
    const y = H - 14, x0 = 40, x1 = W - 40, mid = (x0 + x1) / 2;
    g.fillStyle = 'rgba(255,255,255,.08)'; g.fillRect(x0, y, x1 - x0, 6);
    const cxp = mid + (this.s.corr * (x1 - x0)) / 2;
    g.fillStyle = this.s.corr < 0 ? '#ff5f9e' : '#4dffa6';
    g.fillRect(Math.min(mid, cxp), y, Math.abs(cxp - mid), 6);
    g.fillStyle = 'rgba(255,255,255,.5)'; g.font = '10px "JetBrains Mono", monospace';
    g.fillText('−1', x0 - 22, y + 7); g.fillText('+1', x1 + 6, y + 7);
    g.fillText('L', cx - r * 0.75 - 4, cy - r * 0.75); g.fillText('R', cx + r * 0.75, cy - r * 0.75);
  }

  // ------------------------------------------------------------ radial spectrum
  draw_radial(d) {
    const g = this.g, W = this.W, H = this.H, s = this.s;
    this.bg(0.35);
    const bass = this.band(d, 30, 150);
    s.bass = Math.max(bass, (s.bass || 0) * 0.9);
    const cx = W / 2, cy = H / 2, R0 = Math.min(W, H) * 0.2 * (1 + s.bass * 0.6);
    const N = this.compact ? 64 : 128, lo = Math.log(30), hi = Math.log(Math.min(14000, d.nyq));
    if (!s.v || s.v.length !== N) s.v = new Float32Array(N);
    const rot = (performance.now() - this.t0) / 9000;
    g.lineCap = 'round';
    g.globalCompositeOperation = 'lighter';
    for (let k = 0; k < N; k++) {
      const hz = Math.exp(lo + ((hi - lo) * k) / N);
      const v = clamp((this.at(d, hz) + 95) / 80, 0, 1);
      s.v[k] = v > s.v[k] ? v : s.v[k] * 0.88 + v * 0.12;
      const len = s.v[k] * Math.min(W, H) * 0.28;
      for (const side of [1, -1]) {
        const a = rot + side * (k / N) * Math.PI - Math.PI / 2;
        const ca = Math.cos(a), sa = Math.sin(a);
        g.strokeStyle = `hsla(${190 + (k / N) * 140},90%,${55 + s.v[k] * 20}%,${0.35 + s.v[k] * 0.65})`;
        g.lineWidth = this.compact ? 1.5 : 2.4;
        g.beginPath(); g.moveTo(cx + ca * R0, cy + sa * R0); g.lineTo(cx + ca * (R0 + len), cy + sa * (R0 + len)); g.stroke();
      }
    }
    // the waveform as a ring inside
    g.beginPath();
    const M = 180;
    for (let i = 0; i <= M; i++) {
      const a = (i / M) * TAU + rot, v = d.tl[Math.floor((i / M) * (d.tl.length / 2))] || 0, rr = R0 * (0.82 + v * 0.35);
      const x = cx + Math.cos(a) * rr, y = cy + Math.sin(a) * rr;
      i ? g.lineTo(x, y) : g.moveTo(x, y);
    }
    g.strokeStyle = 'rgba(255,255,255,.55)'; g.lineWidth = 1.2; g.stroke();
    g.globalCompositeOperation = 'source-over';
  }

  // ------------------------------------------------------------ nebula: audio-reactive starfield
  draw_nebula(d) {
    const g = this.g, W = this.W, H = this.H, s = this.s;
    const now = performance.now(), dt = Math.min(0.05, (now - (s.last || now)) / 1000); s.last = now;
    const env = (k, v, fall = 0.94) => (s[k] = Math.max(v, (s[k] || 0) * fall));
    const bass = env('b', this.band(d, 30, 160) * 2.2), mid = env('m', this.band(d, 160, 2000) * 3.5), high = env('h', this.band(d, 2000, 12000) * 7);
    const level = clamp(bass * 0.5 + mid * 0.35 + high * 0.15, 0, 1.5);
    const N = this.compact ? 120 : 420;
    if (!s.stars) s.stars = Array.from({ length: N }, () => ({ x: Math.random() * 2 - 1, y: Math.random() * 2 - 1, z: Math.random() }));
    // trails: fade the last frame rather than clearing it
    g.globalCompositeOperation = 'source-over';
    g.fillStyle = 'rgba(4,6,12,0.28)'; g.fillRect(0, 0, W, H);
    g.globalCompositeOperation = 'lighter';
    const cx = W / 2, cy = H / 2, R = Math.max(W, H);
    const t = (now - this.t0) / 1000;
    // nebula clouds: three slow blobs, each breathing with one band
    const clouds = [[bass, 265, 0.13, 0], [mid, 190, 0.09, 2.1], [high, 320, 0.17, 4.2]];
    for (const [e, hue, spd, ph] of clouds) {
      const a = t * spd + ph, x = cx + Math.cos(a) * W * 0.18, y = cy + Math.sin(a * 1.3) * H * 0.16;
      const rad = R * (0.18 + 0.22 * clamp(e, 0, 1.2));
      const gr = g.createRadialGradient(x, y, 0, x, y, rad);
      gr.addColorStop(0, `hsla(${hue},85%,60%,${0.05 + 0.18 * clamp(e, 0, 1)})`);
      gr.addColorStop(1, `hsla(${hue},85%,40%,0)`);
      g.fillStyle = gr; g.fillRect(x - rad, y - rad, rad * 2, rad * 2);
    }
    // core glow pulses with the low end
    const core = g.createRadialGradient(cx, cy, 0, cx, cy, R * (0.06 + 0.12 * clamp(bass, 0, 1.2)));
    core.addColorStop(0, `rgba(200,235,255,${0.12 + 0.4 * clamp(bass, 0, 1)})`); core.addColorStop(1, 'rgba(120,160,255,0)');
    g.fillStyle = core; g.fillRect(0, 0, W, H);
    // stars stream outward faster as the music gets louder
    const speed = 0.06 + level * 0.9;
    const hue = 190 + clamp(high - bass * 0.3, -0.5, 1) * 90;
    for (const st of s.stars) {
      const pz = st.z;
      st.z -= speed * dt;
      if (st.z <= 0.02) { st.x = Math.random() * 2 - 1; st.y = Math.random() * 2 - 1; st.z = 1; continue; }
      const k = 0.5 / st.z, k0 = 0.5 / pz;
      const x = cx + st.x * k * W * 0.5, y = cy + st.y * k * H * 0.5;
      if (x < -20 || x > W + 20 || y < -20 || y > H + 20) { st.z = 0; continue; }
      const x0 = cx + st.x * k0 * W * 0.5, y0 = cy + st.y * k0 * H * 0.5;
      const b = clamp(1 - st.z, 0, 1);
      g.strokeStyle = `hsla(${hue + st.x * 30},80%,${70 + b * 25}%,${0.15 + b * 0.85})`;
      g.lineWidth = 0.6 + b * (this.compact ? 1.2 : 2);
      g.beginPath(); g.moveTo(x0, y0); g.lineTo(x, y); g.stroke();
    }
    // sparkles on bright highs
    const sparks = Math.floor(clamp(high - 0.15, 0, 1) * (this.compact ? 3 : 10));
    for (let i = 0; i < sparks; i++) {
      const x = Math.random() * W, y = Math.random() * H, r = 1 + Math.random() * 2.5;
      g.fillStyle = 'rgba(255,255,255,.8)'; g.fillRect(x - r / 2, y - r / 2, r, r);
    }
    g.globalCompositeOperation = 'source-over';
  }

  // ------------------------------------------------------------ level meters
  draw_meters(d) {
    const g = this.g, W = this.W, H = this.H, s = this.s;
    this.bg();
    const stat = (buf) => { let pk = 0, ms = 0; for (const v of buf) { pk = Math.max(pk, Math.abs(v)); ms += v * v; } return [db(pk), db(Math.sqrt(ms / buf.length))]; };
    const [pl, rl] = stat(d.tl), [pr, rr] = stat(d.tr);
    const sm = (k, v, fall) => (s[k] = s[k] == null ? v : v > s[k] ? v : s[k] - fall);
    const PL = sm('pl', pl, 0.6), PR = sm('pr', pr, 0.6), RL = sm('rl', rl, 0.35), RR = sm('rr', rr, 0.35);
    s.hl = Math.max(PL, (s.hl ?? -120) - 0.08); s.hr = Math.max(PR, (s.hr ?? -120) - 0.08);
    const top = 14, bot = H - (this.compact ? 6 : 22), yOf = (v) => bot - clamp((v + 60) / 60, 0, 1) * (bot - top);
    const meterW = Math.min(46, W * 0.12), gap = 14, x0 = this.compact ? 10 : 46;
    const grad = g.createLinearGradient(0, bot, 0, top);
    grad.addColorStop(0, '#3fd8ff'); grad.addColorStop(0.7, '#4dffa6'); grad.addColorStop(0.88, '#ffb547'); grad.addColorStop(1, '#ff5f9e');
    [[PL, RL, s.hl, 'L'], [PR, RR, s.hr, 'R']].forEach(([pk, rms, hold, lab], i) => {
      const x = x0 + i * (meterW + gap);
      g.fillStyle = 'rgba(255,255,255,.05)'; g.fillRect(x, top, meterW, bot - top);
      g.globalAlpha = 0.35; g.fillStyle = grad; g.fillRect(x, yOf(pk), meterW, bot - yOf(pk));
      g.globalAlpha = 1; g.fillRect(x + meterW * 0.2, yOf(rms), meterW * 0.6, bot - yOf(rms));
      g.fillStyle = hold > -0.5 ? '#ff5f9e' : '#fff'; g.fillRect(x, yOf(hold) - 1, meterW, 2);
      if (!this.compact) { g.fillStyle = 'rgba(255,255,255,.6)'; g.font = '10px "JetBrains Mono", monospace'; g.fillText(lab, x + meterW / 2 - 3, H - 8); }
    });
    if (this.compact) return;
    g.fillStyle = 'rgba(255,255,255,.35)'; g.font = '10px "JetBrains Mono", monospace';
    for (const v of [0, -6, -12, -24, -36, -48, -60]) { const y = yOf(v); g.fillRect(x0 - 6, y, 4, 1); g.fillText(String(v), 6, y + 3); }
    // readouts
    const rx = x0 + 2 * (meterW + gap) + 20;
    let sl = 0, sr = 0, slr = 0;
    for (let i = 0; i < d.tl.length; i++) { sl += d.tl[i] ** 2; sr += d.tr[i] ** 2; slr += d.tl[i] * d.tr[i]; }
    const corr = sl * sr > 1e-12 ? slr / Math.sqrt(sl * sr) : 1;
    s.c = s.c == null ? corr : s.c * 0.9 + corr * 0.1;
    const rows = [['Peak L', s.hl], ['Peak R', s.hr], ['RMS L', RL], ['RMS R', RR]];
    g.font = '11px Inter, sans-serif';
    rows.forEach(([k, v], i) => {
      const y = top + 16 + i * 26;
      g.fillStyle = 'rgba(255,255,255,.45)'; g.fillText(k, rx, y);
      g.fillStyle = '#fff'; g.font = '600 13px "JetBrains Mono", monospace';
      g.fillText(v < -59 ? '-∞' : v.toFixed(1) + ' dB', rx + 70, y); g.font = '11px Inter, sans-serif';
    });
    const y = top + 16 + rows.length * 26 + 10, bw = Math.max(80, W - rx - 30);
    g.fillStyle = 'rgba(255,255,255,.45)'; g.fillText('Correlation', rx, y);
    g.fillStyle = 'rgba(255,255,255,.08)'; g.fillRect(rx, y + 8, bw, 6);
    const mid = rx + bw / 2, cxp = mid + (s.c * bw) / 2;
    g.fillStyle = s.c < 0 ? '#ff5f9e' : '#4dffa6'; g.fillRect(Math.min(mid, cxp), y + 8, Math.abs(cxp - mid), 6);
    g.fillStyle = '#fff'; g.font = '600 13px "JetBrains Mono", monospace'; g.fillText(s.c.toFixed(2), rx + 90, y);
  }
}
