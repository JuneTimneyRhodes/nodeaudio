import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeWav, loopSeam, makeZip, trimTail, normalize, peak } from '../js/wav.js';

const sine = (n, sr = 22050, f = 440, a = 0.8) => Float32Array.from({ length: n }, (_, i) => Math.sin((2 * Math.PI * f * i) / sr) * a);
const bytes = async (blob) => new Uint8Array(await blob.arrayBuffer());
const str = (u, o, n) => String.fromCharCode(...u.subarray(o, o + n));
const u32 = (u, o) => new DataView(u.buffer).getUint32(o, true);
const u16 = (u, o) => new DataView(u.buffer).getUint16(o, true);

test('16-bit mono header and size', async () => {
  const b = await bytes(encodeWav([sine(1000)], 22050, 16));
  assert.equal(str(b, 0, 4), 'RIFF'); assert.equal(str(b, 8, 4), 'WAVE');
  assert.equal(u32(b, 4), b.length - 8);
  assert.equal(u16(b, 20), 1); assert.equal(u16(b, 22), 1); assert.equal(u32(b, 24), 22050); assert.equal(u16(b, 34), 16);
  assert.equal(u32(b, 40), 2000);
});

test('loop adds a smpl chunk Godot can read', async () => {
  const b = await bytes(encodeWav([sine(5000)], 22050, 16, { start: 0, end: 5000 }));
  const i = b.length - 68;
  assert.equal(str(b, i, 4), 'smpl'); assert.equal(u32(b, i + 4), 60);
  assert.equal(u32(b, i + 8 + 28), 1, 'one loop');
  assert.equal(u32(b, i + 8 + 44), 0); assert.equal(u32(b, i + 8 + 48), 4999, 'inclusive end');
  assert.equal(u32(b, 4), b.length - 8);
});

test('24-bit stereo and 32-bit float formats', async () => {
  const b24 = await bytes(encodeWav([sine(10), sine(10)], 44100, 24));
  assert.equal(u16(b24, 22), 2); assert.equal(u16(b24, 34), 24); assert.equal(u32(b24, 40), 60);
  const f = await bytes(encodeWav([sine(10)], 44100, 32));
  assert.equal(u16(f, 20), 3);
});

test('odd data size is padded', async () => {
  const b = await bytes(encodeWav([sine(3)], 22050, 8));
  assert.equal(b.length % 2, 0); assert.equal(u32(b, 4), b.length - 8);
});

test('loopSeam shortens by the fade', () => {
  const sr = 22050;
  const out = loopSeam([sine(sr, sr, 100.5)], sr, 0.1)[0];
  assert.equal(out.length, sr - Math.floor(0.1 * sr));
});

test('trimTail removes silence, normalize hits the target', () => {
  const x = [new Float32Array(2000)]; x[0].set(sine(500, 22050, 440, 0.3));
  const t = trimTail(x, 22050, -60);
  assert.ok(t[0].length < 1000 && t[0].length >= 500);
  normalize(t, -1);
  assert.ok(Math.abs(peak(t) - Math.pow(10, -1 / 20)) < 1e-6);
});

test('zip has local headers, central directory and end record', async () => {
  const z = await bytes(await makeZip([{ name: 'a.wav', blob: encodeWav([sine(10)], 22050) }, { name: 'b.json', blob: new Blob(['{}']) }]));
  assert.equal(u32(z, 0), 0x04034b50);
  const end = z.length - 22;
  assert.equal(u32(z, end), 0x06054b50); assert.equal(u16(z, end + 10), 2);
  assert.equal(u32(z, u32(z, end + 16)), 0x02014b50);
});
