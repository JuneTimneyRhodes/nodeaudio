// Starter projects.

import { emptyProject, makeNode, uid } from './project.js';

function graph(name, setup) {
  const p = emptyProject();
  p.name = name;
  const N = (type, x, y, params = {}, data) => {
    const n = makeNode(type, x, y);
    Object.assign(n.params, params);
    if (data) n.data = { ...n.data, ...data };
    p.nodes.push(n);
    return n;
  };
  const L = (a, ap, b, bp) => p.links.push({ id: uid('l'), from: { node: a.id, port: ap }, to: { node: b.id, port: bp } });
  setup(N, L, p);
  return p;
}

/** 32 steps from a 16-step pattern: `on` step indexes, optional semitones / velocities by index. */
const steps = (on, semis = {}, vels = {}) => Array.from({ length: 32 }, (_, i) => ({ on: on.includes(i % 16), semi: semis[i % 16] || 0, vel: vels[i % 16] ?? 1 }));
const MUSIC = { sampleRate: 44100, channels: 2, bitDepth: 16, normalize: true, normMode: 'lufs', lufs: -14, peakDb: -1, trim: false };

/** Chord notes for a piano roll: [[startBeat, lengthBeats, [notes...]], ...] */
const chordNotes = (list, v = 0.7) => list.flatMap(([s, l, ns]) => ns.map((n) => ({ s, l, n, v })));

/** Arrangement tracks: [[node, [[startBeat, lenBeats, offset?], ...]], ...] */
function arrange(p, bars, tracks) {
  p.song = { enabled: true, bars, tracks: [], clips: [] };
  tracks.forEach(([node, clips], i) => {
    const id = 't' + i;
    p.song.tracks.push({ id, node: node.id, mute: false });
    clips.forEach(([start, len, offset = 0], j) => p.song.clips.push({ id: `c${i}_${j}`, track: id, start, len, offset }));
  });
}

export const TEMPLATES = {
  'SFX bank (space combat)': () => graph('sfx_bank', (N, L, p) => {
    p.bpm = 120; p.lengthBeats = 2;
    // laser: square sweeping down, short envelope, bit of crush
    const t1 = N('trigger', 0, 0, { note: 88, length: 0.09 });
    const o1 = N('osc', 240, 0, { wave: 'square', sweep: -26, sweepTime: 0.16, gain: 0.6 });
    const e1 = N('adsr', 504, 0, { a: 0.0015, d: 0.12, s: 0, r: 0.05, amount: 0 });
    const c1 = N('crusher', 780, 0, { bits: 10, rate: 16000, mix: 0.6 });
    const out1 = N('output', 1032, 0, { name: 'laser_zap', tail: 0.2 });
    L(t1, 'notes', o1, 'notes'); L(t1, 'notes', e1, 'notes'); L(o1, 'out', e1, 'in'); L(e1, 'out', c1, 'in'); L(c1, 'out', out1, 'in');

    // explosion: white noise through a lowpass whose cutoff falls with the envelope
    const t2 = N('trigger', 0, 500, { at: 0, length: 0.5 });
    const nz = N('noise', 240, 500, { color: 'white', gain: 0.9 });
    const f2 = N('filter', 504, 500, { cutoff: 180, q: 1.2, slope: '2' });
    const e2 = N('adsr', 780, 500, { a: 0.001, d: 1.1, s: 0, r: 0.4, amount: 5200, velsens: 0 });
    const d2 = N('distort', 1032, 500, { mode: 'soft', drive: 2.2, level: 0.9 });
    const r2 = N('reverb', 1272, 500, { size: 2.4, mix: 0.25, damp: 3500 });
    const out2 = N('output', 1512, 500, { name: 'explosion', tail: 1.2 });
    L(t2, 'notes', e2, 'notes'); L(nz, 'out', f2, 'in'); L(e2, 'cv', f2, 'p:cutoff'); L(f2, 'out', e2, 'in');
    L(e2, 'out', d2, 'in'); L(d2, 'out', r2, 'in'); L(r2, 'out', out2, 'in');

    // engine loop: brown noise + detuned saw drone, LFO wobble on cutoff, exported as a seamless loop
    const nz3 = N('noise', 0, 1000, { color: 'brown', gain: 0.8, seed: 77 });
    const o3 = N('osc', 0, 1192, { wave: 'sawtooth', freq: 55, gain: 0.25 });
    const lfo = N('lfo', 0, 1640, { rate: 0.5, depth: 220, offset: 0 });
    const mx = N('mixer', 264, 1000, { l1: 0.9, l2: 0.7 });
    const f3 = N('filter', 504, 1000, { cutoff: 520, q: 2.5 });
    const out3 = N('output', 780, 1000, { name: 'engine_loop', loop: true, tail: 0, seam: 0.12, volume: -3 });
    L(nz3, 'out', mx, 'in1'); L(o3, 'out', mx, 'in2'); L(mx, 'out', f3, 'in'); L(lfo, 'out', f3, 'p:cutoff'); L(f3, 'out', out3, 'in');

    // Game Synth: the same kind of cue built from the game's own Synth calls -> GDScript
    const gt = N('gs_tone', 1100, 1000, { dur: 0.12, f0: 600, f1: 1080, wave: 'SOFT', decay: 1.2 });
    const gn = N('gs_normalize', 1360, 1000, { peak: 0.45 });
    const ge = N('gs_edges', 1600, 1000, { attack: 0.0035, release: 0.01 });
    const gc = N('gs_out', 1840, 1000, { name: 'lock' });
    L(gt, 'out', gn, 'in'); L(gn, 'out', ge, 'in'); L(ge, 'out', gc, 'in');
    p.view = { x: 40, y: 40, zoom: 0.62 };
  }),

  'Chip groove (music loop)': () => graph('chip_groove', (N, L, p) => {
    p.bpm = 132; p.lengthBeats = 16;
    const steps = Array.from({ length: 32 }, (_, i) => ({ on: [0, 3, 6, 8, 10, 12, 14].includes(i % 16), semi: [0, 0, 12, 0, 7, 0, 10, 0, 0, 0, 12, 0, 3, 0, 5, 0][i % 16], vel: i % 4 === 0 ? 1 : 0.7 }));
    const sq = N('stepseq', 0, 0, { root: 36, gate: 0.4 }, { steps });
    const bass = N('osc', 336, 0, { wave: 'square', gain: 0.45 });
    const be = N('adsr', 600, 0, { a: 0.002, d: 0.18, s: 0.3, r: 0.08, amount: 2400 });
    const bf = N('filter', 876, 0, { cutoff: 400, q: 6 });
    L(sq, 'notes', bass, 'notes'); L(sq, 'notes', be, 'notes'); L(bass, 'out', be, 'in'); L(be, 'out', bf, 'in'); L(be, 'cv', bf, 'p:cutoff');

    const notes = [];
    const chords = [[60, 63, 67], [58, 62, 65], [56, 60, 63], [55, 58, 62]];
    chords.forEach((c, i) => c.forEach((n) => notes.push({ s: i * 4, l: 3.5, n, v: 0.75 })));
    [72, 75, 79, 77, 75, 74, 72, 70].forEach((n, i) => notes.push({ s: i * 2 + 0.5, l: 1, n, v: 0.9 }));
    const roll = N('pianoroll', 0, 520, { length: 16 }, { notes });
    const lead = N('osc', 336, 520, { wave: 'sawtooth', gain: 0.22, unison: 3, spread: 12, voices: 6 });
    const vib = N('lfo', 336, 960, { rate: 5.5, depth: 12 });
    const le = N('adsr', 600, 520, { a: 0.01, d: 0.3, s: 0.6, r: 0.25, amount: 0 });
    const dl = N('delay', 876, 520, { time: (60 / 132) * 0.75, feedback: 0.4, mix: 0.3 });
    const rv = N('reverb', 1116, 520, { size: 2.2, mix: 0.25 });
    L(roll, 'notes', lead, 'notes'); L(roll, 'notes', le, 'notes'); L(lead, 'out', le, 'in'); L(vib, 'out', lead, 'p:detune');
    L(le, 'out', dl, 'in'); L(dl, 'out', rv, 'in');

    const mx = N('mixer', 1356, 300, { l1: 0.8, l2: 0.6 });
    const cp = N('comp', 1596, 300, {});
    const sc = N('scope', 1836, 300, {});
    const out = N('output', 2112, 300, { name: 'chip_groove', loop: true, tail: 0, seam: 0.01 });
    L(bf, 'out', mx, 'in1'); L(rv, 'out', mx, 'in2'); L(mx, 'out', cp, 'in'); L(cp, 'out', sc, 'in'); L(sc, 'out', out, 'in');
    p.export = { ...p.export, sampleRate: 44100, channels: 2, normMode: 'lufs', lufs: -14, trim: false };
    // an arrangement: bass alone for 2 bars, then the chords + lead join (toggle Song in the top bar)
    p.song = { enabled: false, bars: 12, tracks: [{ id: 'tb', node: sq.id, mute: false }, { id: 'tl', node: roll.id, mute: false }],
      clips: [{ id: 'c1', track: 'tb', start: 0, len: 48, offset: 0 }, { id: 'c2', track: 'tl', start: 8, len: 32, offset: 0 }, { id: 'c3', track: 'tl', start: 40, len: 8, offset: 12 }] };
    p.view = { x: 40, y: 60, zoom: 0.55 };
  }),

  'Drum beat (music loop)': () => graph('drum_loop', (N, L, p) => {
    p.bpm = 96; p.lengthBeats = 4;
    // kick: a sine dropping two octaves fast is the whole 808 trick
    const ks = N('stepseq', 0, 0, { root: 48, gate: 0.6 }, { steps: steps([0, 6, 8, 11]) });
    const ko = N('osc', 336, 0, { wave: 'sine', sweep: -26, sweepTime: 0.2, gain: 0.95 });
    const ke = N('adsr', 600, 0, { a: 0.001, d: 0.42, s: 0, r: 0.08, amount: 0, velsens: 0.3 });
    const kd = N('distort', 864, 0, { drive: 2, level: 0.85 });
    L(ks, 'notes', ko, 'notes'); L(ks, 'notes', ke, 'notes'); L(ko, 'out', ke, 'in'); L(ke, 'out', kd, 'in');
    // snare: band-passed noise for the crack, a falling triangle for the body
    const ss = N('stepseq', 0, 520, { root: 52, gate: 0.3 }, { steps: steps([4, 12, 15], {}, { 15: 0.45 }) });
    const sn = N('noise', 336, 520, { gain: 0.7 });
    const sb = N('filter', 600, 520, { type: 'bandpass', cutoff: 3000, q: 0.7 });
    const se = N('adsr', 864, 520, { a: 0.001, d: 0.15, s: 0, r: 0.07, amount: 0, velsens: 0.7 });
    const st = N('osc', 336, 960, { wave: 'triangle', sweep: -7, sweepTime: 0.07, gain: 0.55 });
    const ste = N('adsr', 600, 960, { a: 0.001, d: 0.08, s: 0, r: 0.04, amount: 0 });
    L(ss, 'notes', se, 'notes'); L(ss, 'notes', st, 'notes'); L(ss, 'notes', ste, 'notes');
    L(sn, 'out', sb, 'in'); L(sb, 'out', se, 'in'); L(st, 'out', ste, 'in');
    // hats: accented eighths, an open hat on the last off-beat
    const hs = N('stepseq', 0, 1480, { gate: 0.15 }, { steps: steps([0, 2, 4, 6, 8, 10, 12, 14, 15], {}, { 0: 1, 2: 0.5, 4: 0.8, 6: 0.5, 8: 1, 10: 0.5, 12: 0.8, 14: 0.55, 15: 0.35 }) });
    const hn = N('noise', 336, 1480, { gain: 0.5, seed: 77 });
    const hh = N('filter', 600, 1480, { type: 'highpass', cutoff: 7800, q: 0.8 });
    const he = N('adsr', 864, 1480, { a: 0.0005, d: 0.045, s: 0, r: 0.03, amount: 0, velsens: 0.85 });
    L(hs, 'notes', he, 'notes'); L(hn, 'out', hh, 'in'); L(hh, 'out', he, 'in');
    const mx = N('mixer', 1164, 600, { l1: 0.9, l2: 0.7, l3: 0.6, l4: 0.45, p2: 0.05, p3: 0.05, p4: -0.25 });
    const cp = N('comp', 1416, 600, { threshold: -16, ratio: 3, attack: 0.01, makeup: 3 });
    const rv = N('reverb', 1668, 600, { size: 0.9, mix: 0.12, damp: 5000 });
    const out = N('output', 1920, 600, { name: 'drum_loop', bus: 'Music', loop: true, tail: 0, seam: 0.005 });
    L(kd, 'out', mx, 'in1'); L(se, 'out', mx, 'in2'); L(ste, 'out', mx, 'in3'); L(he, 'out', mx, 'in4');
    L(mx, 'out', cp, 'in'); L(cp, 'out', rv, 'in'); L(rv, 'out', out, 'in');
    p.export = { ...p.export, ...MUSIC };
    p.view = { x: 40, y: 40, zoom: 0.45 };
  }),

  'Ambient pad (music loop)': () => graph('ambient_pad', (N, L, p) => {
    p.bpm = 70; p.lengthBeats = 16;
    // Am9 – Fmaj7 – Cmaj7 – G6, one bar each, voiced close
    const notes = chordNotes([[0, 4, [57, 60, 64, 67, 71]], [4, 4, [53, 57, 60, 64]], [8, 4, [55, 60, 64, 67, 71]], [12, 4, [55, 59, 62, 64]]]);
    const roll = N('pianoroll', 0, 0, { length: 16 }, { notes });
    const wt = N('wavetable', 300, 0, { table: 'vocal', voices: 8, gain: 0.22, position: 0.35 });
    const lfo = N('lfo', 300, 560, { sync: '16', depth: 0.3, offset: 0.45, wave: 'triangle' });
    const e = N('adsr', 600, 0, { a: 1.4, d: 1.2, s: 0.8, r: 2.6, amount: 1400, velsens: 0.2 });
    const f = N('filter', 876, 0, { cutoff: 650, q: 1.1 });
    const ch = N('chorus', 1140, 0, { rate: 0.35, depth: 0.006, mix: 0.6 });
    const dl = N('delay', 1392, 0, { sync: '0.75', feedback: 0.45, mix: 0.22, damp: 1800 });
    const rv = N('reverb', 1644, 0, { size: 6.5, predelay: 0.05, mix: 0.45, damp: 4500 });
    const out = N('output', 1896, 0, { name: 'ambient_pad', bus: 'Music', loop: true, tail: 0, seam: 0.6 });
    L(roll, 'notes', wt, 'notes'); L(roll, 'notes', e, 'notes'); L(lfo, 'out', wt, 'p:position');
    L(wt, 'out', e, 'in'); L(e, 'out', f, 'in'); L(e, 'cv', f, 'p:cutoff');
    L(f, 'out', ch, 'in'); L(ch, 'out', dl, 'in'); L(dl, 'out', rv, 'in'); L(rv, 'out', out, 'in');
    p.export = { ...p.export, ...MUSIC, lufs: -18 };
    p.view = { x: 40, y: 60, zoom: 0.5 };
  }),

  'Battle theme (song arrangement)': () => graph('battle_theme', (N, L, p) => {
    p.bpm = 140; p.lengthBeats = 16;
    // drums
    const ks = N('stepseq', 0, 0, { root: 48, gate: 0.6 }, { steps: steps([0, 4, 8, 10, 12]) });
    const ko = N('osc', 336, 0, { wave: 'sine', sweep: -24, sweepTime: 0.16, gain: 0.95 });
    const ke = N('adsr', 600, 0, { a: 0.001, d: 0.3, s: 0, r: 0.05, amount: 0 });
    L(ks, 'notes', ko, 'notes'); L(ks, 'notes', ke, 'notes'); L(ko, 'out', ke, 'in');
    const hs = N('stepseq', 0, 560, { gate: 0.15 }, { steps: steps([2, 6, 10, 14, 15], {}, { 15: 0.4 }) });
    const hn = N('noise', 336, 560, { gain: 0.45 });
    const hh = N('filter', 576, 560, { type: 'highpass', cutoff: 7000 });
    const he = N('adsr', 840, 560, { a: 0.0005, d: 0.06, s: 0, r: 0.03, amount: 0, velsens: 0.8 });
    L(hs, 'notes', he, 'notes'); L(hn, 'out', hh, 'in'); L(hh, 'out', he, 'in');
    // driving bass: C minor, octave jumps
    const bs = N('stepseq', 0, 1120, { root: 36, rate: '0.25', gate: 0.55 }, { steps: steps([0, 2, 3, 4, 6, 8, 10, 11, 12, 14], { 3: 12, 6: 10, 11: 12, 12: 7, 14: 3 }) });
    const bo = N('osc', 336, 1120, { wave: 'sawtooth', unison: 2, spread: 8, gain: 0.5 });
    const be = N('adsr', 600, 1120, { a: 0.002, d: 0.16, s: 0.35, r: 0.06, amount: 2600 });
    const bf = N('filter', 876, 1120, { cutoff: 380, q: 5, slope: '2' });
    L(bs, 'notes', bo, 'notes'); L(bs, 'notes', be, 'notes'); L(bo, 'out', be, 'in'); L(be, 'out', bf, 'in'); L(be, 'cv', bf, 'p:cutoff');
    // lead melody
    const mel = [[0, 1.5, 72], [1.5, 0.5, 70], [2, 1, 67], [3, 1, 70], [4, 2, 72], [6, 1, 75], [7, 1, 74],
      [8, 1.5, 72], [9.5, 0.5, 70], [10, 1, 67], [11, 1, 63], [12, 3, 65], [15, 1, 67]].map(([s, l, n]) => ({ s, l, n, v: 0.85 }));
    const lr = N('pianoroll', 0, 1680, { length: 16 }, { notes: mel });
    const lo = N('osc', 336, 1680, { wave: 'square', voices: 2, glide: 0.02, gain: 0.3 });
    const lv = N('lfo', 336, 2160, { rate: 5.5, depth: 14 });
    const le = N('adsr', 600, 1680, { a: 0.01, d: 0.25, s: 0.7, r: 0.2, amount: 0 });
    const ld = N('delay', 876, 1680, { sync: '0.75', feedback: 0.35, mix: 0.25 });
    L(lr, 'notes', lo, 'notes'); L(lr, 'notes', le, 'notes'); L(lv, 'out', lo, 'p:detune'); L(lo, 'out', le, 'in'); L(le, 'out', ld, 'in');
    // pad chords: Cm – Ab – Eb – Bb
    const pr = N('pianoroll', 0, 2440, { length: 16 }, { notes: chordNotes([[0, 4, [60, 63, 67]], [4, 4, [56, 60, 63]], [8, 4, [58, 63, 67]], [12, 4, [58, 62, 65]]], 0.6) });
    const pw = N('wavetable', 336, 2440, { table: 'basic', position: 0.55, voices: 6, gain: 0.2 });
    const pe = N('adsr', 600, 2440, { a: 0.4, d: 0.5, s: 0.8, r: 0.9, amount: 0 });
    const prv = N('reverb', 876, 2440, { size: 3, mix: 0.4 });
    L(pr, 'notes', pw, 'notes'); L(pr, 'notes', pe, 'notes'); L(pw, 'out', pe, 'in'); L(pe, 'out', prv, 'in');
    // mix
    const md = N('mixer', 1176, 300, { l1: 0.95, l2: 0.45, p2: -0.2 });
    const mm = N('mixer', 1176, 1500, { l1: 0.75, l2: 0.6, l3: 0.55, l4: 0.9, p2: 0.12 });
    const cp = N('comp', 1440, 1500, { threshold: -18, ratio: 3.5, makeup: 3 });
    const out = N('output', 1692, 1500, { name: 'battle_theme', bus: 'Music', loop: true, tail: 0, seam: 0.01 });
    L(ke, 'out', md, 'in1'); L(he, 'out', md, 'in2');
    L(bf, 'out', mm, 'in1'); L(ld, 'out', mm, 'in2'); L(prv, 'out', mm, 'in3'); L(md, 'out', mm, 'in4');
    L(mm, 'out', cp, 'in'); L(cp, 'out', out, 'in');
    // intro pad → kick → bass + hats → lead; hats drop out for the last bar
    arrange(p, 16, [[pr, [[0, 64]]], [ks, [[8, 56]]], [bs, [[16, 48]]], [hs, [[16, 44]]], [lr, [[32, 32]]]]);
    p.export = { ...p.export, ...MUSIC };
    p.view = { x: 40, y: 30, zoom: 0.3 };
  }),

  'Game Synth cues (GDScript)': () => graph('synth_cues', (N, L, p) => {
    p.bpm = 120; p.lengthBeats = 2;
    const row = (y, chain, name, extra = {}) => {
      let x = 0, prev = null;
      const nodes = chain.map(([type, params]) => { const n = N(type, x, y, params); x += 252; return n; });
      for (const n of nodes) { if (prev) L(prev, 'out', n, 'in'); prev = n; }
      const o = N('gs_out', x, y, { name, ...extra });
      L(prev, 'out', o, 'in');
      return o;
    };
    // the same numbers SfxBank uses for its lock tone
    row(0, [['gs_tone', { dur: 0.12, f0: 600, f1: 1080, wave: 'SOFT', decay: 1.2 }], ['gs_normalize', { peak: 0.45 }], ['gs_edges', { attack: 0.0035, release: 0.01 }]], 'lock');
    row(460, [['gs_tone', { dur: 0.16, f0: 1600, f1: 300, wave: 'SQUARE', decay: 1.5 }], ['gs_lowpass', { h0: 5200, h1: 5200, poles: 1 }], ['gs_bitcrush', { bits: 10, hold: 1 }], ['gs_edges', { attack: 0.0035, release: 0.01 }]], 'laser');
    // pickup: two rising tones layered, like SfxBank's
    const a = N('gs_tone', 0, 920, { dur: 0.07, f0: 880, f1: 1320, wave: 'SOFT', decay: 1.4 });
    const b = N('gs_tone', 0, 1160, { dur: 0.11, f0: 1760, f1: 2640, wave: 'SINE', decay: 2.2 });
    const lay = N('gs_layer', 252, 960, { g1: 0.9, g2: 0.45 });
    const pn = N('gs_normalize', 504, 960, { peak: 0.6 });
    const po = N('gs_out', 756, 960, { name: 'pickup' });
    L(a, 'out', lay, 'in1'); L(b, 'out', lay, 'in2'); L(lay, 'out', pn, 'in'); L(pn, 'out', po, 'in');
    // shield hit: click + ring-modded body through a metallic comb
    const c = N('gs_transient', 0, 1480, { dur: 0.004 });
    const body = N('gs_tone', 0, 1620, { dur: 0.22, f0: 900, f1: 380, wave: 'SOFT', decay: 2 });
    const rm = N('gs_ringmod', 252, 1620, { hz: 320, amount: 0.5 });
    const sl = N('gs_layer', 504, 1500, { g1: 0.6, g2: 1 });
    const cb = N('gs_comb', 756, 1500, { delay: 3.1, feedback: 0.62, amount: 0.4 });
    const sn = N('gs_normalize', 1008, 1500, { peak: 0.8 });
    const so = N('gs_out', 1260, 1500, { name: 'shield_hit' });
    L(c, 'out', sl, 'in1'); L(body, 'out', rm, 'in'); L(rm, 'out', sl, 'in2'); L(sl, 'out', cb, 'in'); L(cb, 'out', sn, 'in'); L(sn, 'out', so, 'in');
    // explosion: noise with a falling lid, a sub drop, driven
    const en = N('gs_noise', 0, 2020, { dur: 1.4, decay: 2.2 });
    const el = N('gs_lowpass', 252, 2020, { h0: 4200, h1: 120, poles: 2 });
    const es = N('gs_tone', 0, 2220, { dur: 1.4, f0: 70, f1: 28, wave: 'SINE', decay: 1.8 });
    const et = N('gs_transient', 0, 2460, { dur: 0.006 });
    const ey = N('gs_layer', 504, 2100, { g1: 1, g2: 0.6, g3: 0.7 });
    const ed = N('gs_drive', 756, 2100, { amount: 2.4, bias: 0.15 });
    const em = N('gs_normalize', 1008, 2100, { peak: 0.9 });
    const eo = N('gs_out', 1260, 2100, { name: 'explosion' });
    L(en, 'out', el, 'in'); L(el, 'out', ey, 'in1'); L(es, 'out', ey, 'in2'); L(et, 'out', ey, 'in3'); L(ey, 'out', ed, 'in'); L(ed, 'out', em, 'in'); L(em, 'out', eo, 'in');
    // engine hum: banded noise, seam-crossfaded so it loops
    row(2660, [['gs_noise', { dur: 2, decay: 0 }], ['gs_band', { lo: 140, hi: 1100, poles: 2 }], ['gs_normalize', { peak: 0.5 }], ['gs_seam', { fade: 0.12 }]], 'engine_hum', { loop: true });
    p.view = { x: 40, y: 30, zoom: 0.42 };
  }),

  'UI sounds (menu bank)': () => graph('ui_sounds', (N, L, p) => {
    p.bpm = 120; p.lengthBeats = 1;
    const cue = (y, name, trig, osc, env, filt) => {
      const t = N('trigger', 0, y, trig);
      const o = N('osc', 240, y, osc);
      const e = N('adsr', 516, y, { amount: 0, velsens: 0, ...env });
      let last = e;
      L(t, 'notes', o, 'notes'); L(t, 'notes', e, 'notes'); L(o, 'out', e, 'in');
      if (filt) { const f = N('filter', 780, y, filt); L(e, 'out', f, 'in'); last = f; }
      const out = N('output', 1044, y, { name, bus: 'UI', tail: 0.1 });
      L(last, 'out', out, 'in');
    };
    cue(0, 'ui_move', { note: 88, length: 0.02 }, { wave: 'sine', gain: 0.6 }, { a: 0.001, d: 0.035, s: 0, r: 0.02 });
    cue(560, 'ui_confirm', { note: 79, length: 0.06, repeat: 2, every: 0.065, pstep: 7 }, { wave: 'triangle', gain: 0.7, voices: 2 }, { a: 0.001, d: 0.09, s: 0, r: 0.05 });
    cue(1120, 'ui_cancel', { note: 76, length: 0.06, repeat: 2, every: 0.07, pstep: -5, decay: 0.3 }, { wave: 'triangle', gain: 0.7, voices: 2 }, { a: 0.001, d: 0.08, s: 0, r: 0.05 });
    cue(1680, 'ui_deny', { note: 45, length: 0.16 }, { wave: 'square', gain: 0.5, unison: 2, spread: 30 }, { a: 0.002, d: 0.18, s: 0.3, r: 0.05 }, { cutoff: 1600, q: 2 });
    p.view = { x: 40, y: 30, zoom: 0.4 };
  }),

  'Sample chops (drop a sample in)': () => graph('chops', (N, L, p) => {
    p.bpm = 92; p.lengthBeats = 4;
    // each step plays a different slice: Root plays slice 0, Root+1 slice 1, …
    const seq = N('stepseq', 0, 0, { root: 60, gate: 0.9 }, { steps: steps([0, 3, 6, 8, 10, 12, 14], { 3: 1, 6: 2, 8: 3, 10: 1, 12: 4, 14: 2 }) });
    const sm = N('sampler', 336, 0, { mode: 'slices', slices: 8, root: 60, voices: 8, gate: true, release: 0.03 });
    const f = N('filter', 636, 0, { cutoff: 9000, q: 0.7 });
    const cp = N('comp', 900, 0, { threshold: -20, ratio: 4, makeup: 5 });
    const out = N('output', 1164, 0, { name: 'chops', bus: 'Music', loop: true, tail: 0, seam: 0.005 });
    L(seq, 'notes', sm, 'notes'); L(sm, 'out', f, 'in'); L(f, 'out', cp, 'in'); L(cp, 'out', out, 'in');
    p.export = { ...p.export, ...MUSIC };
    p.view = { x: 60, y: 80, zoom: 0.7 };
  }),

  'Empty': () => graph('untitled', (N) => { N('output', 600, 200, { name: 'cue' }); }),
};
