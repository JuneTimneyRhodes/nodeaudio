import test from 'node:test';
import assert from 'node:assert/strict';
import { S, Rng, samples, evaluate, codegen, codegenFile, gf, MIX_RATE } from '../js/gamesynth.js';

const N = (id, type, params) => ({ id, type, params });
const L = (a, ap, b, bp) => ({ from: { node: a, port: ap }, to: { node: b, port: bp } });

test('buffer lengths follow Synth.samples', () => {
  assert.equal(samples(0.15), Math.trunc(0.15 * MIX_RATE));
  assert.equal(S.tone(0.15, 880, 220, 'SOFT', 1.5).length, samples(0.15));
  assert.equal(samples(0), 1);
});

test('band-limited square stays bounded; loop_seam trims the fade', () => {
  const b = S.tone(0.5, 3000, 3000, 'SQUARE', 0);
  assert.ok(Math.max(...b.map(Math.abs)) < 1.3);
  assert.equal(S.loop_seam(new Float32Array(10000), 0.12).length, 10000 - samples(0.12));
});

test('GDScript floats always carry a decimal point', () => {
  assert.equal(gf(600), '600.0'); assert.equal(gf(0.0035), '0.0035'); assert.equal(gf(-2), '-2.0');
});

const graph = {
  nodes: [N('t', 'gs_tone', { dur: 0.12, f0: 600, f1: 1080, wave: 'SOFT', decay: 1.2 }), N('n', 'gs_normalize', { peak: 0.45 }),
    N('e', 'gs_edges', { attack: 0.0035, release: 0.01 }), N('o', 'gs_out', { name: 'lock', loop: false, seed: 1 })],
  links: [L('t', 'out', 'n', 'in'), L('n', 'out', 'e', 'in'), L('e', 'out', 'o', 'in')],
};

test('codegen reproduces the lock cue from SfxBank', () => {
  const { code, warnings } = codegen(graph, 'o');
  assert.deepEqual(warnings, []);
  assert.match(code, /static func bake_lock\(rng: RandomNumberGenerator\) -> AudioStreamWAV:/);
  assert.match(code, /var b1 := Synth\.tone\(0\.12, 600\.0, 1080\.0, Synth\.Wave\.SOFT, 1\.2, rng\)/);
  assert.match(code, /\tSynth\.normalize\(b1, 0\.45\)\n\tSynth\.edges\(b1, 0\.0035, 0\.01\)\n\treturn Synth\.to_wav\(b1, false\)/);
});

test('evaluate matches the code path: normalised to the requested peak', () => {
  const b = evaluate(graph, 'o', 1);
  assert.equal(b.length, samples(0.12));
  const pk = Math.max(...b.map(Math.abs));
  assert.ok(pk <= 0.4501 && pk > 0.3, String(pk)); // edges() fades the very first samples, where a decaying tone peaks
});

test('shared inputs are duplicated before in-place ops', () => {
  const g = {
    nodes: [N('a', 'gs_noise', { dur: 0.2, decay: 1 }), N('l', 'gs_lowpass', { h0: 500, h1: 500, poles: 1 }), N('h', 'gs_drive', { amount: 2, bias: 0 }),
      N('y', 'gs_layer', { g1: 1, g2: 1, g3: 0, g4: 0 }), N('o', 'gs_out', { name: 'x', loop: true, seed: 3 })],
    links: [L('a', 'out', 'l', 'in'), L('a', 'out', 'h', 'in'), L('l', 'out', 'y', 'in1'), L('h', 'out', 'y', 'in2'), L('y', 'out', 'o', 'in')],
  };
  const { code } = codegen(g, 'o');
  assert.equal((code.match(/\.duplicate\(\)/g) || []).length, 2);
  assert.match(code, /Synth\.layer\(\[\[b\d, 1\.0\], \[b\d, 1\.0\]\]\)/);
  assert.match(code, /to_wav\(b\d, true\)/);
  assert.match(codegenFile(g, ['o']).code, /class_name NodeAudioCues/);
});

test('rng is deterministic per seed', () => {
  const a = new Rng(7), b = new Rng(7);
  for (let i = 0; i < 5; i++) assert.equal(a.randf(), b.randf());
});
