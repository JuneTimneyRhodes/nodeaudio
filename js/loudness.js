// Integrated loudness (ITU-R BS.1770-4 / EBU R128), in LUFS.
//
// Peak-normalising a bank makes short clicks and long rumbles sit at very different
// perceived levels; matching loudness is what makes a set of cues feel even.

function biquad(x, b0, b1, b2, a1, a2) {
  const y = new Float64Array(x.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const v = b0 * x[i] + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1; x1 = x[i]; y2 = y1; y1 = v; y[i] = v;
  }
  return y;
}

/**
 * K-weighting filter coefficients for any sample rate — the derivation libebur128 uses,
 * which reproduces the BS.1770 reference coefficients at 48 kHz.
 * Returned as [b0, b1, b2, a1, a2] (a0 normalised to 1).
 */
export function kWeights(fs) {
  let f0 = 1681.974450955533, G = 3.999843853973347, Q = 0.7071752369554196;
  let K = Math.tan((Math.PI * f0) / fs);
  const Vh = Math.pow(10, G / 20), Vb = Math.pow(Vh, 0.4996667741545416);
  let a0 = 1 + K / Q + K * K;
  const shelf = [(Vh + (Vb * K) / Q + K * K) / a0, (2 * (K * K - Vh)) / a0, (Vh - (Vb * K) / Q + K * K) / a0, (2 * (K * K - 1)) / a0, (1 - K / Q + K * K) / a0];
  f0 = 38.13547087613982; Q = 0.5003270373238773;
  K = Math.tan((Math.PI * f0) / fs);
  a0 = 1 + K / Q + K * K;
  const hp = [1, -2, 1, (2 * (K * K - 1)) / a0, (1 - K / Q + K * K) / a0];
  return { shelf, hp };
}

/** channels: Float32Array[] -> integrated LUFS (-Infinity for silence). */
export function measureLufs(channels, fs) {
  const { shelf, hp } = kWeights(fs);
  const kw = channels.map((ch) => { const s = biquad(ch, ...shelf); return biquad(s, ...hp); });
  const n = kw[0].length;
  const block = Math.round(0.4 * fs), step = Math.round(0.1 * fs);
  const z = []; // mean square summed over channels, per block
  if (n < block) {
    let s = 0; for (const c of kw) { let m = 0; for (let i = 0; i < n; i++) m += c[i] * c[i]; s += m / Math.max(1, n); }
    z.push(s);
  } else {
    for (let start = 0; start + block <= n; start += step) {
      let s = 0;
      for (const c of kw) { let m = 0; for (let i = start; i < start + block; i++) m += c[i] * c[i]; s += m / block; }
      z.push(s);
    }
  }
  const L = (x) => -0.691 + 10 * Math.log10(x);
  const abs = z.filter((x) => x > 0 && L(x) > -70);
  if (!abs.length) return -Infinity;
  const rel = L(abs.reduce((a, b) => a + b, 0) / abs.length) - 10;
  const gated = abs.filter((x) => L(x) > rel);
  return L(gated.reduce((a, b) => a + b, 0) / gated.length);
}
