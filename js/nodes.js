// Node type definitions.
//
// Each type declares its sockets and parameters (the editor builds its UI from these)
// and a `build(ctx, P, env)` that wires real Web Audio nodes into the given context.
// The same build runs for live playback (AudioContext) and export
// (OfflineAudioContext), so what you hear is what gets written.
//
// Socket types:
//   audio — an AudioNode signal. Into a parameter socket (`p:<key>`) it is added to
//           that AudioParam, which is how modulation works (LFO -> cutoff, etc).
//   notes — a stream of note events {t, dur, note, vel}, resolved by the engine from
//           sequencer nodes (`events`) through note processors (`transform`).
//
// A runtime instance may return:
//   inputs  {key: AudioNode}         outputs {key: AudioNode}
//   params  {key: AudioParam|[...]}  — modulation targets + default live `set`
//   note(ev), start(t), stop(t), set(key, v, t) -> handled?, sink (Output only),
//   analyser (Scope)

export const mtof = (n) => 440 * Math.pow(2, (n - 69) / 12);
const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
export const noteName = (n) => NOTE_NAMES[((n % 12) + 12) % 12] + (Math.floor(n / 12) - 1);
const dbToGain = (db) => (db <= -60 ? 0 : Math.pow(10, db / 20));

/** Deterministic RNG so exports are reproducible. */
export function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
}

const setp = (param, v, t) => {
  if (!param) return;
  for (const p of Array.isArray(param) ? param : [param]) {
    p.cancelScheduledValues(t);
    p.setTargetAtTime(v, t, 0.012);
  }
};

const WAVES = ['sine', 'square', 'sawtooth', 'triangle'];

// --- builders shared by several types ----------------------------------------

function noiseBuffer(ctx, color, seed = 1234) {
  const len = ctx.sampleRate * 2;
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = buf.getChannelData(0);
  const r = rng(seed);
  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0, last = 0;
  for (let i = 0; i < len; i++) {
    const w = r() * 2 - 1;
    if (color === 'pink') {
      b0 = 0.99886 * b0 + w * 0.0555179; b1 = 0.99332 * b1 + w * 0.0750759;
      b2 = 0.969 * b2 + w * 0.153852; b3 = 0.8665 * b3 + w * 0.3104856;
      b4 = 0.55 * b4 + w * 0.5329522; b5 = -0.7616 * b5 - w * 0.016898;
      d[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11; b6 = w * 0.115926;
    } else if (color === 'brown') {
      last = (last + 0.02 * w) / 1.02; d[i] = last * 3.5;
    } else d[i] = w;
  }
  // seamless wrap: equal-power crossfade of the last 50 ms over the first
  const f = Math.floor(ctx.sampleRate * 0.05);
  for (let i = 0; i < f; i++) { const k = i / f; d[i] = d[i] * Math.sqrt(k) + d[len - f + i] * Math.sqrt(1 - k); }
  const out = ctx.createBuffer(1, len - f, ctx.sampleRate);
  out.getChannelData(0).set(d.subarray(0, len - f));
  return out;
}

function reverbIR(ctx, seconds, dampHz, seed = 99) {
  const len = Math.max(1, Math.floor(ctx.sampleRate * seconds));
  const buf = ctx.createBuffer(2, len, ctx.sampleRate);
  const a = 1 - Math.exp((-2 * Math.PI * dampHz) / ctx.sampleRate);
  for (let c = 0; c < 2; c++) {
    const d = buf.getChannelData(c);
    const r = rng(seed + c * 7919);
    let y = 0;
    for (let i = 0; i < len; i++) {
      const env = Math.exp((-6.9 * i) / len);
      y += a * (r() * 2 - 1 - y);
      d[i] = y * env;
    }
  }
  return buf;
}

function shaperCurve(mode, drive) {
  const n = 4096, c = new Float32Array(n), k = Math.max(0.01, drive);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    if (mode === 'hard') c[i] = Math.max(-1, Math.min(1, x * k));
    else if (mode === 'fold') c[i] = Math.sin((x * k * Math.PI) / 2);
    else if (mode === 'asym') c[i] = x >= 0 ? Math.tanh(x * k) / Math.tanh(k) : Math.tanh(x * k * 0.5) / Math.tanh(k * 0.5) * 0.8;
    else c[i] = Math.tanh(x * k) / Math.tanh(k);
  }
  return c;
}

function reversed(buffer, cache) {
  if (cache.has(buffer)) return cache.get(buffer);
  const r = new AudioBuffer({ length: buffer.length, numberOfChannels: buffer.numberOfChannels, sampleRate: buffer.sampleRate });
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const s = buffer.getChannelData(c), d = r.getChannelData(c);
    for (let i = 0, n = s.length; i < n; i++) d[i] = s[n - 1 - i];
  }
  cache.set(buffer, r);
  return r;
}
const REVERSED = new WeakMap();

// --- node types --------------------------------------------------------------

export const CATEGORIES = {
  seq: { label: 'Sequence', color: '#ffb547' },
  source: { label: 'Sources', color: '#3fd8ff' },
  mod: { label: 'Modulation', color: '#a98bff' },
  fx: { label: 'Effects', color: '#ff5f9e' },
  util: { label: 'Utility', color: '#8fa3bf' },
  out: { label: 'Output', color: '#4dffa6' },
};

export const TYPES = {
  // ---------------------------------------------------------------- sequence
  trigger: {
    title: 'Trigger', cat: 'seq', width: 200,
    desc: 'Fires notes at set times — one-shot SFX, bursts, arpeggiated pings.',
    outputs: [{ key: 'notes', type: 'notes', label: 'Notes' }],
    params: [
      { key: 'at', label: 'At', type: 'number', min: 0, max: 30, step: 0.001, def: 0, unit: 's' },
      { key: 'note', label: 'Note', type: 'note', min: 0, max: 127, def: 60 },
      { key: 'length', label: 'Length', type: 'number', min: 0.005, max: 30, step: 0.001, def: 0.25, unit: 's', curve: 'log' },
      { key: 'vel', label: 'Velocity', type: 'number', min: 0, max: 1, step: 0.01, def: 1 },
      { key: 'repeat', label: 'Repeat', type: 'number', min: 1, max: 64, step: 1, def: 1 },
      { key: 'every', label: 'Every', type: 'number', min: 0.005, max: 10, step: 0.001, def: 0.12, unit: 's', curve: 'log' },
      { key: 'pstep', label: 'Pitch step', type: 'number', min: -24, max: 24, step: 1, def: 0, unit: 'st' },
      { key: 'decay', label: 'Vel decay', type: 'number', min: 0, max: 1, step: 0.01, def: 0 },
    ],
    events(P, p0, p1) {
      const out = [];
      for (let r = 0; r < P.repeat; r++) {
        const t = P.at + r * P.every;
        if (t >= p0 && t < p1) out.push({ t, dur: P.length, note: P.note + r * P.pstep, vel: P.vel * Math.pow(1 - P.decay, r) });
      }
      return out;
    },
  },

  stepseq: {
    title: 'Step Sequencer', cat: 'seq', width: 300, widget: 'steps',
    desc: 'Click a step to toggle, drag up/down to set its pitch. Synced to project BPM.',
    outputs: [{ key: 'notes', type: 'notes', label: 'Notes' }],
    params: [
      { key: 'steps', label: 'Steps', type: 'number', min: 1, max: 32, step: 1, def: 16 },
      { key: 'rate', label: 'Rate', type: 'select', options: [['1', '1/4'], ['0.5', '1/8'], ['0.25', '1/16'], ['0.125', '1/32'], ['0.3333333', '1/8T'], ['0.1666667', '1/16T']], def: '0.25' },
      { key: 'root', label: 'Root', type: 'note', min: 0, max: 127, def: 48 },
      { key: 'gate', label: 'Gate', type: 'number', min: 0.05, max: 1, step: 0.01, def: 0.5 },
      { key: 'swing', label: 'Swing', type: 'number', min: 0, max: 0.75, step: 0.01, def: 0 },
    ],
    initData: () => ({ steps: Array.from({ length: 32 }, (_, i) => ({ on: i % 4 === 0, semi: 0, vel: 1 })) }),
    events(P, p0, p1, env, data) {
      const sd = (60 / env.bpm) * parseFloat(P.rate);
      const out = [];
      const k0 = Math.max(0, Math.floor(p0 / sd) - 1), k1 = Math.ceil(p1 / sd);
      for (let k = k0; k <= k1; k++) {
        const t = k * sd + (k % 2 ? P.swing * sd * 0.5 : 0);
        if (t < p0 || t >= p1) continue;
        const s = data.steps[k % P.steps];
        if (s && s.on) out.push({ t, dur: sd * P.gate, note: P.root + s.semi, vel: s.vel ?? 1 });
      }
      return out;
    },
  },

  pianoroll: {
    title: 'Piano Roll', cat: 'seq', width: 260, widget: 'roll',
    desc: 'A looping clip of notes. Double-click the preview (or press Edit) to open the editor.',
    outputs: [{ key: 'notes', type: 'notes', label: 'Notes' }],
    params: [
      { key: 'length', label: 'Clip beats', type: 'number', min: 1, max: 128, step: 1, def: 16 },
      { key: 'transpose', label: 'Transpose', type: 'number', min: -48, max: 48, step: 1, def: 0, unit: 'st' },
    ],
    initData: () => ({ notes: [
      { s: 0, l: 1, n: 60, v: 0.9 }, { s: 1, l: 1, n: 63, v: 0.8 }, { s: 2, l: 1, n: 67, v: 0.8 }, { s: 3, l: 1, n: 70, v: 0.8 },
    ] }),
    events(P, p0, p1, env, data) {
      const spb = 60 / env.bpm, clip = P.length * spb, out = [];
      for (let k = Math.floor(p0 / clip); k * clip < p1; k++) {
        for (const n of data.notes) {
          if (n.s >= P.length) continue;
          const t = k * clip + n.s * spb;
          if (t >= p0 && t < p1) out.push({ t, dur: n.l * spb, note: n.n + P.transpose, vel: n.v ?? 0.9 });
        }
      }
      return out;
    },
  },

  transpose: {
    title: 'Transpose', cat: 'seq', width: 190,
    desc: 'Shifts incoming notes and scales velocity.',
    inputs: [{ key: 'notes', type: 'notes', label: 'Notes' }],
    outputs: [{ key: 'notes', type: 'notes', label: 'Notes' }],
    params: [
      { key: 'semi', label: 'Semitones', type: 'number', min: -48, max: 48, step: 1, def: 0, unit: 'st' },
      { key: 'vel', label: 'Velocity ×', type: 'number', min: 0, max: 2, step: 0.01, def: 1 },
      { key: 'len', label: 'Length ×', type: 'number', min: 0.05, max: 4, step: 0.01, def: 1 },
    ],
    transform(P, evs) { return evs.map((e) => ({ ...e, note: e.note + P.semi, vel: Math.min(1, e.vel * P.vel), dur: e.dur * P.len })); },
  },

  // ---------------------------------------------------------------- sources
  osc: {
    title: 'Oscillator', cat: 'source', width: 220, implicit: 'loop',
    desc: 'Band-limited oscillator. Follows notes when connected; Sweep bends each note (falling = discharge, rising = charge).',
    inputs: [{ key: 'notes', type: 'notes', label: 'Notes' }],
    outputs: [{ key: 'out', type: 'audio', label: 'Out' }],
    params: [
      { key: 'wave', label: 'Wave', type: 'select', options: WAVES.map((w) => [w, w]), def: 'sawtooth' },
      { key: 'freq', label: 'Freq', type: 'number', min: 1, max: 20000, step: 0.1, def: 220, unit: 'Hz', curve: 'log', mod: true },
      { key: 'octave', label: 'Octave', type: 'number', min: -4, max: 4, step: 1, def: 0 },
      { key: 'detune', label: 'Detune', type: 'number', min: -1200, max: 1200, step: 1, def: 0, unit: 'ct', mod: true },
      { key: 'sweep', label: 'Sweep', type: 'number', min: -60, max: 60, step: 0.5, def: 0, unit: 'st' },
      { key: 'sweepTime', label: 'Sweep time', type: 'number', min: 0.005, max: 10, step: 0.001, def: 0.2, unit: 's', curve: 'log' },
      { key: 'glide', label: 'Glide', type: 'number', min: 0, max: 2, step: 0.001, def: 0, unit: 's' },
      { key: 'gain', label: 'Level', type: 'number', min: 0, max: 1, step: 0.01, def: 0.5, mod: true },
    ],
    build(ctx, P) {
      const osc = ctx.createOscillator(), out = ctx.createGain();
      osc.type = P.wave; osc.frequency.value = P.freq * 2 ** P.octave; osc.detune.value = P.detune; out.gain.value = P.gain;
      osc.connect(out);
      const f = osc.frequency;
      return {
        outputs: { out }, params: { freq: f, detune: osc.detune, gain: out.gain },
        start: (t) => osc.start(t), stop: (t) => osc.stop(t),
        note(ev) {
          const hz = Math.min(20000, (ev.note == null ? P.freq : mtof(ev.note)) * 2 ** P.octave);
          f.cancelScheduledValues(ev.t);
          if (P.sweep) {
            f.setValueAtTime(hz, ev.t);
            f.exponentialRampToValueAtTime(Math.max(1, Math.min(20000, hz * 2 ** (P.sweep / 12))), ev.t + P.sweepTime);
          } else if (P.glide > 0) f.setTargetAtTime(hz, ev.t, P.glide / 3);
          else f.setValueAtTime(hz, ev.t);
        },
        set(k, v, t) {
          if (k === 'wave') { osc.type = v; return true; }
          if (k === 'freq' || k === 'octave') { setp(f, P.freq * 2 ** P.octave, t); return true; }
          return false;
        },
      };
    },
  },

  noise: {
    title: 'Noise', cat: 'source', width: 200,
    desc: 'White, pink or brown noise. The body of every impact, thruster and explosion.',
    outputs: [{ key: 'out', type: 'audio', label: 'Out' }],
    params: [
      { key: 'color', label: 'Color', type: 'select', options: [['white', 'white'], ['pink', 'pink'], ['brown', 'brown']], def: 'white' },
      { key: 'seed', label: 'Seed', type: 'number', min: 1, max: 9999, step: 1, def: 1234 },
      { key: 'gain', label: 'Level', type: 'number', min: 0, max: 1, step: 0.01, def: 0.5, mod: true },
    ],
    build(ctx, P) {
      const src = ctx.createBufferSource(), out = ctx.createGain();
      src.buffer = noiseBuffer(ctx, P.color, P.seed); src.loop = true; out.gain.value = P.gain;
      src.connect(out);
      return { outputs: { out }, params: { gain: out.gain }, start: (t) => src.start(t), stop: (t) => src.stop(t), set: (k) => k === 'gain' ? false : null };
    },
  },

  sampler: {
    title: 'Sampler', cat: 'source', width: 240, widget: 'wave', implicit: 'loop',
    desc: 'Plays an imported sample. Notes repitch it relative to Root. Unconnected, it plays once per loop.',
    inputs: [{ key: 'notes', type: 'notes', label: 'Notes' }],
    outputs: [{ key: 'out', type: 'audio', label: 'Out' }],
    params: [
      { key: 'sample', label: 'Sample', type: 'sample', def: '' },
      { key: 'root', label: 'Root', type: 'note', min: 0, max: 127, def: 60 },
      { key: 'pitch', label: 'Pitch', type: 'number', min: -48, max: 48, step: 0.01, def: 0, unit: 'st' },
      { key: 'start', label: 'Start', type: 'number', min: 0, max: 60, step: 0.001, def: 0, unit: 's' },
      { key: 'gain', label: 'Level', type: 'number', min: 0, max: 2, step: 0.01, def: 1, mod: true },
      { key: 'gate', label: 'Gate', type: 'bool', def: false },
      { key: 'loop', label: 'Loop', type: 'bool', def: false },
      { key: 'reverse', label: 'Reverse', type: 'bool', def: false },
    ],
    build(ctx, P, env) {
      const out = ctx.createGain(); out.gain.value = P.gain;
      const live = new Set();
      return {
        outputs: { out }, params: { gain: out.gain },
        note(ev) {
          let buf = env.buffers.get(P.sample);
          if (!buf) return;
          if (P.reverse) buf = reversed(buf, REVERSED);
          const src = ctx.createBufferSource(), g = ctx.createGain();
          src.buffer = buf; src.loop = P.loop;
          const semis = (ev.note == null ? 0 : ev.note - P.root) + P.pitch;
          src.playbackRate.value = 2 ** (semis / 12);
          g.gain.value = ev.vel ?? 1;
          src.connect(g).connect(out);
          src.start(ev.t, Math.min(P.start, buf.duration - 0.001));
          if (P.gate || P.loop) { g.gain.setTargetAtTime(0, ev.t + ev.dur, 0.01); src.stop(ev.t + ev.dur + 0.08); }
          live.add(src); src.onended = () => live.delete(src);
        },
        stop(t) { for (const s of live) { try { s.stop(t); } catch {} } },
        set: (k) => (k === 'gain' ? false : true), // others apply to the next note
      };
    },
  },

  // ---------------------------------------------------------------- modulation
  adsr: {
    title: 'Envelope', cat: 'mod', width: 230, widget: 'adsr', implicit: 'hold',
    desc: 'ADSR. Gates audio passing through (VCA) and outputs the envelope as CV. Unconnected notes: fires at 0 for Hold.',
    inputs: [{ key: 'in', type: 'audio', label: 'In' }, { key: 'notes', type: 'notes', label: 'Notes' }],
    outputs: [{ key: 'out', type: 'audio', label: 'Out' }, { key: 'cv', type: 'audio', label: 'CV' }],
    params: [
      { key: 'a', label: 'Attack', type: 'number', min: 0.0005, max: 10, step: 0.0001, def: 0.004, unit: 's', curve: 'log' },
      { key: 'd', label: 'Decay', type: 'number', min: 0.001, max: 10, step: 0.001, def: 0.2, unit: 's', curve: 'log' },
      { key: 's', label: 'Sustain', type: 'number', min: 0, max: 1, step: 0.01, def: 0.5 },
      { key: 'r', label: 'Release', type: 'number', min: 0.001, max: 10, step: 0.001, def: 0.3, unit: 's', curve: 'log' },
      { key: 'hold', label: 'Hold', type: 'number', min: 0.001, max: 30, step: 0.001, def: 0.3, unit: 's', curve: 'log' },
      { key: 'amount', label: 'CV amount', type: 'number', min: -10000, max: 10000, step: 1, def: 1000 },
      { key: 'velsens', label: 'Vel sens', type: 'number', min: 0, max: 1, step: 0.01, def: 0.5 },
    ],
    build(ctx, P) {
      const vca = ctx.createGain(); vca.gain.value = 0;
      const env = ctx.createConstantSource(); env.offset.value = 0;
      const cv = ctx.createGain(); cv.gain.value = P.amount;
      env.connect(vca.gain); env.connect(cv);
      const o = env.offset;
      return {
        inputs: { in: vca }, outputs: { out: vca, cv }, params: { amount: cv.gain },
        start: (t) => env.start(t), stop: (t) => env.stop(t),
        note(ev) {
          const pk = 1 - P.velsens + P.velsens * (ev.vel ?? 1);
          const { t } = ev, rel = t + Math.max(ev.dur, 0.001);
          o.cancelScheduledValues(t);
          o.setTargetAtTime(pk, t, P.a / 3);
          o.setTargetAtTime(pk * P.s, t + P.a, P.d / 3);
          o.setTargetAtTime(0, rel, P.r / 3);
        },
        set: () => false,
      };
    },
  },

  lfo: {
    title: 'LFO', cat: 'mod', width: 210,
    desc: 'Low-frequency oscillator. Output = wave × Depth + Offset; patch it into any ◆ parameter socket.',
    outputs: [{ key: 'out', type: 'audio', label: 'Out' }],
    params: [
      { key: 'wave', label: 'Wave', type: 'select', options: WAVES.map((w) => [w, w]), def: 'sine' },
      { key: 'rate', label: 'Rate', type: 'number', min: 0.01, max: 200, step: 0.01, def: 4, unit: 'Hz', curve: 'log', mod: true },
      { key: 'depth', label: 'Depth', type: 'number', min: 0, max: 10000, step: 0.01, def: 50, curve: 'log', mod: true },
      { key: 'offset', label: 'Offset', type: 'number', min: -10000, max: 10000, step: 0.01, def: 0, mod: true },
    ],
    build(ctx, P) {
      const osc = ctx.createOscillator(), depth = ctx.createGain(), off = ctx.createConstantSource(), out = ctx.createGain();
      osc.type = P.wave; osc.frequency.value = P.rate; depth.gain.value = P.depth; off.offset.value = P.offset;
      osc.connect(depth).connect(out); off.connect(out);
      return {
        outputs: { out }, params: { rate: osc.frequency, depth: depth.gain, offset: off.offset },
        start: (t) => { osc.start(t); off.start(t); }, stop: (t) => { osc.stop(t); off.stop(t); },
        set: (k, v) => { if (k === 'wave') { osc.type = v; return true; } return false; },
      };
    },
  },

  constant: {
    title: 'Constant', cat: 'mod', width: 190,
    desc: 'A fixed control value — sum it into a parameter socket.',
    outputs: [{ key: 'out', type: 'audio', label: 'Out' }],
    params: [{ key: 'value', label: 'Value', type: 'number', min: -20000, max: 20000, step: 0.01, def: 1, mod: true }],
    build(ctx, P) {
      const c = ctx.createConstantSource(); c.offset.value = P.value;
      return { outputs: { out: c }, params: { value: c.offset }, start: (t) => c.start(t), stop: (t) => c.stop(t) };
    },
  },

  // ---------------------------------------------------------------- effects
  filter: {
    title: 'Filter', cat: 'fx', width: 220, widget: 'filter',
    desc: 'Biquad filter, cascadable to 48 dB/oct. Cutoff socket takes LFO / envelope CV in Hz.',
    inputs: [{ key: 'in', type: 'audio', label: 'In' }],
    outputs: [{ key: 'out', type: 'audio', label: 'Out' }],
    params: [
      { key: 'type', label: 'Type', type: 'select', options: ['lowpass', 'highpass', 'bandpass', 'notch', 'peaking', 'lowshelf', 'highshelf', 'allpass'].map((x) => [x, x]), def: 'lowpass' },
      { key: 'cutoff', label: 'Cutoff', type: 'number', min: 20, max: 20000, step: 1, def: 2400, unit: 'Hz', curve: 'log', mod: true },
      { key: 'q', label: 'Resonance', type: 'number', min: 0.1, max: 30, step: 0.01, def: 0.8, curve: 'log', mod: true },
      { key: 'gain', label: 'Gain', type: 'number', min: -24, max: 24, step: 0.1, def: 0, unit: 'dB', mod: true },
      { key: 'slope', label: 'Slope', type: 'select', options: [['1', '12 dB'], ['2', '24 dB'], ['4', '48 dB']], def: '1' },
    ],
    build(ctx, P) {
      const n = parseInt(P.slope, 10) || 1;
      const fs = Array.from({ length: n }, () => {
        const f = ctx.createBiquadFilter(); f.type = P.type; f.frequency.value = P.cutoff; f.Q.value = P.q; f.gain.value = P.gain; return f;
      });
      for (let i = 1; i < n; i++) fs[i - 1].connect(fs[i]);
      return {
        inputs: { in: fs[0] }, outputs: { out: fs[n - 1] },
        params: { cutoff: fs.map((f) => f.frequency), q: fs.map((f) => f.Q), gain: fs.map((f) => f.gain) },
        set(k, v) { if (k === 'type') { fs.forEach((f) => (f.type = v)); return true; } return k === 'slope' ? null : false; },
      };
    },
  },

  delay: {
    title: 'Delay', cat: 'fx', width: 220,
    desc: 'Feedback echo with a damped loop — tape/space-echo flavour.',
    inputs: [{ key: 'in', type: 'audio', label: 'In' }],
    outputs: [{ key: 'out', type: 'audio', label: 'Out' }],
    params: [
      { key: 'time', label: 'Time', type: 'number', min: 0.001, max: 4, step: 0.001, def: 0.27, unit: 's', curve: 'log', mod: true },
      { key: 'feedback', label: 'Feedback', type: 'number', min: 0, max: 0.98, step: 0.01, def: 0.35, mod: true },
      { key: 'damp', label: 'Damping', type: 'number', min: 200, max: 20000, step: 1, def: 2200, unit: 'Hz', curve: 'log', mod: true },
      { key: 'mix', label: 'Mix', type: 'number', min: 0, max: 1, step: 0.01, def: 0.35, mod: true },
    ],
    build(ctx, P) {
      const inp = ctx.createGain(), out = ctx.createGain(), dry = ctx.createGain(), wet = ctx.createGain();
      const d = ctx.createDelay(5), fb = ctx.createGain(), lp = ctx.createBiquadFilter();
      d.delayTime.value = P.time; fb.gain.value = P.feedback; lp.frequency.value = P.damp; wet.gain.value = P.mix; dry.gain.value = 1 - P.mix;
      inp.connect(dry).connect(out); inp.connect(d); d.connect(lp).connect(fb).connect(d); d.connect(wet).connect(out);
      return {
        inputs: { in: inp }, outputs: { out }, params: { time: d.delayTime, feedback: fb.gain, damp: lp.frequency, mix: wet.gain },
        set(k, v, t) { if (k === 'mix') { setp(wet.gain, v, t); setp(dry.gain, 1 - v, t); return true; } return false; },
      };
    },
  },

  reverb: {
    title: 'Reverb', cat: 'fx', width: 220,
    desc: 'Convolution room from a generated, seeded impulse — every export renders the same tail.',
    inputs: [{ key: 'in', type: 'audio', label: 'In' }],
    outputs: [{ key: 'out', type: 'audio', label: 'Out' }],
    params: [
      { key: 'size', label: 'Decay', type: 'number', min: 0.1, max: 12, step: 0.01, def: 1.8, unit: 's', curve: 'log' },
      { key: 'predelay', label: 'Pre-delay', type: 'number', min: 0, max: 0.5, step: 0.001, def: 0.032, unit: 's' },
      { key: 'damp', label: 'Damping', type: 'number', min: 300, max: 20000, step: 1, def: 6000, unit: 'Hz', curve: 'log' },
      { key: 'mix', label: 'Mix', type: 'number', min: 0, max: 1, step: 0.01, def: 0.3 },
    ],
    build(ctx, P) {
      const inp = ctx.createGain(), out = ctx.createGain(), dry = ctx.createGain(), wet = ctx.createGain();
      const pre = ctx.createDelay(1), conv = ctx.createConvolver();
      pre.delayTime.value = P.predelay; conv.buffer = reverbIR(ctx, P.size, P.damp); wet.gain.value = P.mix; dry.gain.value = 1 - P.mix;
      inp.connect(dry).connect(out); inp.connect(pre).connect(conv).connect(wet).connect(out);
      return {
        inputs: { in: inp }, outputs: { out }, params: { predelay: pre.delayTime },
        set(k, v, t) {
          if (k === 'mix') { setp(wet.gain, v, t); setp(dry.gain, 1 - v, t); return true; }
          if (k === 'size' || k === 'damp') { conv.buffer = reverbIR(ctx, P.size, P.damp); return true; }
          return false;
        },
      };
    },
  },

  distort: {
    title: 'Distortion', cat: 'fx', width: 210,
    desc: 'Waveshaper, 4× oversampled. Soft, hard, asymmetric or wavefold.',
    inputs: [{ key: 'in', type: 'audio', label: 'In' }],
    outputs: [{ key: 'out', type: 'audio', label: 'Out' }],
    params: [
      { key: 'mode', label: 'Mode', type: 'select', options: [['soft', 'soft'], ['hard', 'hard'], ['asym', 'asym'], ['fold', 'fold']], def: 'soft' },
      { key: 'drive', label: 'Drive', type: 'number', min: 0.1, max: 50, step: 0.01, def: 3, curve: 'log' },
      { key: 'mix', label: 'Mix', type: 'number', min: 0, max: 1, step: 0.01, def: 1 },
      { key: 'level', label: 'Output', type: 'number', min: 0, max: 2, step: 0.01, def: 0.8, mod: true },
    ],
    build(ctx, P) {
      const inp = ctx.createGain(), sh = ctx.createWaveShaper(), dry = ctx.createGain(), wet = ctx.createGain(), out = ctx.createGain();
      sh.curve = shaperCurve(P.mode, P.drive); sh.oversample = '4x'; wet.gain.value = P.mix; dry.gain.value = 1 - P.mix; out.gain.value = P.level;
      inp.connect(sh).connect(wet).connect(out); inp.connect(dry).connect(out);
      return {
        inputs: { in: inp }, outputs: { out }, params: { level: out.gain },
        set(k, v, t) {
          if (k === 'mode' || k === 'drive') { sh.curve = shaperCurve(P.mode, P.drive); return true; }
          if (k === 'mix') { setp(wet.gain, v, t); setp(dry.gain, 1 - v, t); return true; }
          return false;
        },
      };
    },
  },

  crusher: {
    title: 'Bitcrusher', cat: 'fx', width: 210,
    desc: 'Bit depth + sample-rate reduction. 22050 Hz is the PS1-era SPU rate.',
    inputs: [{ key: 'in', type: 'audio', label: 'In' }],
    outputs: [{ key: 'out', type: 'audio', label: 'Out' }],
    params: [
      { key: 'bits', label: 'Bits', type: 'number', min: 1, max: 16, step: 0.1, def: 8 },
      { key: 'rate', label: 'Rate', type: 'number', min: 200, max: 48000, step: 1, def: 11025, unit: 'Hz', curve: 'log' },
      { key: 'mix', label: 'Mix', type: 'number', min: 0, max: 1, step: 0.01, def: 1 },
    ],
    build(ctx, P) {
      const w = new AudioWorkletNode(ctx, 'na-crusher', { outputChannelCount: [2] });
      const pm = (k) => w.parameters.get(k);
      pm('bits').value = P.bits; pm('rate').value = P.rate; pm('mix').value = P.mix;
      return { inputs: { in: w }, outputs: { out: w }, params: { bits: pm('bits'), rate: pm('rate'), mix: pm('mix') } };
    },
  },

  comp: {
    title: 'Compressor', cat: 'fx', width: 220,
    desc: 'Dynamics compressor with make-up gain.',
    inputs: [{ key: 'in', type: 'audio', label: 'In' }],
    outputs: [{ key: 'out', type: 'audio', label: 'Out' }],
    params: [
      { key: 'threshold', label: 'Threshold', type: 'number', min: -60, max: 0, step: 0.1, def: -18, unit: 'dB' },
      { key: 'ratio', label: 'Ratio', type: 'number', min: 1, max: 20, step: 0.1, def: 4 },
      { key: 'knee', label: 'Knee', type: 'number', min: 0, max: 40, step: 0.1, def: 6, unit: 'dB' },
      { key: 'attack', label: 'Attack', type: 'number', min: 0, max: 1, step: 0.001, def: 0.005, unit: 's' },
      { key: 'release', label: 'Release', type: 'number', min: 0.01, max: 1, step: 0.001, def: 0.12, unit: 's' },
      { key: 'makeup', label: 'Make-up', type: 'number', min: -12, max: 24, step: 0.1, def: 4, unit: 'dB' },
    ],
    build(ctx, P) {
      const c = ctx.createDynamicsCompressor(), g = ctx.createGain();
      c.threshold.value = P.threshold; c.ratio.value = P.ratio; c.knee.value = P.knee; c.attack.value = P.attack; c.release.value = P.release; g.gain.value = dbToGain(P.makeup);
      c.connect(g);
      return {
        inputs: { in: c }, outputs: { out: g },
        params: { threshold: c.threshold, ratio: c.ratio, knee: c.knee, attack: c.attack, release: c.release },
        set(k, v, t) { if (k === 'makeup') { setp(g.gain, dbToGain(v), t); return true; } return false; },
      };
    },
  },

  // ---------------------------------------------------------------- utility
  gain: {
    title: 'Gain / VCA', cat: 'util', width: 190,
    desc: 'Amplifier. Patch audio into the Gain socket for tremolo or ring modulation.',
    inputs: [{ key: 'in', type: 'audio', label: 'In' }],
    outputs: [{ key: 'out', type: 'audio', label: 'Out' }],
    params: [{ key: 'gain', label: 'Gain', type: 'number', min: 0, max: 4, step: 0.01, def: 1, mod: true }],
    build(ctx, P) { const g = ctx.createGain(); g.gain.value = P.gain; return { inputs: { in: g }, outputs: { out: g }, params: { gain: g.gain } }; },
  },

  mixer: {
    title: 'Mixer', cat: 'util', width: 200,
    desc: 'Four channel mixer.',
    inputs: [1, 2, 3, 4].map((i) => ({ key: 'in' + i, type: 'audio', label: 'In ' + i })),
    outputs: [{ key: 'out', type: 'audio', label: 'Out' }],
    params: [1, 2, 3, 4].map((i) => ({ key: 'l' + i, label: 'Level ' + i, type: 'number', min: 0, max: 2, step: 0.01, def: 0.8, mod: true })),
    build(ctx, P) {
      const out = ctx.createGain(), inputs = {}, params = {};
      for (let i = 1; i <= 4; i++) { const g = ctx.createGain(); g.gain.value = P['l' + i]; g.connect(out); inputs['in' + i] = g; params['l' + i] = g.gain; }
      return { inputs, outputs: { out }, params };
    },
  },

  pan: {
    title: 'Pan', cat: 'util', width: 190,
    desc: 'Stereo panner. (Mono exports fold this back to centre.)',
    inputs: [{ key: 'in', type: 'audio', label: 'In' }],
    outputs: [{ key: 'out', type: 'audio', label: 'Out' }],
    params: [{ key: 'pan', label: 'Pan', type: 'number', min: -1, max: 1, step: 0.01, def: 0, mod: true }],
    build(ctx, P) { const p = ctx.createStereoPanner(); p.pan.value = P.pan; return { inputs: { in: p }, outputs: { out: p }, params: { pan: p.pan } }; },
  },

  scope: {
    title: 'Scope', cat: 'util', width: 240, widget: 'scope',
    desc: 'Pass-through oscilloscope.',
    inputs: [{ key: 'in', type: 'audio', label: 'In' }],
    outputs: [{ key: 'out', type: 'audio', label: 'Out' }],
    params: [{ key: 'mode', label: 'View', type: 'select', options: [['wave', 'waveform'], ['spectrum', 'spectrum']], def: 'wave' }],
    build(ctx) {
      const g = ctx.createGain(), a = ctx.createAnalyser(); a.fftSize = 2048; g.connect(a);
      return { inputs: { in: g }, outputs: { out: g }, analyser: a, set: () => true };
    },
  },

  // ---------------------------------------------------------------- output
  output: {
    title: 'Output', cat: 'out', width: 230, widget: 'output',
    desc: 'One exported cue. Name becomes the .wav filename. Several outputs = a whole SFX bank, exported as a zip.',
    inputs: [{ key: 'in', type: 'audio', label: 'In' }],
    params: [
      { key: 'name', label: 'Cue name', type: 'text', def: 'cue' },
      { key: 'volume', label: 'Volume', type: 'number', min: -60, max: 12, step: 0.1, def: 0, unit: 'dB' },
      { key: 'length', label: 'Length', type: 'number', min: 0, max: 120, step: 0.001, def: 0, unit: 's', hint: '0 = project length' },
      { key: 'tail', label: 'Tail', type: 'number', min: 0, max: 20, step: 0.01, def: 0.5, unit: 's' },
      { key: 'loop', label: 'Loop (smpl)', type: 'bool', def: false },
      { key: 'seam', label: 'Seam fade', type: 'number', min: 0, max: 1, step: 0.001, def: 0.12, unit: 's' },
      { key: 'mute', label: 'Mute', type: 'bool', def: false },
    ],
    build(ctx, P) {
      const g = ctx.createGain(); g.gain.value = P.mute ? 0 : dbToGain(P.volume);
      return {
        inputs: { in: g }, sink: g,
        set(k, v, t) { if (k === 'volume' || k === 'mute') { setp(g.gain, P.mute ? 0 : dbToGain(P.volume), t); } return true; },
      };
    },
  },
};

export function defaultParams(type) {
  const p = {};
  for (const s of TYPES[type].params) p[s.key] = s.def;
  return p;
}

/** All input sockets for a type, including ◆ parameter-modulation sockets. */
export function inputSockets(type) {
  const T = TYPES[type];
  return [...(T.inputs || []), ...T.params.filter((p) => p.mod).map((p) => ({ key: 'p:' + p.key, type: 'audio', label: p.label, param: p.key }))];
}
