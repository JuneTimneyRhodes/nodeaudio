// Node type definitions.
//
// Each type declares its sockets and parameters (the editor builds its UI from these)
// and a `build(ctx, P, env, V)` that wires real Web Audio nodes into the given context.
// The same build runs for live playback (AudioContext) and export
// (OfflineAudioContext), so what you hear is what gets written.
//
// Socket types:
//   audio  — an AudioNode signal. Into a parameter socket (`p:<key>`) it is added to
//            that AudioParam, which is how modulation works (LFO -> cutoff, etc).
//   notes  — note events {t, dur, note, vel, voice}, resolved by the engine from
//            sequencer nodes (`events`) through note processors (`transform`).
//   buffer — Game Synth buffers (see gamesynth.js), baked offline.
//
// Polyphony: `V` is the voice count the engine decided for this node. Builders return
// outputs/inputs/params as arrays with one entry per voice; the engine connects
// voice-to-voice where counts match and sums where they don't.

import { GS_TYPES } from './gamesynth.js';

export const mtof = (n) => 440 * Math.pow(2, (n - 69) / 12);
const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
export const noteName = (n) => NOTE_NAMES[((n % 12) + 12) % 12] + (Math.floor(n / 12) - 1);
export const dbToGain = (db) => (db <= -60 ? 0 : Math.pow(10, db / 20));
const voices = (V, f) => Array.from({ length: Math.max(1, V | 0) }, (_, i) => f(i));
export const flat = (x) => (Array.isArray(x) ? x.flatMap(flat) : x ? [x] : []);

/** Deterministic RNG so exports are reproducible. */
export function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
}

export const setp = (param, v, t) => {
  for (const p of flat(param)) { p.cancelScheduledValues(t); p.setTargetAtTime(v, t, 0.012); }
};

const WAVES = ['sine', 'square', 'sawtooth', 'triangle'];
const VOICES = { key: 'voices', label: 'Voices', type: 'number', min: 1, max: 16, step: 1, def: 1, hint: 'Polyphony: notes that overlap each get a voice' };

/** Pitch a frequency param for a note: sweep, glide or jump. */
function pitchTo(f, hz, t, P) {
  f.cancelScheduledValues(t);
  if (P.sweep) {
    f.setValueAtTime(hz, t);
    f.exponentialRampToValueAtTime(Math.max(1, Math.min(20000, hz * 2 ** (P.sweep / 12))), t + P.sweepTime);
  } else if (P.glide > 0) f.setTargetAtTime(hz, t, P.glide / 3);
  else f.setValueAtTime(hz, t);
}

// --- buffers shared by several types ----------------------------------------

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
  const f = Math.floor(ctx.sampleRate * 0.05);
  for (let i = 0; i < f; i++) { const k = i / f; d[i] = d[i] * Math.sqrt(k) + d[len - f + i] * Math.sqrt(1 - k); }
  const out = ctx.createBuffer(1, len - f, ctx.sampleRate);
  out.getChannelData(0).set(d.subarray(0, len - f));
  return out;
}

export function reverbIR(ctx, seconds, dampHz, seed = 99, hiHz = 0) {
  const len = Math.max(1, Math.floor(ctx.sampleRate * seconds));
  const buf = ctx.createBuffer(2, len, ctx.sampleRate);
  const a = 1 - Math.exp((-2 * Math.PI * dampHz) / ctx.sampleRate);
  const h = hiHz > 0 ? 1 - Math.exp((-2 * Math.PI * hiHz) / ctx.sampleRate) : 0;
  for (let c = 0; c < 2; c++) {
    const d = buf.getChannelData(c);
    const r = rng(seed + c * 7919);
    let y = 0, lo = 0;
    for (let i = 0; i < len; i++) {
      y += a * (r() * 2 - 1 - y);
      lo += h * (y - lo);
      d[i] = (y - lo) * Math.exp((-6.9 * i) / len);
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
    else if (mode === 'asym') c[i] = x >= 0 ? Math.tanh(x * k) / Math.tanh(k) : (Math.tanh(x * k * 0.5) / Math.tanh(k * 0.5)) * 0.8;
    else c[i] = Math.tanh(x * k) / Math.tanh(k);
  }
  return c;
}

const REVERSED = new WeakMap();
function reversed(buffer) {
  if (REVERSED.has(buffer)) return REVERSED.get(buffer);
  const r = new AudioBuffer({ length: buffer.length, numberOfChannels: buffer.numberOfChannels, sampleRate: buffer.sampleRate });
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const s = buffer.getChannelData(c), d = r.getChannelData(c);
    for (let i = 0, n = s.length; i < n; i++) d[i] = s[n - 1 - i];
  }
  REVERSED.set(buffer, r);
  return r;
}

// --- wavetables ----------------------------------------------------------------

const WT_FRAMES = 8, WT_HARM = 64;
function harmonicFrames(kind) {
  // returns WT_FRAMES arrays of [real, imag] harmonic amplitudes
  const frames = [];
  for (let f = 0; f < WT_FRAMES; f++) {
    const m = f / (WT_FRAMES - 1), re = new Float32Array(WT_HARM), im = new Float32Array(WT_HARM);
    for (let h = 1; h < WT_HARM; h++) {
      let a = 0;
      if (kind === 'basic') {
        // sine -> triangle -> saw -> square
        const sine = h === 1 ? 1 : 0, tri = h % 2 ? (((h - 1) / 2) % 2 ? -1 : 1) / (h * h) : 0, saw = 1 / h, sq = h % 2 ? 1 / h : 0;
        const seg = m * 3, i = Math.min(2, Math.floor(seg)), t = seg - i, ws = [sine, tri, saw, sq];
        a = ws[i] * (1 - t) + ws[i + 1] * t;
      } else if (kind === 'pwm') {
        const w = 0.5 - m * 0.45; a = (2 / (h * Math.PI)) * Math.sin(h * Math.PI * w);
      } else if (kind === 'vocal') {
        const f1 = 2 + m * 6, f2 = 7 + m * 14;
        a = (Math.exp(-((h - f1) ** 2) / 4) + 0.6 * Math.exp(-((h - f2) ** 2) / 8)) / Math.sqrt(h);
      } else if (kind === 'digital') {
        a = ((h * (3 + Math.floor(m * 13))) % 7 < 3 ? 1 : 0.15) / h;
      } else if (kind === 'organ') {
        const draw = [1, 0.8, 0, 0.6, 0, 0.4, 0, 0.5].map((x, i) => x * (i / 7 <= m + 0.15 ? 1 : 0));
        a = [1, 2, 3, 4, 6, 8, 10, 12].includes(h) ? draw[[1, 2, 3, 4, 6, 8, 10, 12].indexOf(h)] || 0.05 : 0;
        if (h === 1) a = 1;
      }
      im[h] = a;
    }
    frames.push([re, im]);
  }
  return frames;
}
function sampleFrames(buf) {
  const d = buf.getChannelData(0), L = 2048, frames = [];
  for (let f = 0; f < WT_FRAMES; f++) {
    const start = Math.floor((f / WT_FRAMES) * Math.max(0, d.length - L));
    const re = new Float32Array(WT_HARM), im = new Float32Array(WT_HARM);
    for (let h = 1; h < WT_HARM; h++) {
      let sr = 0, si = 0;
      for (let n = 0; n < L; n++) { const x = d[start + n] || 0, ph = (2 * Math.PI * h * n) / L; sr += x * Math.cos(ph); si += x * Math.sin(ph); }
      re[h] = sr / L; im[h] = si / L;
    }
    frames.push([re, im]);
  }
  return frames;
}
const bumpCurves = [];
function bump(i) {
  if (bumpCurves[i]) return bumpCurves[i];
  const n = 1024, c = new Float32Array(n);
  for (let k = 0; k < n; k++) { const x = (k / (n - 1)) * 2 - 1, p = Math.min(1, Math.max(0, x)); c[k] = Math.max(0, 1 - Math.abs(p * (WT_FRAMES - 1) - i)); }
  return (bumpCurves[i] = c);
}

// --- node types --------------------------------------------------------------

export const CATEGORIES = {
  seq: { label: 'Sequence', color: '#ffb547' },
  source: { label: 'Sources', color: '#3fd8ff' },
  mod: { label: 'Modulation', color: '#a98bff' },
  fx: { label: 'Effects', color: '#ff5f9e' },
  util: { label: 'Utility', color: '#8fa3bf' },
  gsynth: { label: 'Game Synth', color: '#c6f432' },
  group: { label: 'Groups', color: '#5ef2d0' },
  out: { label: 'Output', color: '#4dffa6' },
};

export const POLY_AWARE = new Set(['adsr', 'filter', 'gain', 'distort', 'pan']);

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
    clipBeats: (P, bpm) => Math.max(1, Math.ceil(((P.at + (P.repeat - 1) * P.every + P.length) * bpm) / 60)),
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
    clipBeats: (P) => Math.max(1, Math.round(P.steps * parseFloat(P.rate))),
  },

  pianoroll: {
    title: 'Piano Roll', cat: 'seq', width: 260, widget: 'roll',
    desc: 'A looping clip of notes. Double-click the preview (or press Edit) to open the editor; record into it from MIDI or the keyboard.',
    outputs: [{ key: 'notes', type: 'notes', label: 'Notes' }],
    params: [
      { key: 'length', label: 'Clip beats', type: 'number', min: 1, max: 256, step: 1, def: 16 },
      { key: 'transpose', label: 'Transpose', type: 'number', min: -48, max: 48, step: 1, def: 0, unit: 'st' },
    ],
    initData: () => ({ notes: [
      { s: 0, l: 1, n: 60, v: 0.9 }, { s: 1, l: 1, n: 63, v: 0.8 }, { s: 2, l: 1, n: 67, v: 0.8 }, { s: 3, l: 1, n: 70, v: 0.8 },
    ] }),
    events(P, p0, p1, env, data) {
      const spb = 60 / env.bpm, clip = P.length * spb, out = [];
      for (let k = Math.max(0, Math.floor(p0 / clip)); k * clip < p1; k++) {
        for (const n of data.notes) {
          if (n.s >= P.length) continue;
          const t = k * clip + n.s * spb;
          if (t >= p0 && t < p1) out.push({ t, dur: n.l * spb, note: n.n + P.transpose, vel: n.v ?? 0.9 });
        }
      }
      return out;
    },
    clipBeats: (P) => P.length,
  },

  liveinput: {
    title: 'Live Input', cat: 'seq', width: 210,
    desc: 'Notes from a MIDI keyboard or the computer keyboard (toggle ⌨ in the top bar). Patch it like any sequencer.',
    outputs: [{ key: 'notes', type: 'notes', label: 'Notes' }],
    params: [
      { key: 'channel', label: 'MIDI ch', type: 'number', min: 0, max: 16, step: 1, def: 0, hint: '0 = any channel' },
      { key: 'octave', label: 'Octave', type: 'number', min: -4, max: 4, step: 1, def: 0 },
    ],
    events: () => [],
  },

  transpose: {
    title: 'Transpose', cat: 'seq', width: 190,
    desc: 'Shifts incoming notes and scales velocity / length.',
    inputs: [{ key: 'notes', type: 'notes', label: 'Notes' }],
    outputs: [{ key: 'notes', type: 'notes', label: 'Notes' }],
    params: [
      { key: 'semi', label: 'Semitones', type: 'number', min: -48, max: 48, step: 1, def: 0, unit: 'st' },
      { key: 'vel', label: 'Velocity ×', type: 'number', min: 0, max: 2, step: 0.01, def: 1 },
      { key: 'len', label: 'Length ×', type: 'number', min: 0.05, max: 4, step: 0.01, def: 1 },
    ],
    transform(P, evs) { return evs.map((e) => ({ ...e, note: e.note == null ? null : e.note + P.semi, vel: Math.min(1, e.vel * P.vel), dur: e.dur * P.len })); },
  },

  chord: {
    title: 'Chord', cat: 'seq', width: 200,
    desc: 'Turns each note into a chord. Needs a polyphonic destination (Voices > 1).',
    inputs: [{ key: 'notes', type: 'notes', label: 'Notes' }],
    outputs: [{ key: 'notes', type: 'notes', label: 'Notes' }],
    params: [
      { key: 'shape', label: 'Shape', type: 'select', options: [['0,4,7', 'major'], ['0,3,7', 'minor'], ['0,4,7,11', 'maj7'], ['0,3,7,10', 'min7'], ['0,4,7,10', 'dom7'], ['0,5,7', 'sus4'], ['0,7', 'power'], ['0,7,12', 'octaves'], ['0,3,6', 'dim']], def: '0,4,7' },
      { key: 'spread', label: 'Strum', type: 'number', min: 0, max: 0.2, step: 0.001, def: 0, unit: 's' },
    ],
    transform(P, evs) {
      const iv = P.shape.split(',').map(Number);
      return evs.flatMap((e) => (e.note == null ? [e] : iv.map((s, i) => ({ ...e, note: e.note + s, t: e.t + i * P.spread, dur: Math.max(0.001, e.dur - i * P.spread) }))));
    },
  },

  // ---------------------------------------------------------------- sources
  osc: {
    title: 'Oscillator', cat: 'source', width: 230, implicit: 'loop', voicesParam: true,
    desc: 'Band-limited oscillator with unison. Follows notes when connected; Sweep bends each note (falling = discharge, rising = charge).',
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
      { key: 'unison', label: 'Unison', type: 'number', min: 1, max: 7, step: 1, def: 1 },
      { key: 'spread', label: 'Spread', type: 'number', min: 0, max: 100, step: 0.1, def: 15, unit: 'ct' },
      VOICES,
      { key: 'gain', label: 'Level', type: 'number', min: 0, max: 1, step: 0.01, def: 0.5, mod: true },
    ],
    build(ctx, P, env, V) {
      const U = Math.max(1, P.unison | 0);
      const vs = voices(V, () => {
        const out = ctx.createGain(); out.gain.value = P.gain;
        const sum = ctx.createGain(); sum.gain.value = 1 / Math.sqrt(U); sum.connect(out);
        const oscs = voices(U, (u) => {
          const o = ctx.createOscillator();
          o.type = P.wave; o.frequency.value = P.freq * 2 ** P.octave;
          o.detune.value = P.detune + env.cents + (U > 1 ? (u / (U - 1) - 0.5) * 2 * P.spread : 0);
          o.connect(sum); return o;
        });
        return { out, oscs };
      });
      return {
        outputs: { out: vs.map((v) => v.out) },
        params: { freq: vs.map((v) => v.oscs.map((o) => o.frequency)), detune: vs.map((v) => v.oscs.map((o) => o.detune)), gain: vs.map((v) => v.out.gain) },
        start: (t) => vs.forEach((v) => v.oscs.forEach((o) => o.start(t))), stop: (t) => vs.forEach((v) => v.oscs.forEach((o) => o.stop(t))),
        note(ev) {
          const hz = Math.min(20000, (ev.note == null ? P.freq : mtof(ev.note)) * 2 ** P.octave);
          for (const o of vs[ev.voice || 0].oscs) pitchTo(o.frequency, hz, ev.t, P);
        },
        set(k, v, t) {
          if (k === 'wave') { vs.forEach((x) => x.oscs.forEach((o) => (o.type = v))); return true; }
          if (k === 'freq' || k === 'octave') { setp(vs.map((x) => x.oscs.map((o) => o.frequency)), P.freq * 2 ** P.octave, t); return true; }
          if (k === 'detune' || k === 'spread') {
            vs.forEach((x) => x.oscs.forEach((o, u) => setp(o.detune, P.detune + (U > 1 ? (u / (U - 1) - 0.5) * 2 * P.spread : 0), t)));
            return true;
          }
          if (k === 'unison' || k === 'voices') return null;
          return false;
        },
      };
    },
  },

  wavetable: {
    title: 'Wavetable', cat: 'source', width: 240, implicit: 'loop', voicesParam: true, widget: 'wavetable',
    desc: 'Morphs smoothly across 8 single-cycle frames. Patch an LFO or envelope into Position for movement. "From sample" slices frames out of an imported sample.',
    inputs: [{ key: 'notes', type: 'notes', label: 'Notes' }],
    outputs: [{ key: 'out', type: 'audio', label: 'Out' }],
    params: [
      { key: 'table', label: 'Table', type: 'select', options: [['basic', 'sine→square'], ['pwm', 'pulse width'], ['vocal', 'vocal formant'], ['organ', 'organ drawbars'], ['digital', 'digital'], ['sample', 'from sample']], def: 'basic' },
      { key: 'sample', label: 'Sample', type: 'sample', def: '' },
      { key: 'position', label: 'Position', type: 'number', min: 0, max: 1, step: 0.001, def: 0.3, mod: true },
      { key: 'freq', label: 'Freq', type: 'number', min: 1, max: 20000, step: 0.1, def: 220, unit: 'Hz', curve: 'log', mod: true },
      { key: 'octave', label: 'Octave', type: 'number', min: -4, max: 4, step: 1, def: 0 },
      { key: 'detune', label: 'Detune', type: 'number', min: -1200, max: 1200, step: 1, def: 0, unit: 'ct', mod: true },
      { key: 'glide', label: 'Glide', type: 'number', min: 0, max: 2, step: 0.001, def: 0, unit: 's' },
      { ...VOICES, def: 4 },
      { key: 'gain', label: 'Level', type: 'number', min: 0, max: 1, step: 0.01, def: 0.4, mod: true },
    ],
    build(ctx, P, env, V) {
      const buf = P.table === 'sample' ? env.buffers.get(P.sample) : null;
      const frames = buf ? sampleFrames(buf) : harmonicFrames(P.table === 'sample' ? 'basic' : P.table);
      const waves = frames.map(([re, im]) => ctx.createPeriodicWave(re, im));
      const pos = ctx.createConstantSource(); pos.offset.value = P.position;
      const curves = waves.map((_, i) => { const s = ctx.createWaveShaper(); s.curve = bump(i); pos.connect(s); return s; });
      const vs = voices(V, () => {
        const out = ctx.createGain(); out.gain.value = P.gain;
        const oscs = waves.map((w, i) => {
          const o = ctx.createOscillator(), g = ctx.createGain();
          o.setPeriodicWave(w); o.frequency.value = P.freq * 2 ** P.octave; o.detune.value = P.detune + env.cents;
          g.gain.value = 0; curves[i].connect(g.gain); o.connect(g).connect(out);
          return o;
        });
        return { out, oscs };
      });
      return {
        outputs: { out: vs.map((v) => v.out) },
        params: { position: pos.offset, freq: vs.map((v) => v.oscs.map((o) => o.frequency)), detune: vs.map((v) => v.oscs.map((o) => o.detune)), gain: vs.map((v) => v.out.gain) },
        start: (t) => { pos.start(t); vs.forEach((v) => v.oscs.forEach((o) => o.start(t))); },
        stop: (t) => { pos.stop(t); vs.forEach((v) => v.oscs.forEach((o) => o.stop(t))); },
        note(ev) {
          const hz = Math.min(20000, (ev.note == null ? P.freq : mtof(ev.note)) * 2 ** P.octave);
          for (const o of vs[ev.voice || 0].oscs) pitchTo(o.frequency, hz, ev.t, { glide: P.glide });
        },
        set(k, v, t) {
          if (k === 'freq' || k === 'octave') { setp(vs.map((x) => x.oscs.map((o) => o.frequency)), P.freq * 2 ** P.octave, t); return true; }
          if (k === 'table' || k === 'sample' || k === 'voices') return null;
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
    build(ctx, P, env) {
      const src = ctx.createBufferSource(), out = ctx.createGain();
      src.buffer = noiseBuffer(ctx, P.color, P.seed + env.variant * 1013); src.loop = true; out.gain.value = P.gain;
      src.connect(out);
      return { outputs: { out }, params: { gain: out.gain }, start: (t) => src.start(t), stop: (t) => src.stop(t), set: (k) => (k === 'gain' ? false : null) };
    },
  },

  sampler: {
    title: 'Sampler', cat: 'source', width: 250, widget: 'wave', implicit: 'loop', voicesParam: true,
    desc: 'Plays an imported sample. Notes repitch it relative to Root; in Slices mode each note above Root plays the next slice (set slices in the Sample editor). Unconnected, it plays once per loop.',
    inputs: [{ key: 'notes', type: 'notes', label: 'Notes' }],
    outputs: [{ key: 'out', type: 'audio', label: 'Out' }],
    params: [
      { key: 'sample', label: 'Sample', type: 'sample', def: '' },
      { key: 'mode', label: 'Mode', type: 'select', options: [['pitch', 'pitched'], ['slices', 'slices']], def: 'pitch' },
      { key: 'slices', label: 'Slices', type: 'number', min: 1, max: 64, step: 1, def: 8, hint: 'Used when the sample has no slice markers' },
      { key: 'root', label: 'Root', type: 'note', min: 0, max: 127, def: 60 },
      { key: 'pitch', label: 'Pitch', type: 'number', min: -48, max: 48, step: 0.01, def: 0, unit: 'st' },
      { key: 'start', label: 'Start', type: 'number', min: 0, max: 600, step: 0.001, def: 0, unit: 's' },
      { key: 'attack', label: 'Fade in', type: 'number', min: 0, max: 2, step: 0.001, def: 0.002, unit: 's' },
      { key: 'release', label: 'Release', type: 'number', min: 0.001, max: 5, step: 0.001, def: 0.02, unit: 's', curve: 'log' },
      { key: 'gain', label: 'Level', type: 'number', min: 0, max: 2, step: 0.01, def: 1, mod: true },
      { ...VOICES, def: 8 },
      { key: 'gate', label: 'Gate', type: 'bool', def: false },
      { key: 'loop', label: 'Loop', type: 'bool', def: false },
      { key: 'reverse', label: 'Reverse', type: 'bool', def: false },
    ],
    build(ctx, P, env, V) {
      const outs = voices(V, () => { const g = ctx.createGain(); g.gain.value = P.gain; return g; });
      const live = new Map();
      return {
        outputs: { out: outs }, params: { gain: outs.map((o) => o.gain) },
        note(ev) {
          let buf = env.buffers.get(P.sample);
          if (!buf) return;
          const meta = env.sampleMeta.get(P.sample) || {};
          if (P.reverse) buf = reversed(buf);
          const src = ctx.createBufferSource(), g = ctx.createGain();
          src.buffer = buf;
          let offset = P.start + (ev.offset || 0), end = null;
          let semis = P.pitch;
          if (P.mode === 'slices' && ev.note != null) {
            const marks = meta.slices && meta.slices.length ? [0, ...meta.slices.filter((x) => x > 0 && x < buf.duration)] : Array.from({ length: P.slices }, (_, i) => (i * buf.duration) / P.slices);
            const idx = (((ev.note - P.root) % marks.length) + marks.length) % marks.length;
            offset = marks[idx] + (ev.offset || 0); end = idx + 1 < marks.length ? marks[idx + 1] : buf.duration;
          } else semis += ev.note == null ? 0 : ev.note - P.root;
          src.playbackRate.value = 2 ** (semis / 12);
          src.detune.value = env.cents;
          if (P.loop) {
            src.loop = true;
            if (meta.loop) { src.loopStart = meta.loop.start; src.loopEnd = meta.loop.end; }
          }
          const vel = ev.vel ?? 1, t = ev.t;
          if (P.attack > 0) { g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(vel, t + P.attack); } else g.gain.value = vel;
          src.connect(g).connect(outs[ev.voice || 0] || outs[0]);
          offset = Math.max(0, Math.min(offset, buf.duration - 0.001));
          src.start(t, offset);
          const rate = 2 ** (semis / 12);
          let stopAt = null;
          if (end != null) stopAt = t + (end - offset) / rate;
          if (P.gate || P.loop || ev.gate) stopAt = stopAt == null ? t + ev.dur : Math.min(stopAt, t + ev.dur);
          if (stopAt != null && ev.dur < 1e4) { g.gain.setTargetAtTime(0, stopAt, P.release / 3); src.stop(stopAt + P.release * 2 + 0.02); }
          const rec = { src, g };
          live.set(src, rec); src.onended = () => live.delete(src);
          if (ev.id != null) rec.id = ev.id;
        },
        release(ev, t) {
          if (!(P.gate || P.loop || P.mode === 'slices')) return;
          for (const [src, r] of live) if (r.id === ev.id) { r.g.gain.cancelScheduledValues(t); r.g.gain.setTargetAtTime(0, t, P.release / 3); try { src.stop(t + P.release * 2 + 0.02); } catch {} }
        },
        stop(t) { for (const [s] of live) { try { s.stop(t); } catch {} } },
        set: (k) => (k === 'gain' ? false : k === 'voices' ? null : true),
      };
    },
  },

  granular: {
    title: 'Granular', cat: 'source', width: 240, widget: 'wave',
    desc: 'Clouds of tiny grains read from a sample. Freeze a moment, smear it into a pad, or scrub it with an LFO on Position.',
    inputs: [{ key: 'notes', type: 'notes', label: 'Notes' }],
    outputs: [{ key: 'out', type: 'audio', label: 'Out' }],
    params: [
      { key: 'sample', label: 'Sample', type: 'sample', def: '' },
      { key: 'position', label: 'Position', type: 'number', min: 0, max: 1, step: 0.001, def: 0.3, mod: true },
      { key: 'spray', label: 'Spray', type: 'number', min: 0, max: 1, step: 0.001, def: 0.05, mod: true },
      { key: 'size', label: 'Grain size', type: 'number', min: 0.005, max: 1, step: 0.001, def: 0.09, unit: 's', curve: 'log', mod: true },
      { key: 'density', label: 'Density', type: 'number', min: 1, max: 300, step: 0.1, def: 40, unit: '/s', curve: 'log', mod: true },
      { key: 'pitch', label: 'Pitch', type: 'number', min: -36, max: 36, step: 0.01, def: 0, unit: 'st', mod: true },
      { key: 'root', label: 'Root', type: 'note', min: 0, max: 127, def: 60 },
      { key: 'stereo', label: 'Stereo', type: 'number', min: 0, max: 1, step: 0.01, def: 0.6 },
      { key: 'seed', label: 'Seed', type: 'number', min: 1, max: 9999, step: 1, def: 7 },
      { key: 'gain', label: 'Level', type: 'number', min: 0, max: 2, step: 0.01, def: 0.8, mod: true },
    ],
    build(ctx, P, env) {
      const buf = env.buffers.get(P.sample);
      const channels = buf ? Array.from({ length: Math.min(2, buf.numberOfChannels) }, (_, c) => buf.getChannelData(c).slice()) : [new Float32Array(1)];
      const w = new AudioWorkletNode(ctx, 'na-granular', { numberOfInputs: 0, outputChannelCount: [2], processorOptions: { channels, rate: buf ? buf.sampleRate : ctx.sampleRate, seed: P.seed + env.variant * 31 } });
      const pm = (k) => w.parameters.get(k);
      for (const k of ['position', 'spray', 'size', 'density', 'pitch']) pm(k).value = P[k];
      pm('stereo').value = P.stereo;
      const out = ctx.createGain(); out.gain.value = P.gain; w.connect(out);
      return {
        outputs: { out }, params: { position: pm('position'), spray: pm('spray'), size: pm('size'), density: pm('density'), pitch: pm('pitch'), gain: out.gain },
        note(ev) { if (ev.note != null) { pm('pitch').cancelScheduledValues(ev.t); pm('pitch').setValueAtTime(P.pitch + ev.note - P.root, ev.t); } },
        set: (k, v) => { if (k === 'stereo') { pm('stereo').value = v; return true; } return k === 'sample' || k === 'seed' ? null : false; },
      };
    },
  },

  // ---------------------------------------------------------------- modulation
  adsr: {
    title: 'Envelope', cat: 'mod', width: 230, widget: 'adsr', implicit: 'hold',
    desc: 'ADSR. Gates audio passing through (VCA) and outputs the envelope as CV. Polyphonic when fed by a polyphonic source. Unconnected notes: fires at 0 for Hold.',
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
    build(ctx, P, env, V) {
      const vs = voices(V, () => {
        const vca = ctx.createGain(); vca.gain.value = 0;
        const e = ctx.createConstantSource(); e.offset.value = 0;
        const cv = ctx.createGain(); cv.gain.value = P.amount;
        e.connect(vca.gain); e.connect(cv);
        return { vca, e, cv };
      });
      return {
        inputs: { in: vs.map((v) => v.vca) }, outputs: { out: vs.map((v) => v.vca), cv: vs.map((v) => v.cv) }, params: { amount: vs.map((v) => v.cv.gain) },
        start: (t) => vs.forEach((v) => v.e.start(t)), stop: (t) => vs.forEach((v) => v.e.stop(t)),
        note(ev) {
          const o = vs[ev.voice || 0].e.offset;
          const pk = 1 - P.velsens + P.velsens * (ev.vel ?? 1);
          const { t } = ev;
          o.cancelScheduledValues(t);
          o.setTargetAtTime(pk, t, P.a / 3);
          o.setTargetAtTime(pk * P.s, t + P.a, P.d / 3);
          if (ev.dur < 1e4) o.setTargetAtTime(0, t + Math.max(ev.dur, 0.001), P.r / 3);
        },
        release(ev, t) { const o = vs[ev.voice || 0].e.offset; o.cancelScheduledValues(t); o.setTargetAtTime(0, t, P.r / 3); },
        set: () => false,
      };
    },
  },

  lfo: {
    title: 'LFO', cat: 'mod', width: 210,
    desc: 'Low-frequency oscillator. Output = wave × Depth + Offset; patch it into any ◆ parameter socket. Sync locks the rate to the tempo.',
    outputs: [{ key: 'out', type: 'audio', label: 'Out' }],
    params: [
      { key: 'wave', label: 'Wave', type: 'select', options: WAVES.map((w) => [w, w]), def: 'sine' },
      { key: 'sync', label: 'Sync', type: 'select', options: [['0', 'free'], ['4', '1 bar'], ['2', '1/2'], ['1', '1/4'], ['0.5', '1/8'], ['0.25', '1/16'], ['8', '2 bars'], ['16', '4 bars']], def: '0' },
      { key: 'rate', label: 'Rate', type: 'number', min: 0.01, max: 200, step: 0.01, def: 4, unit: 'Hz', curve: 'log', mod: true },
      { key: 'depth', label: 'Depth', type: 'number', min: 0, max: 10000, step: 0.01, def: 50, curve: 'log', mod: true },
      { key: 'offset', label: 'Offset', type: 'number', min: -10000, max: 10000, step: 0.01, def: 0, mod: true },
    ],
    build(ctx, P, env) {
      const osc = ctx.createOscillator(), depth = ctx.createGain(), off = ctx.createConstantSource(), out = ctx.createGain();
      const rate = () => (P.sync !== '0' ? env.bpm / 60 / parseFloat(P.sync) : P.rate);
      osc.type = P.wave; osc.frequency.value = rate(); depth.gain.value = P.depth; off.offset.value = P.offset;
      osc.connect(depth).connect(out); off.connect(out);
      return {
        outputs: { out }, params: { rate: osc.frequency, depth: depth.gain, offset: off.offset },
        start: (t) => { osc.start(t); off.start(t); }, stop: (t) => { osc.stop(t); off.stop(t); },
        set: (k, v, t) => { if (k === 'wave') { osc.type = v; return true; } if (k === 'sync' || k === 'rate') { setp(osc.frequency, rate(), t); return true; } return false; },
      };
    },
  },

  random: {
    title: 'Random', cat: 'mod', width: 210,
    desc: 'A random control value between Min and Max. "Per render" picks one value per export variant (different every variant, same every play). "Per note" re-rolls on each incoming note.',
    inputs: [{ key: 'notes', type: 'notes', label: 'Notes' }],
    outputs: [{ key: 'out', type: 'audio', label: 'Out' }],
    params: [
      { key: 'mode', label: 'Mode', type: 'select', options: [['render', 'per render'], ['note', 'per note']], def: 'render' },
      { key: 'min', label: 'Min', type: 'number', min: -10000, max: 10000, step: 0.01, def: -50 },
      { key: 'max', label: 'Max', type: 'number', min: -10000, max: 10000, step: 0.01, def: 50 },
      { key: 'seed', label: 'Seed', type: 'number', min: 1, max: 9999, step: 1, def: 11 },
    ],
    build(ctx, P, env) {
      const r = rng(P.seed * 9973 + env.variant * 7919 + (env.live ? Date.now() & 0xffff : 0));
      const roll = () => P.min + r() * (P.max - P.min);
      const c = ctx.createConstantSource(); c.offset.value = P.mode === 'render' ? (env.variant ? roll() : (P.min + P.max) / 2) : roll();
      return {
        outputs: { out: c }, start: (t) => c.start(t), stop: (t) => c.stop(t),
        note(ev) { if (P.mode === 'note') c.offset.setValueAtTime(roll(), ev.t); },
        set: (k, v, t) => { if (P.mode === 'render') setp(c.offset, env.variant ? roll() : (P.min + P.max) / 2, t); return true; },
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
    desc: 'Biquad filter, cascadable to 48 dB/oct. Polyphonic: each voice gets its own filter, so a poly envelope on Cutoff works per note.',
    inputs: [{ key: 'in', type: 'audio', label: 'In' }],
    outputs: [{ key: 'out', type: 'audio', label: 'Out' }],
    params: [
      { key: 'type', label: 'Type', type: 'select', options: ['lowpass', 'highpass', 'bandpass', 'notch', 'peaking', 'lowshelf', 'highshelf', 'allpass'].map((x) => [x, x]), def: 'lowpass' },
      { key: 'cutoff', label: 'Cutoff', type: 'number', min: 20, max: 20000, step: 1, def: 2400, unit: 'Hz', curve: 'log', mod: true },
      { key: 'q', label: 'Resonance', type: 'number', min: 0.1, max: 30, step: 0.01, def: 0.8, curve: 'log', mod: true },
      { key: 'gain', label: 'Gain', type: 'number', min: -24, max: 24, step: 0.1, def: 0, unit: 'dB', mod: true },
      { key: 'slope', label: 'Slope', type: 'select', options: [['1', '12 dB'], ['2', '24 dB'], ['4', '48 dB']], def: '1' },
    ],
    build(ctx, P, env, V) {
      const n = parseInt(P.slope, 10) || 1;
      const vs = voices(V, () => {
        const fs = voices(n, () => { const f = ctx.createBiquadFilter(); f.type = P.type; f.frequency.value = P.cutoff; f.Q.value = P.q; f.gain.value = P.gain; return f; });
        for (let i = 1; i < n; i++) fs[i - 1].connect(fs[i]);
        return fs;
      });
      const all = vs.flat();
      return {
        inputs: { in: vs.map((f) => f[0]) }, outputs: { out: vs.map((f) => f[n - 1]) },
        params: { cutoff: vs.map((f) => f.map((x) => x.frequency)), q: vs.map((f) => f.map((x) => x.Q)), gain: vs.map((f) => f.map((x) => x.gain)) },
        set(k, v) { if (k === 'type') { all.forEach((f) => (f.type = v)); return true; } return k === 'slope' ? null : false; },
      };
    },
  },

  delay: {
    title: 'Delay', cat: 'fx', width: 220,
    desc: 'Feedback echo with a damped loop — tape/space-echo flavour. Sync locks the time to the tempo.',
    inputs: [{ key: 'in', type: 'audio', label: 'In' }],
    outputs: [{ key: 'out', type: 'audio', label: 'Out' }],
    params: [
      { key: 'sync', label: 'Sync', type: 'select', options: [['0', 'free'], ['1', '1/4'], ['0.75', '1/8.'], ['0.5', '1/8'], ['0.3333333', '1/8T'], ['0.25', '1/16'], ['1.5', '1/4.'], ['2', '1/2']], def: '0' },
      { key: 'time', label: 'Time', type: 'number', min: 0.001, max: 4, step: 0.001, def: 0.27, unit: 's', curve: 'log', mod: true },
      { key: 'feedback', label: 'Feedback', type: 'number', min: 0, max: 0.98, step: 0.01, def: 0.35, mod: true },
      { key: 'damp', label: 'Damping', type: 'number', min: 200, max: 20000, step: 1, def: 2200, unit: 'Hz', curve: 'log', mod: true },
      { key: 'mix', label: 'Mix', type: 'number', min: 0, max: 1, step: 0.01, def: 0.35, mod: true },
    ],
    build(ctx, P, env) {
      const inp = ctx.createGain(), out = ctx.createGain(), dry = ctx.createGain(), wet = ctx.createGain();
      const d = ctx.createDelay(5), fb = ctx.createGain(), lp = ctx.createBiquadFilter();
      const time = () => (P.sync !== '0' ? Math.min(4.9, (60 / env.bpm) * parseFloat(P.sync)) : P.time);
      d.delayTime.value = time(); fb.gain.value = P.feedback; lp.frequency.value = P.damp; wet.gain.value = P.mix; dry.gain.value = 1 - P.mix;
      inp.connect(dry).connect(out); inp.connect(d); d.connect(lp).connect(fb).connect(d); d.connect(wet).connect(out);
      return {
        inputs: { in: inp }, outputs: { out }, params: { time: d.delayTime, feedback: fb.gain, damp: lp.frequency, mix: wet.gain },
        set(k, v, t) {
          if (k === 'mix') { setp(wet.gain, v, t); setp(dry.gain, 1 - v, t); return true; }
          if (k === 'sync' || k === 'time') { setp(d.delayTime, time(), t); return true; }
          return false;
        },
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

  chorus: {
    title: 'Chorus', cat: 'fx', width: 210,
    desc: 'Stereo chorus: two modulated delays panned apart. Widens pads and leads.',
    inputs: [{ key: 'in', type: 'audio', label: 'In' }],
    outputs: [{ key: 'out', type: 'audio', label: 'Out' }],
    params: [
      { key: 'rate', label: 'Rate', type: 'number', min: 0.05, max: 10, step: 0.01, def: 0.8, unit: 'Hz', curve: 'log' },
      { key: 'depth', label: 'Depth', type: 'number', min: 0, max: 0.02, step: 0.0001, def: 0.004, unit: 's' },
      { key: 'mix', label: 'Mix', type: 'number', min: 0, max: 1, step: 0.01, def: 0.5 },
    ],
    build(ctx, P) {
      const inp = ctx.createGain(), out = ctx.createGain(), dry = ctx.createGain(); dry.gain.value = 1 - P.mix * 0.5;
      inp.connect(dry).connect(out);
      const parts = [-1, 1].map((side, i) => {
        const d = ctx.createDelay(0.1), lfo = ctx.createOscillator(), amt = ctx.createGain(), pan = ctx.createStereoPanner(), wet = ctx.createGain();
        d.delayTime.value = 0.012 + i * 0.004; lfo.frequency.value = P.rate * (1 + i * 0.13); amt.gain.value = P.depth; pan.pan.value = side * 0.8; wet.gain.value = P.mix;
        lfo.connect(amt).connect(d.delayTime); inp.connect(d).connect(wet).connect(pan).connect(out);
        return { lfo, amt, wet };
      });
      return {
        inputs: { in: inp }, outputs: { out },
        start: (t) => parts.forEach((p) => p.lfo.start(t)), stop: (t) => parts.forEach((p) => p.lfo.stop(t)),
        set(k, v, t) {
          parts.forEach((p, i) => { if (k === 'rate') setp(p.lfo.frequency, v * (1 + i * 0.13), t); if (k === 'depth') setp(p.amt.gain, v, t); if (k === 'mix') setp(p.wet.gain, v, t); });
          if (k === 'mix') setp(dry.gain, 1 - v * 0.5, t);
          return true;
        },
      };
    },
  },

  distort: {
    title: 'Distortion', cat: 'fx', width: 210,
    desc: 'Waveshaper, 4× oversampled. Soft, hard, asymmetric or wavefold. Polyphonic.',
    inputs: [{ key: 'in', type: 'audio', label: 'In' }],
    outputs: [{ key: 'out', type: 'audio', label: 'Out' }],
    params: [
      { key: 'mode', label: 'Mode', type: 'select', options: [['soft', 'soft'], ['hard', 'hard'], ['asym', 'asym'], ['fold', 'fold']], def: 'soft' },
      { key: 'drive', label: 'Drive', type: 'number', min: 0.1, max: 50, step: 0.01, def: 3, curve: 'log' },
      { key: 'mix', label: 'Mix', type: 'number', min: 0, max: 1, step: 0.01, def: 1 },
      { key: 'level', label: 'Output', type: 'number', min: 0, max: 2, step: 0.01, def: 0.8, mod: true },
    ],
    build(ctx, P, env, V) {
      const vs = voices(V, () => {
        const inp = ctx.createGain(), sh = ctx.createWaveShaper(), dry = ctx.createGain(), wet = ctx.createGain(), out = ctx.createGain();
        sh.curve = shaperCurve(P.mode, P.drive); sh.oversample = '4x'; wet.gain.value = P.mix; dry.gain.value = 1 - P.mix; out.gain.value = P.level;
        inp.connect(sh).connect(wet).connect(out); inp.connect(dry).connect(out);
        return { inp, sh, dry, wet, out };
      });
      return {
        inputs: { in: vs.map((v) => v.inp) }, outputs: { out: vs.map((v) => v.out) }, params: { level: vs.map((v) => v.out.gain) },
        set(k, v, t) {
          if (k === 'mode' || k === 'drive') { vs.forEach((x) => (x.sh.curve = shaperCurve(P.mode, P.drive))); return true; }
          if (k === 'mix') { vs.forEach((x) => { setp(x.wet.gain, v, t); setp(x.dry.gain, 1 - v, t); }); return true; }
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
    desc: 'Amplifier. Patch audio into the Gain socket for tremolo or ring modulation. Polyphonic.',
    inputs: [{ key: 'in', type: 'audio', label: 'In' }],
    outputs: [{ key: 'out', type: 'audio', label: 'Out' }],
    params: [{ key: 'gain', label: 'Gain', type: 'number', min: 0, max: 4, step: 0.01, def: 1, mod: true }],
    build(ctx, P, env, V) { const gs = voices(V, () => { const g = ctx.createGain(); g.gain.value = P.gain; return g; }); return { inputs: { in: gs }, outputs: { out: gs }, params: { gain: gs.map((g) => g.gain) } }; },
  },

  mixer: {
    title: 'Mixer', cat: 'util', width: 210,
    desc: 'Four channel mixer with level and pan per channel.',
    inputs: [1, 2, 3, 4].map((i) => ({ key: 'in' + i, type: 'audio', label: 'In ' + i })),
    outputs: [{ key: 'out', type: 'audio', label: 'Out' }],
    params: [1, 2, 3, 4].flatMap((i) => [
      { key: 'l' + i, label: 'Level ' + i, type: 'number', min: 0, max: 2, step: 0.01, def: 0.8, mod: true },
      { key: 'p' + i, label: 'Pan ' + i, type: 'number', min: -1, max: 1, step: 0.01, def: 0, mod: true },
    ]),
    build(ctx, P) {
      const out = ctx.createGain(), inputs = {}, params = {};
      for (let i = 1; i <= 4; i++) {
        const g = ctx.createGain(), p = ctx.createStereoPanner();
        g.gain.value = P['l' + i]; p.pan.value = P['p' + i]; g.connect(p).connect(out);
        inputs['in' + i] = g; params['l' + i] = g.gain; params['p' + i] = p.pan;
      }
      return { inputs, outputs: { out }, params };
    },
  },

  pan: {
    title: 'Pan', cat: 'util', width: 190,
    desc: 'Stereo panner. (Mono exports fold this back to centre.)',
    inputs: [{ key: 'in', type: 'audio', label: 'In' }],
    outputs: [{ key: 'out', type: 'audio', label: 'Out' }],
    params: [{ key: 'pan', label: 'Pan', type: 'number', min: -1, max: 1, step: 0.01, def: 0, mod: true }],
    build(ctx, P, env, V) { const ps = voices(V, () => { const p = ctx.createStereoPanner(); p.pan.value = P.pan; return p; }); return { inputs: { in: ps }, outputs: { out: ps }, params: { pan: ps.map((p) => p.pan) } }; },
  },

  scope: {
    title: 'Scope', cat: 'util', width: 240, widget: 'scope',
    desc: 'Pass-through oscilloscope / spectrum.',
    inputs: [{ key: 'in', type: 'audio', label: 'In' }],
    outputs: [{ key: 'out', type: 'audio', label: 'Out' }],
    params: [{ key: 'mode', label: 'View', type: 'select', options: [['wave', 'waveform'], ['spectrum', 'spectrum']], def: 'wave' }],
    build(ctx) {
      const g = ctx.createGain(), a = ctx.createAnalyser(); a.fftSize = 2048; g.connect(a);
      return { inputs: { in: g }, outputs: { out: g }, analyser: a, set: () => true };
    },
  },

  // ---------------------------------------------------------------- groups
  group: {
    title: 'Group', cat: 'group', width: 220, widget: 'group',
    desc: 'A collapsed patch. Tab or double-click the header to go inside; its Group In/Out nodes define the sockets.',
    params: [{ key: 'name', label: 'Name', type: 'text', def: 'Group' }],
  },
  group_in: {
    title: 'Group In', cat: 'group', width: 170, internal: true,
    desc: 'Signals coming into the group. Drag a wire from + to make a new socket.',
    params: [],
  },
  group_out: {
    title: 'Group Out', cat: 'group', width: 170, internal: true,
    desc: 'Signals leaving the group. Drop a wire on + to make a new socket.',
    params: [],
  },

  ...GS_TYPES,

  // ---------------------------------------------------------------- output
  output: {
    title: 'Output', cat: 'out', width: 240, widget: 'output',
    desc: 'One exported cue. Name becomes the .wav filename. Several outputs = a whole SFX bank (zip / folder). Bus picks the game bus it plays on (for monitoring and the manifest).',
    inputs: [{ key: 'in', type: 'audio', label: 'In' }],
    params: [
      { key: 'name', label: 'Cue name', type: 'text', def: 'cue' },
      { key: 'bus', label: 'Game bus', type: 'select', options: [['SFX', 'SFX'], ['SFXFar', 'SFXFar'], ['Cockpit', 'Cockpit'], ['UI', 'UI'], ['Music', 'Music'], ['Master', 'Master']], def: 'SFX' },
      { key: 'volume', label: 'Volume', type: 'number', min: -60, max: 12, step: 0.1, def: 0, unit: 'dB' },
      { key: 'length', label: 'Length', type: 'number', min: 0, max: 600, step: 0.001, def: 0, unit: 's', hint: '0 = project / song length' },
      { key: 'tail', label: 'Tail', type: 'number', min: 0, max: 20, step: 0.01, def: 0.5, unit: 's' },
      { key: 'loop', label: 'Loop (smpl)', type: 'bool', def: false },
      { key: 'seam', label: 'Seam fade', type: 'number', min: 0, max: 1, step: 0.001, def: 0.12, unit: 's' },
      { key: 'variants', label: 'Variants', type: 'number', min: 1, max: 16, step: 1, def: 1, hint: 'Export N takes: noise seeds, Random nodes and pitch differ per take' },
      { key: 'vpitch', label: 'Var. pitch', type: 'number', min: 0, max: 400, step: 1, def: 40, unit: 'ct', hint: 'Max random detune per variant (variant 1 is untouched)' },
      { key: 'mute', label: 'Mute', type: 'bool', def: false },
    ],
    build(ctx, P) {
      const g = ctx.createGain(); g.gain.value = P.mute ? 0 : dbToGain(P.volume);
      return {
        inputs: { in: g }, sink: g,
        set(k, v, t) { if (k === 'volume' || k === 'mute') setp(g.gain, P.mute ? 0 : dbToGain(P.volume), t); return k === 'bus' ? null : true; },
      };
    },
  },
};

// --- socket helpers (groups have per-instance sockets) ---------------------------

export const NEW_SOCKET = { key: '__new', type: 'any', label: '+' };

export function defaultParams(type) {
  const p = {};
  for (const s of TYPES[type].params) p[s.key] = s.def;
  return p;
}

export function outputsOf(node, parent) {
  if (node.type === 'group') return node.data.outputs || [];
  if (node.type === 'group_in') return [...((parent && parent.data.inputs) || []), NEW_SOCKET];
  return TYPES[node.type].outputs || [];
}

export function inputsOf(node, parent) {
  if (node.type === 'group') return node.data.inputs || [];
  if (node.type === 'group_out') return [...((parent && parent.data.outputs) || []), NEW_SOCKET];
  const T = TYPES[node.type];
  return [...(T.inputs || []), ...T.params.filter((p) => p.mod).map((p) => ({ key: 'p:' + p.key, type: 'audio', label: p.label, param: p.key }))];
}

/** Input sockets for a type (no group context) — used by the add menu. */
export function inputSockets(type) { return inputsOf({ type, data: {} }); }

// Synth Cue: plays the buffer its Game Synth chain bakes (see gamesynth.js / engine.gsBufferFor).
TYPES.gs_out.voicesParam = true;
TYPES.gs_out.build = function (ctx, P, env, V) {
  const outs = voices(V, () => { const g = ctx.createGain(); g.gain.value = P.gain; return g; });
  const buf = env.gsBuffer(env.id, P);
  const live = new Set();
  return {
    outputs: { out: outs }, params: { gain: outs.map((o) => o.gain) },
    note(ev) {
      const src = ctx.createBufferSource(), g = ctx.createGain();
      src.buffer = buf; src.loop = !!P.loop;
      src.playbackRate.value = 2 ** (((ev.note == null ? P.root : ev.note) - P.root) / 12);
      src.detune.value = env.cents;
      g.gain.value = ev.vel ?? 1;
      src.connect(g).connect(outs[ev.voice || 0] || outs[0]);
      src.start(ev.t);
      if (P.loop || ev.gate) { if (ev.dur < 1e4) { g.gain.setTargetAtTime(0, ev.t + ev.dur, 0.01); src.stop(ev.t + ev.dur + 0.06); } }
      live.add(src); src.onended = () => live.delete(src);
      src._id = ev.id;
    },
    release(ev, t) { if (P.loop) for (const s of live) if (s._id === ev.id) try { s.stop(t + 0.02); } catch {} },
    stop(t) { for (const s of live) try { s.stop(t); } catch {} },
    set: (k) => (k === 'gain' ? false : null),
  };
};

/** One cycle of a Wavetable node's current (morphed) shape, for the node preview. */
export function wavetablePreview(P, buffers, N = 128) {
  const buf = P.table === 'sample' ? buffers.get(P.sample) : null;
  const key = (buf ? 'S' + P.sample : P.table);
  const frames = PREVIEW_CACHE.get(key) || (() => { const f = buf ? sampleFrames(buf) : harmonicFrames(P.table === 'sample' ? 'basic' : P.table); PREVIEW_CACHE.set(key, f); return f; })();
  const out = new Float32Array(N);
  let peak = 0;
  for (let i = 0; i < WT_FRAMES; i++) {
    const w = Math.max(0, 1 - Math.abs(P.position * (WT_FRAMES - 1) - i));
    if (!w) continue;
    const [re, im] = frames[i];
    for (let s = 0; s < N; s++) {
      let v = 0;
      for (let h = 1; h < WT_HARM; h++) if (re[h] || im[h]) { const ph = (2 * Math.PI * h * s) / N; v += re[h] * Math.cos(ph) + im[h] * Math.sin(ph); }
      out[s] += v * w;
    }
  }
  for (const v of out) peak = Math.max(peak, Math.abs(v));
  if (peak > 0) for (let s = 0; s < N; s++) out[s] /= peak;
  return out;
}
const PREVIEW_CACHE = new Map();
