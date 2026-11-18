// WAV encoding, post-processing and a tiny store-only ZIP writer.
//
// Export target is Godot 4's WAV importer (space-rogue-repo): PCM, 8/16/24-bit or
// 32-bit float, with an optional `smpl` chunk. Godot 4's default import loop mode is
// "Detect From WAV", which reads loop start/end from that chunk — so a looping cue
// exported here loops in-game with no .import edits.

/** Peak absolute sample across channels. */
export function peak(channels) {
  let p = 0;
  for (const ch of channels) for (let i = 0; i < ch.length; i++) { const a = Math.abs(ch[i]); if (a > p) p = a; }
  return p;
}

export function normalize(channels, peakDb) {
  const p = peak(channels);
  if (p <= 1e-9) return;
  const g = Math.pow(10, peakDb / 20) / p;
  for (const ch of channels) for (let i = 0; i < ch.length; i++) ch[i] *= g;
}

/** Drop trailing samples below threshold (dB), keeping a short fade so it cannot click. */
export function trimTail(channels, sampleRate, thresholdDb = -60) {
  const thr = Math.pow(10, thresholdDb / 20);
  let last = 0;
  for (const ch of channels) for (let i = ch.length - 1; i > last; i--) if (Math.abs(ch[i]) > thr) { last = i; break; }
  const pad = Math.floor(sampleRate * 0.01);
  const end = Math.min(channels[0].length, last + pad + 1);
  const out = channels.map((ch) => ch.slice(0, Math.max(end, 1)));
  fadeOut(out, Math.min(pad, out[0].length));
  return out;
}

export function fadeOut(channels, n) {
  for (const ch of channels) {
    const len = ch.length;
    for (let i = 0; i < n; i++) ch[len - n + i] *= 1 - (i + 1) / n;
  }
}

export function fadeIn(channels, n) {
  for (const ch of channels) for (let i = 0; i < n && i < ch.length; i++) ch[i] *= i / n;
}

/**
 * Seamless loop: crossfade the tail over the head, then drop the tail. Equal-power,
 * same as Synth.loop_seam in the game, because loops there are noise-dominant and a
 * linear fade dips ~3 dB mid-fade (audible as pulsing at the loop rate).
 */
export function loopSeam(channels, sampleRate, fadeSec = 0.12) {
  const n = channels[0].length;
  const f = Math.min(Math.floor(fadeSec * sampleRate), Math.floor(n / 3));
  if (f <= 1) return channels;
  return channels.map((buf) => {
    const out = buf.slice(0, n - f);
    for (let i = 0; i < f; i++) {
      const k = i / f;
      out[i] = out[i] * Math.sqrt(k) + buf[n - f + i] * Math.sqrt(1 - k);
    }
    return out;
  });
}

/**
 * Encode PCM WAV. `loop` = {start, end} in frames (end exclusive) adds a smpl chunk.
 * bitDepth: 8 | 16 | 24 | 32 (32 = IEEE float).
 */
export function encodeWav(channels, sampleRate, bitDepth = 16, loop = null) {
  const numCh = channels.length;
  const frames = channels[0].length;
  const isFloat = bitDepth === 32;
  const bps = bitDepth / 8;
  const dataSize = frames * numCh * bps;
  const smplSize = loop ? 60 : 0;
  const total = 12 + 24 + 8 + dataSize + (dataSize & 1) + (loop ? 8 + smplSize : 0);
  const buf = new ArrayBuffer(total);
  const v = new DataView(buf);
  let o = 0;
  const str = (s) => { for (let i = 0; i < s.length; i++) v.setUint8(o++, s.charCodeAt(i)); };
  const u32 = (x) => { v.setUint32(o, x, true); o += 4; };
  const u16 = (x) => { v.setUint16(o, x, true); o += 2; };

  str('RIFF'); u32(total - 8); str('WAVE');
  str('fmt '); u32(16); u16(isFloat ? 3 : 1); u16(numCh); u32(sampleRate);
  u32(sampleRate * numCh * bps); u16(numCh * bps); u16(bitDepth);
  str('data'); u32(dataSize);

  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < numCh; c++) {
      let s = channels[c][i];
      if (isFloat) { v.setFloat32(o, s, true); o += 4; continue; }
      s = Math.max(-1, Math.min(1, s));
      if (bitDepth === 8) { v.setUint8(o, Math.round((s * 0.5 + 0.5) * 255)); o += 1; }
      else if (bitDepth === 16) { v.setInt16(o, Math.round(s < 0 ? s * 32768 : s * 32767), true); o += 2; }
      else { // 24
        const x = Math.round(s < 0 ? s * 8388608 : s * 8388607);
        v.setUint8(o, x & 0xff); v.setUint8(o + 1, (x >> 8) & 0xff); v.setUint8(o + 2, (x >> 16) & 0xff); o += 3;
      }
    }
  }
  if (dataSize & 1) v.setUint8(o++, 0);

  if (loop) {
    str('smpl'); u32(smplSize);
    u32(0); u32(0);                                   // manufacturer, product
    u32(Math.round(1e9 / sampleRate));                 // sample period (ns)
    u32(60); u32(0);                                   // MIDI unity note, pitch fraction
    u32(0); u32(0);                                    // SMPTE
    u32(1); u32(0);                                    // loop count, sampler data
    u32(0); u32(0);                                    // cue id, type (0 = forward)
    u32(loop.start); u32(Math.max(loop.start, loop.end - 1)); // inclusive end
    u32(0); u32(0);                                    // fraction, play count (0 = infinite)
  }
  return new Blob([buf], { type: 'audio/wav' });
}

// --- ZIP (store only) ---------------------------------------------------------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** files: [{name, blob}] -> Blob (application/zip) */
export async function makeZip(files) {
  const enc = new TextEncoder();
  const parts = [];
  const central = [];
  let offset = 0;
  for (const f of files) {
    const data = new Uint8Array(await f.blob.arrayBuffer());
    const name = enc.encode(f.name);
    const crc = crc32(data);
    const h = new DataView(new ArrayBuffer(30));
    h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x0800, true);
    h.setUint16(8, 0, true); h.setUint32(14, crc, true); h.setUint32(18, data.length, true);
    h.setUint32(22, data.length, true); h.setUint16(26, name.length, true);
    parts.push(h.buffer, name, data);
    const c = new DataView(new ArrayBuffer(46));
    c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true);
    c.setUint16(8, 0x0800, true); c.setUint32(16, crc, true); c.setUint32(20, data.length, true);
    c.setUint32(24, data.length, true); c.setUint16(28, name.length, true); c.setUint32(42, offset, true);
    central.push(c.buffer, name);
    offset += 30 + name.length + data.length;
  }
  const cSize = central.reduce((s, b) => s + (b.byteLength ?? b.length), 0);
  const e = new DataView(new ArrayBuffer(22));
  e.setUint32(0, 0x06054b50, true); e.setUint16(8, files.length, true); e.setUint16(10, files.length, true);
  e.setUint32(12, cSize, true); e.setUint32(16, offset, true);
  return new Blob([...parts, ...central, e.buffer], { type: 'application/zip' });
}
