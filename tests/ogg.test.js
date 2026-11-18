import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Run the vendored UMD bundle the way a <script> tag would, then encode with the
// vendored ogg.wasm — the exact files the app ships.
const dir = new URL('../js/vendor/wasm-media-encoders/', import.meta.url);
const lib = (() => {
  const g = {};
  new Function('globalThis', 'self', readFileSync(new URL('WasmMediaEncoder.min.js', dir), 'utf8'))(g, g);
  return g.WasmMediaEncoder;
})();
const wasm = readFileSync(new URL('ogg.wasm', dir));

async function encode(channels, sampleRate, quality) {
  const enc = await lib.createEncoder('audio/ogg', wasm);
  enc.configure({ channels: channels.length, sampleRate, vbrQuality: quality });
  const parts = [];
  for (let i = 0; i < channels[0].length; i += 16384) parts.push(enc.encode(channels.map((c) => c.subarray(i, i + 16384))).slice());
  parts.push(enc.finalize().slice());
  return Buffer.concat(parts.map((p) => Buffer.from(p)));
}

const tone = (sec, sr, f) => Float32Array.from({ length: Math.round(sec * sr) }, (_, i) => 0.5 * Math.sin((2 * Math.PI * f * i) / sr));

test('vendored encoder produces a valid Ogg Vorbis stream', async () => {
  const sr = 44100, L = tone(2, sr, 440), R = tone(2, sr, 660);
  const ogg = await encode([L, R], sr, 5);
  assert.equal(ogg.subarray(0, 4).toString('latin1'), 'OggS', 'Ogg capture pattern');
  const id = ogg.indexOf(Buffer.from('\x01vorbis', 'latin1'));
  assert.ok(id > 0, 'Vorbis identification header');
  assert.equal(ogg[id + 11], 2, 'channels');
  assert.equal(ogg.readUInt32LE(id + 12), sr, 'sample rate');
  assert.ok(ogg.length < 2 * sr * 2 * 2 / 4, `much smaller than 16-bit WAV (${ogg.length} bytes)`);
  // last page carries the end-of-stream flag
  const lastPage = ogg.lastIndexOf(Buffer.from('OggS', 'latin1'));
  assert.ok(ogg[lastPage + 5] & 4, 'EOS flag on the final page');
});

test('mono at the game rate (22050 Hz) encodes too', async () => {
  const ogg = await encode([tone(0.5, 22050, 880)], 22050, 3);
  const id = ogg.indexOf(Buffer.from('\x01vorbis', 'latin1'));
  assert.equal(ogg[id + 11], 1);
  assert.equal(ogg.readUInt32LE(id + 12), 22050);
});
