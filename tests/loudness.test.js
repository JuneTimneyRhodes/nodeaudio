import test from 'node:test';
import assert from 'node:assert/strict';
import { measureLufs } from '../js/loudness.js';

const tone = (sec, sr, f, amp) => Float32Array.from({ length: Math.round(sec * sr) }, (_, i) => amp * Math.sin((2 * Math.PI * f * i) / sr));

// BS.1770 is defined so that a full-scale 997 Hz sine in one channel reads -3.01 LUFS
test('0 dBFS 997 Hz sine reads -3.01 LUFS at 48 kHz', () => {
  assert.ok(Math.abs(measureLufs([tone(3, 48000, 997, 1)], 48000) + 3.01) < 0.05);
});

test('-20 dBFS reads 20 dB lower, at 44.1 and 22.05 kHz too', () => {
  for (const sr of [44100, 22050]) assert.ok(Math.abs(measureLufs([tone(3, sr, 997, 0.1)], sr) + 23.01) < 0.1, String(sr));
});

test('stereo sums channel power (+3 dB)', () => {
  const x = tone(3, 48000, 997, 0.1);
  assert.ok(Math.abs(measureLufs([x, x], 48000) - measureLufs([x], 48000) - 3.01) < 0.05);
});

test('silence is -Infinity; short cues still measure', () => {
  assert.equal(measureLufs([new Float32Array(48000)], 48000), -Infinity);
  assert.ok(isFinite(measureLufs([tone(0.1, 22050, 1000, 0.5)], 22050)));
});
