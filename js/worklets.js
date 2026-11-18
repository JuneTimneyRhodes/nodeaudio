// AudioWorklet processors, loaded from a Blob URL so the app stays a single static
// folder (works on GitHub Pages and in OfflineAudioContext alike).

const SRC = `
class Crusher extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'bits', defaultValue: 8, minValue: 1, maxValue: 16, automationRate: 'k-rate' },
      { name: 'rate', defaultValue: 11025, minValue: 200, maxValue: 96000, automationRate: 'k-rate' },
      { name: 'mix', defaultValue: 1, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
    ];
  }
  constructor() { super(); this.held = []; this.acc = []; }
  process(inputs, outputs, p) {
    const inp = inputs[0], out = outputs[0];
    const levels = Math.pow(2, p.bits[0] - 1);
    const step = Math.min(1, p.rate[0] / sampleRate);
    const mix = p.mix[0];
    for (let c = 0; c < out.length; c++) {
      const i = inp[c] || inp[0];
      const o = out[c];
      if (!i) { o.fill(0); continue; }
      let h = this.held[c] || 0, a = this.acc[c] || 0;
      for (let n = 0; n < o.length; n++) {
        a += step;
        if (a >= 1) { a -= 1; h = Math.round(i[n] * levels) / levels; }
        o[n] = h * mix + i[n] * (1 - mix);
      }
      this.held[c] = h; this.acc[c] = a;
    }
    return true;
  }
}
registerProcessor('na-crusher', Crusher);

class Granular extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    const k = 'k-rate';
    return [
      { name: 'position', defaultValue: 0.3, minValue: 0, maxValue: 1, automationRate: k },
      { name: 'spray', defaultValue: 0.05, minValue: 0, maxValue: 1, automationRate: k },
      { name: 'size', defaultValue: 0.09, minValue: 0.002, maxValue: 2, automationRate: k },
      { name: 'density', defaultValue: 40, minValue: 0.1, maxValue: 1000, automationRate: k },
      { name: 'pitch', defaultValue: 0, minValue: -60, maxValue: 60, automationRate: k },
      { name: 'stereo', defaultValue: 0.6, minValue: 0, maxValue: 1, automationRate: k },
    ];
  }
  constructor(opts) {
    super();
    const o = (opts && opts.processorOptions) || {};
    this.ch = o.channels && o.channels.length ? o.channels : [new Float32Array(1)];
    this.len = this.ch[0].length;
    this.rate = o.rate || sampleRate;
    this.grains = [];
    this.acc = 1;
    let s = (o.seed >>> 0) || 1;
    this.r = () => { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
  }
  process(_, outputs, p) {
    const out = outputs[0], L = out[0], R = out[1] || out[0], n = L.length;
    L.fill(0); if (R !== L) R.fill(0);
    if (this.len < 4) return true;
    const dens = Math.max(0.1, p.density[0]), size = Math.max(0.002, p.size[0]);
    const pos = Math.min(1, Math.max(0, p.position[0])), spray = p.spray[0], st = p.stereo[0];
    const ratio = Math.pow(2, p.pitch[0] / 12) * this.rate / sampleRate;
    const glen = Math.max(16, Math.floor(size * sampleRate));
    const norm = 1 / Math.sqrt(Math.max(1, dens * size));
    const c0 = this.ch[0], c1 = this.ch[1] || this.ch[0], last = this.len - 2;
    for (let i = 0; i < n; i++) {
      this.acc += dens / sampleRate;
      if (this.acc >= 1 && this.grains.length < 128) {
        this.acc -= 1;
        let start = (pos + (this.r() * 2 - 1) * spray * 0.5) * this.len;
        start = Math.min(last, Math.max(0, start));
        const pan = (this.r() * 2 - 1) * st, a = (pan + 1) * Math.PI / 4;
        this.grains.push({ p: start, age: 0, len: glen, gl: Math.cos(a), gr: Math.sin(a) });
      }
      let l = 0, r = 0;
      for (let g = this.grains.length - 1; g >= 0; g--) {
        const G = this.grains[g];
        const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * G.age) / G.len);
        const i0 = G.p | 0, fr = G.p - i0;
        if (i0 >= 0 && i0 <= last) {
          l += (c0[i0] + (c0[i0 + 1] - c0[i0]) * fr) * w * G.gl;
          r += (c1[i0] + (c1[i0 + 1] - c1[i0]) * fr) * w * G.gr;
        }
        G.p += ratio; G.age++;
        if (G.age >= G.len) this.grains.splice(g, 1);
      }
      L[i] = l * norm * 1.41; if (R !== L) R[i] = r * norm * 1.41;
    }
    return true;
  }
}
registerProcessor('na-granular', Granular);
`;

let url = null;
const loaded = new WeakSet();

export async function ensureWorklets(ctx) {
  if (loaded.has(ctx)) return;
  if (!url) url = URL.createObjectURL(new Blob([SRC], { type: 'application/javascript' }));
  await ctx.audioWorklet.addModule(url);
  loaded.add(ctx);
}
