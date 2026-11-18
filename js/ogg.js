// Ogg Vorbis encoding — the compressed format Godot 4 plays natively
// (AudioStreamOggVorbis), roughly a tenth the size of 16-bit WAV for music.
//
// Uses libvorbis compiled to WebAssembly (wasm-media-encoders 0.7.0, MIT; libvorbis
// and libogg are BSD — see js/vendor/wasm-media-encoders/NOTICE.md). Loaded on first
// use only, so it costs nothing until you export an OGG. The WASM is handed over as
// bytes rather than a URL so it works whatever MIME type the server sends.

const BASE = new URL('./vendor/wasm-media-encoders/', import.meta.url);
let encoderP = null;

function loadLibrary() {
  if (globalThis.WasmMediaEncoder) return Promise.resolve(globalThis.WasmMediaEncoder);
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = new URL('WasmMediaEncoder.min.js', BASE).href;
    s.onload = () => (globalThis.WasmMediaEncoder ? resolve(globalThis.WasmMediaEncoder) : reject(new Error('Ogg encoder did not load')));
    s.onerror = () => reject(new Error('Could not load the Ogg encoder'));
    document.head.appendChild(s);
  });
}

function encoder() {
  if (!encoderP) {
    encoderP = (async () => {
      const lib = await loadLibrary();
      const res = await fetch(new URL('ogg.wasm', BASE));
      if (!res.ok) throw new Error(`Could not fetch ogg.wasm (${res.status})`);
      return lib.createEncoder('audio/ogg', await res.arrayBuffer());
    })().catch((e) => { encoderP = null; throw e; });
  }
  return encoderP;
}

/**
 * channels: Float32Array[] (1 or 2), quality: Vorbis VBR quality −1…10
 * (≈ 3: 112 kb/s, 5: 160 kb/s, 6: 192 kb/s stereo at 44.1 kHz). Returns a Blob.
 */
export async function encodeOgg(channels, sampleRate, quality = 5) {
  if (channels.length < 1 || channels.length > 2) throw new Error('Ogg export supports mono or stereo');
  const enc = await encoder();
  enc.configure({ channels: channels.length, sampleRate, vbrQuality: Math.max(-1, Math.min(10, quality)) });
  const parts = [];
  const n = channels[0].length, block = 16384;
  for (let i = 0; i < n; i += block) {
    const out = enc.encode(channels.map((c) => c.subarray(i, Math.min(n, i + block))));
    if (out.length) parts.push(out.slice()); // the encoder owns `out`: copy it
  }
  parts.push(enc.finalize().slice());
  return new Blob(parts, { type: 'audio/ogg' });
}

/** Encode a render result in the project's export format. Returns {blob, ext}. */
export async function encodeRender(r, exp, encodeWav) {
  if (exp.format === 'ogg') return { blob: await encodeOgg(r.channels, r.sampleRate, exp.oggQuality ?? 5), ext: 'ogg' };
  return { blob: encodeWav(r.channels, r.sampleRate, exp.bitDepth, r.loop), ext: 'wav' };
}
