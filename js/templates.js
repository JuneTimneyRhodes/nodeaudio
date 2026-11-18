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
    const lfo = N('lfo', 0, 1552, { rate: 0.5, depth: 220, offset: 0 });
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
    const vib = N('lfo', 336, 880, { rate: 5.5, depth: 12 });
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

  'Empty': () => graph('untitled', (N) => { N('output', 600, 200, { name: 'cue' }); }),
};
