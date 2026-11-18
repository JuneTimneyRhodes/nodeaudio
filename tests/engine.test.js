import test from 'node:test';
import assert from 'node:assert/strict';
import { flatten, computeVoices, makeAllocator, clipEvents, clipsFor } from '../js/engine.js';
import { TYPES, defaultParams } from '../js/nodes.js';

const N = (id, type, params = {}, data) => ({ id, type, x: 0, y: 0, params: { ...defaultParams(type), ...params }, ...(data ? { data } : {}) });
const L = (a, ap, b, bp) => ({ id: a + b + ap, from: { node: a, port: ap }, to: { node: b, port: bp } });
const pairs = (f) => f.links.map((l) => `${l.from.node}>${l.to.node}`).sort();

test('flatten inlines groups and contracts Group In/Out', () => {
  const inner = { nodes: [N('gi', 'group_in'), N('f', 'filter'), N('go', 'group_out')], links: [L('gi', 'i0', 'f', 'in'), L('f', 'out', 'go', 'o0')], inputs: [{ key: 'i0', type: 'audio' }], outputs: [{ key: 'o0', type: 'audio' }] };
  const p = { nodes: [N('o', 'osc'), N('g', 'group', {}, inner), N('out', 'output')], links: [L('o', 'out', 'g', 'i0'), L('g', 'o0', 'out', 'in')] };
  const f = flatten(p);
  assert.deepEqual(f.nodes.map((n) => n.id).sort(), ['g/f', 'o', 'out']);
  assert.deepEqual(pairs(f), ['g/f>out', 'o>g/f']);
  assert.equal(f.nodes.find((n) => n.id === 'g/f').params, inner.nodes[1].params, 'params shared, not copied');
});

test('nested groups flatten with path ids', () => {
  const deep = { nodes: [N('gi', 'group_in'), N('d', 'delay'), N('go', 'group_out')], links: [L('gi', 'a', 'd', 'in'), L('d', 'out', 'go', 'b')], inputs: [], outputs: [] };
  const mid = { nodes: [N('gi', 'group_in'), N('h', 'group', {}, deep), N('go', 'group_out')], links: [L('gi', 'x', 'h', 'a'), L('h', 'b', 'go', 'y')], inputs: [], outputs: [] };
  const p = { nodes: [N('n', 'noise'), N('g', 'group', {}, mid), N('out', 'output')], links: [L('n', 'out', 'g', 'x'), L('g', 'y', 'out', 'in')] };
  assert.deepEqual(pairs(flatten(p)), ['g/h/d>out', 'n>g/h/d']);
});

test('voices: sources set them, poly-aware processors inherit, others mix down', () => {
  const p = { nodes: [N('o', 'osc', { voices: 6 }), N('e', 'adsr'), N('f', 'filter'), N('r', 'reverb')], links: [L('o', 'out', 'e', 'in'), L('e', 'out', 'f', 'in'), L('e', 'cv', 'f', 'p:cutoff'), L('f', 'out', 'r', 'in')] };
  const v = computeVoices(flatten(p));
  assert.equal(v.get('o'), 6); assert.equal(v.get('e'), 6); assert.equal(v.get('f'), 6); assert.equal(v.get('r'), 1);
});

test('allocator is deterministic and steals the voice that frees first', () => {
  const evs = [0, 0.1, 0.2, 0.3, 1.5].map((t) => ({ t, dur: 1 }));
  const a = makeAllocator(3), b = makeAllocator(3);
  const va = evs.map((e) => a.alloc(e)), vb = evs.map((e) => b.alloc(e));
  assert.deepEqual(va, vb);
  assert.deepEqual(va, [0, 1, 2, 0, 0], 'steals voice 0 (frees first), then reuses the lowest free voice');
});

test('arrangement clips gate and shift sequencer events', () => {
  const project = { bpm: 120, song: { enabled: true, bars: 4, tracks: [{ id: 't', node: 'pr', mute: false }], clips: [{ id: 'c', track: 't', start: 4, len: 4, offset: 2 }] } };
  const clips = clipsFor(project, 'pr');
  assert.deepEqual(clips, [{ start: 2, end: 4, offset: 1 }]);
  const P = { length: 8, transpose: 0 };
  const data = { notes: [{ s: 0, l: 1, n: 60, v: 1 }, { s: 2, l: 1, n: 62, v: 1 }, { s: 3, l: 4, n: 64, v: 1 }] };
  const evs = clipEvents(clips, (a, b) => TYPES.pianoroll.events(P, a, b, { bpm: 120 }, data), 0, 10);
  assert.deepEqual(evs.map((e) => [e.note, e.t]), [[62, 2], [64, 2.5]]);
  assert.equal(evs[1].dur, 1.5, 'notes are cut at the clip end');
  project.song.tracks[0].mute = true;
  assert.deepEqual(clipsFor(project, 'pr'), []);
});

test('sequencer events: step sequencer, trigger, chord', () => {
  const steps = Array.from({ length: 32 }, (_, i) => ({ on: i % 4 === 0, semi: i === 4 ? 7 : 0, vel: 1 }));
  const ev = TYPES.stepseq.events({ ...defaultParams('stepseq'), steps: 16 }, 0, 2, { bpm: 120 }, { steps });
  assert.deepEqual(ev.map((e) => [e.t, e.note]), [[0, 48], [0.5, 55], [1, 48], [1.5, 48]]);
  const tr = TYPES.trigger.events({ ...defaultParams('trigger'), repeat: 3, every: 0.1, pstep: 2 }, 0, 1);
  assert.deepEqual(tr.map((e) => e.note), [60, 62, 64]);
  const ch = TYPES.chord.transform({ shape: '0,4,7', spread: 0 }, [{ t: 0, dur: 1, note: 60, vel: 1 }]);
  assert.deepEqual(ch.map((e) => e.note), [60, 64, 67]);
});
