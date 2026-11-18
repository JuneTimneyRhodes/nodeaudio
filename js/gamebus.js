// Monitoring through approximations of space-rogue's bus layout
// (assets/audio/default_bus_layout.tres), so a cue can be judged with the room the game
// will put on it — and so the room does not get baked into the file twice.
//
// Godot's AudioEffectReverb is a Freeverb; these map its settings onto a convolution
// tail by ear: room_size -> decay time, damping -> lowpass on the tail, hipass -> highpass.

import { reverbIR, dbToGain } from './nodes.js';

export const BUSES = {
  SFX: { volume: 0, reverb: { predelay: 0.032, room: 0.82, damping: 0.55, hipass: 0.08, dry: 1, wet: 0.3 } },
  SFXFar: {
    volume: -2,
    reverb: { predelay: 0.08, room: 0.95, damping: 0.72, hipass: 0.12, dry: 0.55, wet: 0.7 },
    delay: { dry: 0.85, taps: [[0.27, -14, 0.3], [0.46, -20, -0.3]], feedbackDb: -18, lowpass: 2200 },
  },
  Cockpit: { volume: 0 },
  UI: { volume: 0 },
  Music: { volume: 0 },
  Master: { volume: 0 },
};

const decayOf = (room) => 0.6 + 3.2 * room * room;
const dampHz = (d) => 800 + 11000 * (1 - d);
const hipassHz = (h) => 20 + h * 1000;

/** Returns an input node that feeds `dest` through the named bus. */
export function makeBus(ctx, name, dest) {
  const B = BUSES[name] || BUSES.Master;
  const input = ctx.createGain();
  const vol = ctx.createGain();
  vol.gain.value = dbToGain(B.volume);
  vol.connect(dest);
  let head = input;
  if (B.reverb) {
    const r = B.reverb, out = ctx.createGain(), dry = ctx.createGain(), wet = ctx.createGain(), pre = ctx.createDelay(1), conv = ctx.createConvolver();
    dry.gain.value = r.dry; wet.gain.value = r.wet; pre.delayTime.value = r.predelay;
    conv.buffer = reverbIR(ctx, decayOf(r.room), dampHz(r.damping), 4242, hipassHz(r.hipass));
    head.connect(dry).connect(out); head.connect(pre).connect(conv).connect(wet).connect(out);
    head = out;
  }
  if (B.delay) {
    const d = B.delay, out = ctx.createGain(), dry = ctx.createGain();
    dry.gain.value = d.dry; head.connect(dry).connect(out);
    const fbBus = ctx.createGain(); fbBus.gain.value = dbToGain(d.feedbackDb);
    const lp = ctx.createBiquadFilter(); lp.frequency.value = d.lowpass;
    for (const [sec, db, pan] of d.taps) {
      const dl = ctx.createDelay(2), g = ctx.createGain(), p = ctx.createStereoPanner();
      dl.delayTime.value = sec; g.gain.value = dbToGain(db); p.pan.value = pan;
      head.connect(dl); dl.connect(g).connect(p).connect(out); dl.connect(lp);
      lp.connect(fbBus).connect(dl);
    }
    head = out;
  }
  head.connect(vol);
  return input;
}
