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
`;

let url = null;
const loaded = new WeakSet();

export async function ensureWorklets(ctx) {
  if (loaded.has(ctx)) return;
  if (!url) url = URL.createObjectURL(new Blob([SRC], { type: 'application/javascript' }));
  await ctx.audioWorklet.addModule(url);
  loaded.add(ctx);
}
