// Game Synth: a 1:1 port of space-rogue-repo's `scripts/audio/synth.gd`.
//
// The game makes every sound in code at load rather than shipping audio files. These
// nodes mirror `Synth`'s functions one-for-one, so a patch built from them can be
// heard here (rendered by the JS port below) and exported as GDScript that calls the
// same functions with the same numbers. The only intended difference is the random
// number generator: noise is statistically the same, not bit-identical.

export const MIX_RATE = 22050;
export const WAVES = ['SQUARE', 'SAW', 'SINE', 'NOISE', 'SOFT'];
const SOFT_DRIVE = 2.2;
const TAU = Math.PI * 2;

export const samples = (dur) => Math.max(Math.trunc(dur * MIX_RATE), 1);
const lerp = (a, b, t) => a + (b - a) * t;
const idiv = (a, b) => Math.trunc(a / b);

export class Rng {
  constructor(seed = 1) { this.s = (seed >>> 0) || 1; }
  randf() { let s = this.s; s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; this.s = s; return s / 4294967296; }
  randf_range(a, b) { return a + (b - a) * this.randf(); }
}

function blep(t, dt) {
  if (dt <= 0 || dt >= 0.5) return 0;
  if (t < dt) { const a = t / dt; return a + a - a * a - 1; }
  if (t > 1 - dt) { const b = (t - 1) / dt; return b * b + b + b + 1; }
  return 0;
}
function osc(kind, phase, dt, rng) {
  const t = phase % 1;
  switch (kind) {
    case 'SQUARE': return (t < 0.5 ? 1 : -1) + blep(t, dt) - blep((t + 0.5) % 1, dt);
    case 'SAW': return t * 2 - 1 - blep(t, dt);
    case 'SINE': return Math.sin(phase * TAU);
    case 'SOFT': return Math.tanh(Math.sin(phase * TAU) * SOFT_DRIVE) / Math.tanh(SOFT_DRIVE);
    default: return rng ? rng.randf_range(-1, 1) : 0;
  }
}

export const S = {
  tone(dur, f0, f1, kind, decay, rng) {
    const n = samples(dur), buf = new Float32Array(n);
    let phase = 0;
    for (let i = 0; i < n; i++) {
      const frac = i / n, dt = lerp(f0, f1, frac) / MIX_RATE;
      phase += dt;
      buf[i] = osc(kind, phase, dt, rng) * Math.pow(1 - frac, decay);
    }
    return buf;
  },
  noise(dur, decay, rng) {
    const n = samples(dur), buf = new Float32Array(n);
    for (let i = 0; i < n; i++) buf[i] = rng.randf_range(-1, 1) * Math.pow(1 - i / n, decay);
    return buf;
  },
  transient(dur, rng) {
    const n = samples(dur), buf = new Float32Array(n);
    for (let i = 0; i < n; i++) buf[i] = rng.randf_range(-1, 1) * Math.exp(-(i / n) * 22);
    return buf;
  },
  lowpass(buf, h0, h1, poles = 1) {
    const n = buf.length;
    for (let p = 0; p < Math.max(poles, 1); p++) {
      let y = 0;
      for (let i = 0; i < n; i++) {
        const hz = lerp(h0, h1, i / n);
        const a = Math.min(1, Math.max(0.001, 1 - Math.exp((-TAU * hz) / MIX_RATE)));
        y += a * (buf[i] - y); buf[i] = y;
      }
    }
  },
  band(buf, lo, hi, poles = 2) {
    const low = buf.slice();
    S.lowpass(low, lo, lo, poles);
    for (let i = 0; i < buf.length; i++) buf[i] -= low[i];
    S.lowpass(buf, hi, hi, poles);
  },
  loop_seam(buf, fade = 0.12) {
    const n = buf.length, f = Math.min(samples(fade), idiv(n, 3));
    if (f <= 1) return buf;
    const out = buf.slice(0, n - f);
    for (let i = 0; i < f; i++) { const k = i / f; out[i] = out[i] * Math.sqrt(k) + buf[n - f + i] * Math.sqrt(1 - k); }
    return out;
  },
  soft_clip(buf, drive = 1.4) { const d = Math.tanh(drive); for (let i = 0; i < buf.length; i++) buf[i] = Math.tanh(buf[i] * drive) / d; },
  mix(a, b, gain) {
    const out = new Float32Array(Math.max(a.length, b.length)); out.set(a);
    for (let i = 0; i < b.length; i++) out[i] += b[i] * gain;
    return out;
  },
  edges(buf, attack = 0.004, release = 0.01) {
    const n = buf.length, a = Math.min(samples(attack), idiv(n, 2)), r = Math.min(samples(release), idiv(n, 2));
    for (let i = 0; i < a; i++) buf[i] *= i / a;
    for (let i = 0; i < r; i++) buf[n - 1 - i] *= i / r;
  },
  normalize(buf, peak) {
    let hi = 0; for (const v of buf) hi = Math.max(hi, Math.abs(v));
    if (hi <= 0.0001) return;
    const k = peak / hi; for (let i = 0; i < buf.length; i++) buf[i] *= k;
  },
  reverb_approx(buf, wet = 0.45, tail = 1.2) {
    const out = new Float32Array(buf.length + samples(tail)); out.set(buf);
    for (const [ms, g] of [[31, 0.55], [61, 0.42], [97, 0.33], [149, 0.26], [211, 0.19]]) {
      const off = samples(ms / 1000), gain = g * wet;
      for (let i = 0; i < buf.length; i++) out[i + off] += buf[i] * gain;
    }
    const d = samples(0.137);
    for (let i = d; i < out.length; i++) out[i] += out[i - d] * 0.32;
    S.lowpass(out, 2200, 900, 2); S.soft_clip(out, 1.2); S.edges(out, 0.004, 0.05);
    return out;
  },
  compress(buf, thresh = 0.25, ratio = 6, attack_ms = 0.6, release_ms = 70) {
    const n = buf.length; if (!n) return;
    const at = Math.exp(-1 / Math.max(samples(attack_ms / 1000), 1)), rl = Math.exp(-1 / Math.max(samples(release_ms / 1000), 1));
    const gain = new Float32Array(n); let env = 0;
    for (let i = 0; i < n; i++) {
      const a = Math.abs(buf[i]); env = a > env ? a : env * rl + a * (1 - rl);
      const over = env / Math.max(thresh, 0.0001);
      gain[i] = over <= 1 ? 1 : Math.pow(over, 1 / Math.max(ratio, 0.001) - 1);
    }
    let g = 1;
    for (let i = 0; i < n; i++) { g = gain[i] < g ? gain[i] : g * at + gain[i] * (1 - at); buf[i] *= g; }
  },
  comb(buf, delay_ms, feedback = 0.7, amount = 0.5) {
    const n = buf.length, d = Math.max(samples(delay_ms / 1000), 1);
    if (n <= d) return;
    let peak = 0; for (const v of buf) peak = Math.max(peak, Math.abs(v));
    const wet = buf.slice();
    for (let i = d; i < n; i++) wet[i] += wet[i - d] * feedback;
    S.normalize(wet, Math.max(peak, 0.0001));
    for (let i = 0; i < n; i++) buf[i] = buf[i] * (1 - amount) + wet[i] * amount;
  },
  ringmod(buf, hz, amount = 0.5) {
    for (let i = 0; i < buf.length; i++) { const t = i / MIX_RATE; buf[i] = buf[i] * (1 - amount) + buf[i] * Math.sin(t * hz * TAU) * amount; }
  },
  chorus(buf, depth_ms = 2.5, rate_hz = 1.4, amount = 0.45, voices = 2) {
    const n = buf.length, out = new Float32Array(n), V = Math.max(voices, 1);
    const depth = samples(depth_ms / 1000);
    for (let i = 0; i < n; i++) out[i] = buf[i] * (1 - amount);
    for (let v = 0; v < V; v++) {
      const po = TAU * (v / V);
      for (let i = 0; i < n; i++) {
        const t = i / MIX_RATE, d = depth * (1.1 + Math.sin(t * rate_hz * TAU + po));
        const idx = Math.min(n - 1, Math.max(0, i - d)), lo = Math.trunc(idx), hi = Math.min(lo + 1, n - 1), fr = idx - lo;
        out[i] += (buf[lo] * (1 - fr) + buf[hi] * fr) * (amount / V);
      }
    }
    return out;
  },
  bitcrush(buf, bits = 9, hold = 1) {
    const q = 1 << Math.max(bits - 1, 1);
    for (let i = 0; i < buf.length; i++) buf[i] = Math.round(buf[i] * q) / q;
    if (hold > 1) for (let i = 0; i < buf.length; i += hold) { const v = buf[i]; for (let j = i; j < Math.min(i + hold, buf.length); j++) buf[j] = v; }
  },
  drive(buf, amount = 2, bias = 0.12) { const c = Math.tanh(bias); for (let i = 0; i < buf.length; i++) buf[i] = Math.tanh(buf[i] * amount + bias) - c; },
  layer(parts) {
    let n = 0; for (const [b] of parts) n = Math.max(n, b.length);
    const out = new Float32Array(n);
    for (const [b, g] of parts) for (let i = 0; i < b.length; i++) out[i] += b[i] * g;
    return out;
  },
};

// --- node definitions ----------------------------------------------------------

const BIN = [{ key: 'in', type: 'buffer', label: 'In' }];
const BOUT = [{ key: 'out', type: 'buffer', label: 'Out' }];
const num = (key, label, min, max, def, step = 0.001, extra = {}) => ({ key, label, type: 'number', min, max, step, def, ...extra });

// gd: number formatting for GDScript (floats must carry a decimal point)
export const gf = (x) => { const s = String(+(+x).toFixed(6)); return /[.e]/.test(s) ? s : s + '.0'; };
const gi = (x) => String(Math.round(x));

// kind: 'src' (makes a buffer), 'inplace' (mutates its input), 'ret' (returns a new buffer)
export const GS_TYPES = {
  gs_tone: {
    title: 'Synth.tone', cat: 'gsynth', width: 220, kind: 'src', outputs: BOUT,
    desc: 'Synth.tone — oscillator swept from f0 to f1 with a power-curve decay. Falling reads as discharge, rising as charge.',
    params: [num('dur', 'Duration', 0.005, 10, 0.15, 0.001, { unit: 's', curve: 'log' }), num('f0', 'Freq start', 10, 11000, 880, 0.1, { unit: 'Hz', curve: 'log' }),
      num('f1', 'Freq end', 10, 11000, 220, 0.1, { unit: 'Hz', curve: 'log' }), { key: 'wave', label: 'Wave', type: 'select', options: WAVES.map((w) => [w, w]), def: 'SOFT' },
      num('decay', 'Decay', 0, 12, 1.5, 0.01)],
    js: (P, _, rng) => S.tone(P.dur, P.f0, P.f1, P.wave, P.decay, rng),
    gd: (P) => `Synth.tone(${gf(P.dur)}, ${gf(P.f0)}, ${gf(P.f1)}, Synth.Wave.${P.wave}, ${gf(P.decay)}, rng)`,
  },
  gs_noise: {
    title: 'Synth.noise', cat: 'gsynth', width: 200, kind: 'src', outputs: BOUT,
    desc: 'Synth.noise — white noise with its own decay. Impacts, thrusters, the body of explosions.',
    params: [num('dur', 'Duration', 0.005, 10, 0.4, 0.001, { unit: 's', curve: 'log' }), num('decay', 'Decay', 0, 12, 2, 0.01)],
    js: (P, _, rng) => S.noise(P.dur, P.decay, rng),
    gd: (P) => `Synth.noise(${gf(P.dur)}, ${gf(P.decay)}, rng)`,
  },
  gs_transient: {
    title: 'Synth.transient', cat: 'gsynth', width: 200, kind: 'src', outputs: BOUT,
    desc: 'Synth.transient — a few ms of steeply decaying noise: the click on the front of a hit.',
    params: [num('dur', 'Duration', 0.001, 0.2, 0.004, 0.0005, { unit: 's', curve: 'log' })],
    js: (P, _, rng) => S.transient(P.dur, rng),
    gd: (P) => `Synth.transient(${gf(P.dur)}, rng)`,
  },
  gs_layer: {
    title: 'Synth.layer', cat: 'gsynth', width: 200, kind: 'layer',
    inputs: [1, 2, 3, 4].map((i) => ({ key: 'in' + i, type: 'buffer', label: 'Part ' + i })), outputs: BOUT,
    desc: 'Synth.layer — sums parts with a gain each (unconnected parts are skipped).',
    params: [1, 2, 3, 4].map((i) => num('g' + i, 'Gain ' + i, 0, 2, i === 1 ? 1 : 0.5, 0.01)),
  },
  gs_lowpass: {
    title: 'Synth.lowpass', cat: 'gsynth', width: 210, kind: 'inplace', inputs: BIN, outputs: BOUT,
    desc: 'Synth.lowpass — one-pole lowpass whose cutoff sweeps across the buffer. A falling cutoff turns a noise burst into an explosion.',
    params: [num('h0', 'Cutoff start', 20, 11000, 4000, 1, { unit: 'Hz', curve: 'log' }), num('h1', 'Cutoff end', 20, 11000, 400, 1, { unit: 'Hz', curve: 'log' }), num('poles', 'Poles', 1, 4, 1, 1)],
    js: (P, b) => S.lowpass(b, P.h0, P.h1, P.poles),
    gd: (P, v) => `Synth.lowpass(${v}, ${gf(P.h0)}, ${gf(P.h1)}, ${gi(P.poles)})`,
  },
  gs_band: {
    title: 'Synth.band', cat: 'gsynth', width: 200, kind: 'inplace', inputs: BIN, outputs: BOUT,
    desc: 'Synth.band — removes everything below Low and above High. Makes noise read as air rather than a note.',
    params: [num('lo', 'Low', 20, 11000, 200, 1, { unit: 'Hz', curve: 'log' }), num('hi', 'High', 20, 11000, 2000, 1, { unit: 'Hz', curve: 'log' }), num('poles', 'Poles', 1, 4, 2, 1)],
    js: (P, b) => S.band(b, P.lo, P.hi, P.poles),
    gd: (P, v) => `Synth.band(${v}, ${gf(P.lo)}, ${gf(P.hi)}, ${gi(P.poles)})`,
  },
  gs_softclip: {
    title: 'Synth.soft_clip', cat: 'gsynth', width: 200, kind: 'inplace', inputs: BIN, outputs: BOUT,
    desc: 'Synth.soft_clip — tanh saturation instead of a hard clamp.',
    params: [num('drive', 'Drive', 0.1, 10, 1.4, 0.01)],
    js: (P, b) => S.soft_clip(b, P.drive), gd: (P, v) => `Synth.soft_clip(${v}, ${gf(P.drive)})`,
  },
  gs_drive: {
    title: 'Synth.drive', cat: 'gsynth', width: 200, kind: 'inplace', inputs: BIN, outputs: BOUT,
    desc: 'Synth.drive — biased tanh drive; the bias adds even harmonics.',
    params: [num('amount', 'Amount', 0.1, 10, 2, 0.01), num('bias', 'Bias', -1, 1, 0.12, 0.01)],
    js: (P, b) => S.drive(b, P.amount, P.bias), gd: (P, v) => `Synth.drive(${v}, ${gf(P.amount)}, ${gf(P.bias)})`,
  },
  gs_bitcrush: {
    title: 'Synth.bitcrush', cat: 'gsynth', width: 200, kind: 'inplace', inputs: BIN, outputs: BOUT,
    desc: 'Synth.bitcrush — quantise to Bits and hold each sample for Hold samples.',
    params: [num('bits', 'Bits', 1, 16, 9, 1), num('hold', 'Hold', 1, 32, 1, 1)],
    js: (P, b) => S.bitcrush(b, P.bits, P.hold), gd: (P, v) => `Synth.bitcrush(${v}, ${gi(P.bits)}, ${gi(P.hold)})`,
  },
  gs_comb: {
    title: 'Synth.comb', cat: 'gsynth', width: 200, kind: 'inplace', inputs: BIN, outputs: BOUT,
    desc: 'Synth.comb — short feedback delay; gives hits a metallic body.',
    params: [num('delay', 'Delay', 0.1, 100, 6.5, 0.1, { unit: 'ms' }), num('feedback', 'Feedback', 0, 0.98, 0.7, 0.01), num('amount', 'Amount', 0, 1, 0.5, 0.01)],
    js: (P, b) => S.comb(b, P.delay, P.feedback, P.amount), gd: (P, v) => `Synth.comb(${v}, ${gf(P.delay)}, ${gf(P.feedback)}, ${gf(P.amount)})`,
  },
  gs_ringmod: {
    title: 'Synth.ringmod', cat: 'gsynth', width: 200, kind: 'inplace', inputs: BIN, outputs: BOUT,
    desc: 'Synth.ringmod — multiply by a sine; inharmonic, robotic.',
    params: [num('hz', 'Freq', 1, 5000, 165, 0.1, { unit: 'Hz', curve: 'log' }), num('amount', 'Amount', 0, 1, 0.5, 0.01)],
    js: (P, b) => S.ringmod(b, P.hz, P.amount), gd: (P, v) => `Synth.ringmod(${v}, ${gf(P.hz)}, ${gf(P.amount)})`,
  },
  gs_chorus: {
    title: 'Synth.chorus', cat: 'gsynth', width: 200, kind: 'ret', inputs: BIN, outputs: BOUT,
    desc: 'Synth.chorus — modulated short delays; thickens a tone.',
    params: [num('depth', 'Depth', 0.1, 20, 2.5, 0.1, { unit: 'ms' }), num('rate', 'Rate', 0.05, 20, 1.4, 0.01, { unit: 'Hz' }), num('amount', 'Amount', 0, 1, 0.45, 0.01), num('voices', 'Voices', 1, 8, 2, 1)],
    js: (P, b) => S.chorus(b, P.depth, P.rate, P.amount, P.voices), gd: (P, v) => `Synth.chorus(${v}, ${gf(P.depth)}, ${gf(P.rate)}, ${gf(P.amount)}, ${gi(P.voices)})`,
  },
  gs_compress: {
    title: 'Synth.compress', cat: 'gsynth', width: 210, kind: 'inplace', inputs: BIN, outputs: BOUT,
    desc: 'Synth.compress — envelope-follower compressor.',
    params: [num('thresh', 'Threshold', 0.01, 1, 0.25, 0.01), num('ratio', 'Ratio', 1, 30, 6, 0.1), num('attack', 'Attack', 0.01, 50, 0.6, 0.01, { unit: 'ms' }), num('release', 'Release', 1, 1000, 70, 1, { unit: 'ms' })],
    js: (P, b) => S.compress(b, P.thresh, P.ratio, P.attack, P.release), gd: (P, v) => `Synth.compress(${v}, ${gf(P.thresh)}, ${gf(P.ratio)}, ${gf(P.attack)}, ${gf(P.release)})`,
  },
  gs_edges: {
    title: 'Synth.edges', cat: 'gsynth', width: 200, kind: 'inplace', inputs: BIN, outputs: BOUT,
    desc: 'Synth.edges — linear fade in/out so a buffer cannot click.',
    params: [num('attack', 'Attack', 0, 1, 0.004, 0.0005, { unit: 's' }), num('release', 'Release', 0, 2, 0.01, 0.0005, { unit: 's' })],
    js: (P, b) => S.edges(b, P.attack, P.release), gd: (P, v) => `Synth.edges(${v}, ${gf(P.attack)}, ${gf(P.release)})`,
  },
  gs_normalize: {
    title: 'Synth.normalize', cat: 'gsynth', width: 200, kind: 'inplace', inputs: BIN, outputs: BOUT,
    desc: 'Synth.normalize — scale so the loudest sample hits Peak.',
    params: [num('peak', 'Peak', 0.01, 1, 0.8, 0.01)],
    js: (P, b) => S.normalize(b, P.peak), gd: (P, v) => `Synth.normalize(${v}, ${gf(P.peak)})`,
  },
  gs_reverb: {
    title: 'Synth.reverb_approx', cat: 'gsynth', width: 210, kind: 'ret', inputs: BIN, outputs: BOUT,
    desc: 'Synth.reverb_approx — the audition-tool approximation of the SFX bus room. The game normally adds its room on the bus instead.',
    params: [num('wet', 'Wet', 0, 1, 0.45, 0.01), num('tail', 'Tail', 0, 5, 1.2, 0.01, { unit: 's' })],
    js: (P, b) => S.reverb_approx(b, P.wet, P.tail), gd: (P, v) => `Synth.reverb_approx(${v}, ${gf(P.wet)}, ${gf(P.tail)})`,
  },
  gs_seam: {
    title: 'Synth.loop_seam', cat: 'gsynth', width: 200, kind: 'ret', inputs: BIN, outputs: BOUT,
    desc: 'Synth.loop_seam — crossfades the tail over the head so the buffer loops without a seam.',
    params: [num('fade', 'Fade', 0.001, 2, 0.12, 0.001, { unit: 's' })],
    js: (P, b) => S.loop_seam(b, P.fade), gd: (P, v) => `Synth.loop_seam(${v}, ${gf(P.fade)})`,
  },
  gs_out: {
    title: 'Synth Cue', cat: 'gsynth', width: 240, kind: 'out', widget: 'gscue', implicit: 'loop',
    desc: 'Ends a Game Synth chain. Plays the baked buffer (22050 Hz, like the game) and exports it as a GDScript bake function. Feed its Out into an Output node to also export WAV.',
    inputs: [{ key: 'in', type: 'buffer', label: 'Buffer' }, { key: 'notes', type: 'notes', label: 'Notes' }],
    outputs: [{ key: 'out', type: 'audio', label: 'Out' }],
    params: [
      { key: 'name', label: 'Func name', type: 'text', def: 'cue' },
      { key: 'loop', label: 'Loop', type: 'bool', def: false },
      { key: 'seed', label: 'Seed', type: 'number', min: 1, max: 99999, step: 1, def: 1 },
      { key: 'root', label: 'Root', type: 'note', min: 0, max: 127, def: 60 },
      { key: 'voices', label: 'Voices', type: 'number', min: 1, max: 16, step: 1, def: 4 },
      { key: 'gain', label: 'Level', type: 'number', min: 0, max: 2, step: 0.01, def: 1, mod: true },
    ],
  },
};

// --- evaluation & codegen --------------------------------------------------------

/** graph: {nodes, links} (flattened). Returns Float32Array at MIX_RATE for the gs_out node. */
export function evaluate(graph, outId, seed = 1) {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const into = (id, port) => graph.links.filter((l) => l.to.node === id && l.to.port === port);
  const rng = new Rng(seed);
  const memo = new Map();
  const ev = (id, depth = 0) => {
    if (memo.has(id)) return memo.get(id).slice();
    if (depth > 64) return new Float32Array(1);
    const n = byId.get(id), T = GS_TYPES[n.type];
    if (!T) return new Float32Array(1);
    let out;
    if (T.kind === 'src') out = T.js(n.params, null, rng);
    else if (T.kind === 'layer') {
      const parts = [];
      for (let i = 1; i <= 4; i++) { const l = into(id, 'in' + i)[0]; if (l) parts.push([ev(l.from.node, depth + 1), n.params['g' + i]]); }
      out = S.layer(parts.length ? parts : [[new Float32Array(1), 0]]);
    } else {
      const l = into(id, 'in')[0];
      const b = l ? ev(l.from.node, depth + 1) : new Float32Array(1);
      if (T.kind === 'inplace') { T.js(n.params, b); out = b; } else out = T.js(n.params, b);
    }
    memo.set(id, out);
    return out.slice();
  };
  const l = into(outId, 'in')[0];
  return l ? ev(l.from.node) : new Float32Array(1);
}

/** Key that changes whenever anything upstream of a gs_out changes (bake cache). */
export function cueKey(graph, outId) {
  const seen = new Set(), stack = [outId], parts = [];
  while (stack.length) {
    const id = stack.pop();
    if (seen.has(id)) continue;
    seen.add(id);
    const n = graph.nodes.find((x) => x.id === id);
    if (!n || (n.type !== 'gs_out' && !GS_TYPES[n.type])) continue;
    parts.push(id, n.type, JSON.stringify(n.params));
    for (const l of graph.links) if (l.to.node === id && l.to.port !== 'notes') { parts.push(l.to.port + '<' + l.from.node); stack.push(l.from.node); }
  }
  return parts.join('|');
}

export const funcName = (s) => 'bake_' + (String(s || 'cue').toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '') || 'cue');

/** GDScript for one gs_out node. Returns {code, warnings}. */
export function codegen(graph, outId, projectName = '') {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const into = (id, port) => graph.links.filter((l) => l.to.node === id && l.to.port === port);
  const consumers = (id) => graph.links.filter((l) => l.from.node === id && (GS_TYPES[byId.get(l.to.node)?.type])).length;
  const out = byId.get(outId);
  const lines = [], warnings = [];
  const vars = new Map();
  let k = 0;
  const emit = (id, depth = 0) => {
    if (vars.has(id)) return vars.get(id);
    const n = byId.get(id), T = GS_TYPES[n.type];
    if (!T || depth > 64) { warnings.push(`${n ? n.type : id} is not a Game Synth node and was skipped`); return 'PackedFloat32Array([0.0])'; }
    let v;
    if (T.kind === 'src') { v = 'b' + ++k; lines.push(`var ${v} := ${T.gd(n.params)}`); }
    else if (T.kind === 'layer') {
      const parts = [];
      for (let i = 1; i <= 4; i++) { const l = into(id, 'in' + i)[0]; if (l) parts.push(`[${emit(l.from.node, depth + 1)}, ${gf(n.params['g' + i])}]`); }
      v = 'b' + ++k; lines.push(`var ${v} := Synth.layer([${parts.join(', ')}])`);
    } else {
      const l = into(id, 'in')[0];
      let src = l ? emit(l.from.node, depth + 1) : null;
      if (!src) { warnings.push(`${T.title} has nothing connected`); src = 'PackedFloat32Array([0.0])'; }
      if (T.kind === 'inplace') {
        if (l && consumers(l.from.node) > 1) { v = 'b' + ++k; lines.push(`var ${v} := ${src}.duplicate()`); } else v = src;
        lines.push(T.gd(n.params, v));
      } else { v = 'b' + ++k; lines.push(`var ${v} := ${T.gd(n.params, src)}`); }
    }
    vars.set(id, v);
    return v;
  };
  const l = into(outId, 'in')[0];
  const fin = l ? emit(l.from.node) : 'PackedFloat32Array([0.0])';
  if (!l) warnings.push('Synth Cue has no buffer connected');
  const name = funcName(out.params.name);
  const code = [
    `## ${out.params.name} — generated by NodeAudio${projectName ? ` from "${projectName}"` : ''}.`,
    `## Pass an RNG seeded with ${out.params.seed} to match the audition seed (noise is equivalent, not bit-identical).`,
    `static func ${name}(rng: RandomNumberGenerator) -> AudioStreamWAV:`,
    ...lines.map((x) => '\t' + x),
    `\treturn Synth.to_wav(${fin}, ${out.params.loop ? 'true' : 'false'})`,
  ].join('\n');
  return { code, warnings, name };
}

/** One .gd file holding every cue's bake function. */
export function codegenFile(graph, outIds, projectName) {
  const parts = outIds.map((id) => codegen(graph, id, projectName));
  const names = parts.map((p) => p.name);
  const dup = names.filter((n, i) => names.indexOf(n) !== i);
  const head = [
    '## Generated by NodeAudio (Game Synth nodes). Each function bakes one cue with',
    '## the game\'s own Synth (scripts/audio/synth.gd), exactly as auditioned in the editor.',
    '## Paste the functions into the class that bakes your cues, or keep this file and call',
    '## NodeAudioCues.bake_<name>(rng).',
    'class_name NodeAudioCues',
    'extends RefCounted',
    '',
  ];
  return { code: head.join('\n') + '\n' + parts.map((p) => p.code).join('\n\n\n') + '\n', warnings: [...parts.flatMap((p) => p.warnings), ...(dup.length ? [`Duplicate function names: ${[...new Set(dup)].join(', ')}`] : [])] };
}
