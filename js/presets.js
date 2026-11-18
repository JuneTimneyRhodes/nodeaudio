// Preset library: factory patches plus your own (saved in the browser, exportable as
// JSON). A preset is a clipboard snippet — nodes + links — pasted where you drop it.

import { makeNode, uid, idbGet, idbSet } from './project.js';

function clip(build) {
  const nodes = [], links = [];
  const N = (type, x, y, params = {}, data) => { const n = makeNode(type, x, y); Object.assign(n.params, params); if (data) n.data = { ...n.data, ...data }; nodes.push(n); return n; };
  const L = (a, ap, b, bp) => links.push({ id: uid('l'), from: { node: a.id, port: ap }, to: { node: b.id, port: bp } });
  build(N, L);
  return JSON.stringify({ nodes, links });
}

const steps = (on, semis = {}) => Array.from({ length: 32 }, (_, i) => ({ on: on.includes(i % 16), semi: semis[i % 16] || 0, vel: 1 }));

export const FACTORY = [
  { name: 'Poly Pad (wavetable)', cat: 'Synths', make: () => clip((N, L) => {
    const k = N('liveinput', 0, 0);
    const wt = N('wavetable', 240, 0, { table: 'vocal', voices: 8, gain: 0.3 });
    const lfo = N('lfo', 240, 380, { sync: '8', depth: 0.35, offset: 0.4, wave: 'triangle' });
    const e = N('adsr', 516, 0, { a: 0.6, d: 0.8, s: 0.7, r: 1.6, amount: 1800 });
    const f = N('filter', 780, 0, { cutoff: 900, q: 1.2 });
    const ch = N('chorus', 1032, 0, { mix: 0.5 });
    const rv = N('reverb', 1272, 0, { size: 3.5, mix: 0.35 });
    L(k, 'notes', wt, 'notes'); L(k, 'notes', e, 'notes'); L(lfo, 'out', wt, 'p:position'); L(wt, 'out', e, 'in'); L(e, 'out', f, 'in'); L(e, 'cv', f, 'p:cutoff'); L(f, 'out', ch, 'in'); L(ch, 'out', rv, 'in');
  }) },
  { name: 'Supersaw Lead', cat: 'Synths', make: () => clip((N, L) => {
    const k = N('liveinput', 0, 0);
    const o = N('osc', 240, 0, { wave: 'sawtooth', unison: 7, spread: 22, voices: 6, gain: 0.35 });
    const e = N('adsr', 516, 0, { a: 0.005, d: 0.3, s: 0.7, r: 0.35, amount: 3000 });
    const f = N('filter', 780, 0, { cutoff: 1800, q: 2 });
    const d = N('delay', 1032, 0, { sync: '0.75', feedback: 0.35, mix: 0.25 });
    L(k, 'notes', o, 'notes'); L(k, 'notes', e, 'notes'); L(o, 'out', e, 'in'); L(e, 'out', f, 'in'); L(e, 'cv', f, 'p:cutoff'); L(f, 'out', d, 'in');
  }) },
  { name: 'Sub Bass', cat: 'Synths', make: () => clip((N, L) => {
    const k = N('liveinput', 0, 0, { octave: -2 });
    const o = N('osc', 240, 0, { wave: 'triangle', glide: 0.04, gain: 0.7 });
    const e = N('adsr', 516, 0, { a: 0.003, d: 0.4, s: 0.8, r: 0.12, amount: 0 });
    const ds = N('distort', 780, 0, { drive: 1.6, level: 0.8 });
    L(k, 'notes', o, 'notes'); L(k, 'notes', e, 'notes'); L(o, 'out', e, 'in'); L(e, 'out', ds, 'in');
  }) },
  { name: 'Kick (808-style)', cat: 'Drums', make: () => clip((N, L) => {
    const s = N('stepseq', 0, 0, { root: 48, gate: 0.6 }, { steps: steps([0, 4, 8, 12]) });
    const o = N('osc', 336, 0, { wave: 'sine', sweep: -26, sweepTime: 0.22, gain: 0.9 });
    const e = N('adsr', 612, 0, { a: 0.001, d: 0.45, s: 0, r: 0.1, amount: 0, velsens: 0.3 });
    const ds = N('distort', 876, 0, { drive: 2.2, level: 0.8 });
    L(s, 'notes', o, 'notes'); L(s, 'notes', e, 'notes'); L(o, 'out', e, 'in'); L(e, 'out', ds, 'in');
  }) },
  { name: 'Snare', cat: 'Drums', make: () => clip((N, L) => {
    const s = N('stepseq', 0, 0, { root: 52, gate: 0.3 }, { steps: steps([4, 12]) });
    const nz = N('noise', 336, 0, { gain: 0.7 });
    const bp = N('filter', 576, 0, { type: 'bandpass', cutoff: 3200, q: 0.8 });
    const en = N('adsr', 816, 0, { a: 0.001, d: 0.16, s: 0, r: 0.08, amount: 0 });
    const o = N('osc', 336, 220, { wave: 'triangle', sweep: -7, sweepTime: 0.08, gain: 0.6 });
    const eo = N('adsr', 576, 380, { a: 0.001, d: 0.09, s: 0, r: 0.05, amount: 0 });
    const mx = N('mixer', 1080, 120, { l1: 0.9, l2: 0.7 });
    L(s, 'notes', en, 'notes'); L(s, 'notes', o, 'notes'); L(s, 'notes', eo, 'notes');
    L(nz, 'out', bp, 'in'); L(bp, 'out', en, 'in'); L(o, 'out', eo, 'in'); L(en, 'out', mx, 'in1'); L(eo, 'out', mx, 'in2');
  }) },
  { name: 'Hi-hat', cat: 'Drums', make: () => clip((N, L) => {
    const s = N('stepseq', 0, 0, { rate: '0.25', gate: 0.2 }, { steps: Array.from({ length: 32 }, (_, i) => ({ on: i % 2 === 0, semi: 0, vel: i % 4 === 0 ? 1 : 0.55 })) });
    const nz = N('noise', 336, 0, { gain: 0.5 });
    const hp = N('filter', 576, 0, { type: 'highpass', cutoff: 7500, q: 0.7 });
    const e = N('adsr', 816, 0, { a: 0.0005, d: 0.05, s: 0, r: 0.03, amount: 0, velsens: 0.8 });
    L(s, 'notes', e, 'notes'); L(nz, 'out', hp, 'in'); L(hp, 'out', e, 'in');
  }) },
  { name: 'Granular Texture', cat: 'Synths', make: () => clip((N, L) => {
    const k = N('liveinput', 0, 0);
    const gr = N('granular', 240, 0, { density: 60, size: 0.12, spray: 0.1 });
    const lfo = N('lfo', 240, 460, { rate: 0.05, depth: 0.25, offset: 0.4, wave: 'triangle' });
    const rv = N('reverb', 516, 0, { size: 4, mix: 0.4 });
    L(k, 'notes', gr, 'notes'); L(lfo, 'out', gr, 'p:position'); L(gr, 'out', rv, 'in');
  }) },
  { name: 'Laser (Game Synth)', cat: 'Game Synth', make: () => clip((N, L) => {
    const t = N('gs_tone', 0, 0, { dur: 0.16, f0: 1600, f1: 300, wave: 'SQUARE', decay: 1.5 });
    const lp = N('gs_lowpass', 264, 0, { h0: 5200, h1: 5200, poles: 1 });
    const ed = N('gs_edges', 516, 0, { attack: 0.0035, release: 0.01 });
    const o = N('gs_out', 768, 0, { name: 'laser' });
    L(t, 'out', lp, 'in'); L(lp, 'out', ed, 'in'); L(ed, 'out', o, 'in');
  }) },
  { name: 'Explosion (Game Synth)', cat: 'Game Synth', make: () => clip((N, L) => {
    const c = N('gs_transient', 0, 0, { dur: 0.006 });
    const nz = N('gs_noise', 0, 150, { dur: 1.4, decay: 2.2 });
    const lp = N('gs_lowpass', 264, 150, { h0: 4200, h1: 120, poles: 2 });
    const sub = N('gs_tone', 0, 340, { dur: 1.4, f0: 70, f1: 28, wave: 'SINE', decay: 1.8 });
    const lay = N('gs_layer', 516, 120, { g1: 0.7, g2: 1, g3: 0.6 });
    const dr = N('gs_drive', 768, 120, { amount: 2.4, bias: 0.15 });
    const nm = N('gs_normalize', 1008, 120, { peak: 0.9 });
    const o = N('gs_out', 1248, 120, { name: 'explosion' });
    L(c, 'out', lay, 'in1'); L(nz, 'out', lp, 'in'); L(lp, 'out', lay, 'in2'); L(sub, 'out', lay, 'in3');
    L(lay, 'out', dr, 'in'); L(dr, 'out', nm, 'in'); L(nm, 'out', o, 'in');
  }) },
  { name: 'Engine Hum Loop (Game Synth)', cat: 'Game Synth', make: () => clip((N, L) => {
    const nz = N('gs_noise', 0, 0, { dur: 2, decay: 0 });
    const bd = N('gs_band', 252, 0, { lo: 140, hi: 1100, poles: 2 });
    const hum = N('gs_tone', 0, 170, { dur: 2, f0: 55, f1: 55, wave: 'SOFT', decay: 0 });
    const lay = N('gs_layer', 504, 60, { g1: 0.7, g2: 0.35 });
    const sm = N('gs_seam', 744, 60, { fade: 0.12 });
    const o = N('gs_out', 984, 60, { name: 'engine_hum', loop: true });
    L(nz, 'out', bd, 'in'); L(bd, 'out', lay, 'in1'); L(hum, 'out', lay, 'in2'); L(lay, 'out', sm, 'in'); L(sm, 'out', o, 'in');
  }) },
];

export async function loadUserPresets() { return (await idbGet('presets')) || []; }
export async function saveUserPresets(list) { await idbSet('presets', list); }
