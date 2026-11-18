// Small DSP toolkit: FFT, spectrogram, onset detection.

/** In-place iterative radix-2 FFT. re/im length must be a power of two. */
export function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len, wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = a + len / 2;
        const tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
        const nr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = nr;
      }
    }
  }
}

const hann = (n) => Float32Array.from({ length: n }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1)));

/** Magnitude spectrogram in dB. Returns {cols: Float32Array[], bins, hop, size}. */
export function spectrogram(x, { size = 1024, maxCols = 900 } = {}) {
  const hop = Math.max(64, Math.ceil(Math.max(1, x.length - size) / maxCols));
  const w = hann(size), cols = [];
  const re = new Float32Array(size), im = new Float32Array(size);
  for (let start = 0; start + size <= Math.max(size, x.length); start += hop) {
    for (let i = 0; i < size; i++) { re[i] = (x[start + i] || 0) * w[i]; im[i] = 0; }
    fft(re, im);
    const col = new Float32Array(size / 2);
    for (let k = 0; k < size / 2; k++) col[k] = 10 * Math.log10((re[k] * re[k] + im[k] * im[k]) / size + 1e-12);
    cols.push(col);
    if (x.length < size) break;
  }
  return { cols, bins: size / 2, hop, size };
}

/** Onset times (seconds) by spectral flux with an adaptive threshold. sensitivity 0..1. */
export function detectOnsets(x, sr, sensitivity = 0.5, minGap = 0.06) {
  const size = 1024, hop = 256, w = hann(size);
  const re = new Float32Array(size), im = new Float32Array(size);
  let prev = new Float32Array(size / 2);
  const flux = [];
  for (let s = 0; s + size <= x.length; s += hop) {
    for (let i = 0; i < size; i++) { re[i] = x[s + i] * w[i]; im[i] = 0; }
    fft(re, im);
    const mag = new Float32Array(size / 2);
    let f = 0;
    for (let k = 0; k < size / 2; k++) { mag[k] = Math.log1p(Math.hypot(re[k], im[k])); const d = mag[k] - prev[k]; if (d > 0) f += d; }
    flux.push(f);
    prev = mag;
  }
  const out = [];
  const win = 8, k = 1.2 + (1 - sensitivity) * 2.5;
  // floor relative to the strongest onset, so tails and noise in quiet stretches don't slice
  const floor = Math.max(...flux, 0) * (0.04 + 0.3 * (1 - sensitivity));
  let last = -Infinity;
  for (let i = 1; i < flux.length - 1; i++) {
    let mean = 0, c = 0;
    for (let j = Math.max(0, i - win); j <= Math.min(flux.length - 1, i + win); j++) { mean += flux[j]; c++; }
    mean /= c;
    // frame centre, minus a few ms of pre-roll so a slice never clips its own attack
    const t = Math.max(0, (i * hop + size / 2) / sr - 0.004);
    if (flux[i] > mean * k && flux[i] >= flux[i - 1] && flux[i] >= flux[i + 1] && flux[i] > floor && t - last >= minGap) { out.push(t); last = t; }
  }
  return out;
}

/** Downmix an AudioBuffer-like to mono Float32Array. */
export function mono(buf) {
  const n = buf.length, out = new Float32Array(n), C = buf.numberOfChannels;
  for (let c = 0; c < C; c++) { const d = buf.getChannelData(c); for (let i = 0; i < n; i++) out[i] += d[i] / C; }
  return out;
}

/** Magma-ish colour map, t in 0..1 -> [r,g,b]. */
export function heat(t) {
  t = Math.max(0, Math.min(1, t));
  const stops = [[0, 0, 4, 12], [0.25, 59, 15, 112], [0.5, 140, 41, 129], [0.7, 222, 73, 104], [0.85, 254, 159, 109], [1, 252, 253, 191]];
  for (let i = 1; i < stops.length; i++) if (t <= stops[i][0]) {
    const [a, ...ca] = stops[i - 1], [b, ...cb] = stops[i], k = (t - a) / (b - a);
    return ca.map((v, j) => Math.round(v + (cb[j] - v) * k));
  }
  return stops[stops.length - 1].slice(1);
}
