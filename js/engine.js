// Graph compiler + transport.
//
// `compile` turns the project graph into real Web Audio nodes inside any
// BaseAudioContext. Live playback runs a look-ahead scheduler over it; export runs the
// very same compile in an OfflineAudioContext, so a rendered .wav is sample-for-sample
// the patch you were listening to (bar the live-only analysers).

import { TYPES } from './nodes.js';
import { ensureWorklets } from './worklets.js';
import * as wav from './wav.js';

const LOOKAHEAD = 0.25;   // seconds of events scheduled ahead of the clock
const TICK_MS = 40;

export function loopSeconds(project) { return (project.lengthBeats * 60) / project.bpm; }

/** Nodes feeding (transitively) into the given output ids. */
function upstream(project, outIds) {
  const seen = new Set(outIds), stack = [...outIds];
  while (stack.length) {
    const id = stack.pop();
    for (const l of project.links) if (l.to.node === id && !seen.has(l.from.node)) { seen.add(l.from.node); stack.push(l.from.node); }
  }
  return seen;
}

function compile(ctx, project, buffers, dest, onlyOutput) {
  const byId = new Map(project.nodes.map((n) => [n.id, n]));
  const outs = project.nodes.filter((n) => n.type === 'output' && (onlyOutput ? n.id === onlyOutput : true)).map((n) => n.id);
  const active = upstream(project, outs);
  const env = { ctx, buffers, bpm: project.bpm };
  const inst = new Map();

  for (const id of active) {
    const n = byId.get(id), T = TYPES[n.type];
    if (!T || !T.build) continue;
    try { inst.set(id, T.build(ctx, n.params, env)); } catch (e) { console.warn('build failed', n.type, e); }
  }
  for (const l of project.links) {
    const a = inst.get(l.from.node), b = inst.get(l.to.node);
    if (!a || !b || !a.outputs) continue;
    const src = a.outputs[l.from.port];
    if (!src) continue;
    try {
      if (l.to.port.startsWith('p:')) {
        const p = b.params && b.params[l.to.port.slice(2)];
        for (const x of Array.isArray(p) ? p : p ? [p] : []) src.connect(x);
      } else if (b.inputs && b.inputs[l.to.port]) src.connect(b.inputs[l.to.port]);
    } catch (e) { console.warn('connect failed', e); }
  }
  for (const [, i] of inst) if (i.sink) i.sink.connect(dest);

  // note consumers and how to resolve their incoming event streams
  const linksInto = (id, port) => project.links.filter((l) => l.to.node === id && l.to.port === port);
  const resolve = (id, port, p0, p1, depth = 0) => {
    if (depth > 32) return [];
    let evs = [];
    for (const l of linksInto(id, port)) {
      const src = byId.get(l.from.node), T = TYPES[src.type];
      if (T.events) evs = evs.concat(T.events(src.params, p0, p1, env, src.data || {}));
      else if (T.transform) evs = evs.concat(T.transform(src.params, resolve(src.id, 'notes', p0, p1, depth + 1)));
    }
    return evs;
  };
  const consumers = [];
  for (const [id, i] of inst) {
    if (!i.note) continue;
    const n = byId.get(id), T = TYPES[n.type];
    consumers.push({ id, n, i, T, connected: linksInto(id, 'notes').length > 0 });
  }

  return {
    inst, consumers, active,
    /** Schedule events in project-local window [p0,p1) at ctx time `base` + t. */
    schedule(base, p0, p1, L, onEvent) {
      const batch = [];
      for (const c of consumers) {
        let evs;
        if (c.connected) evs = resolve(c.id, 'notes', p0, p1);
        else if (c.T.implicit && p0 <= 0 && 0 < p1) evs = [{ t: 0, dur: c.T.implicit === 'hold' ? c.n.params.hold : L, note: null, vel: 1 }];
        else continue;
        for (const e of evs) batch.push([c, e]);
      }
      batch.sort((x, y) => x[1].t - y[1].t);
      for (const [c, e] of batch) {
        const ev = { ...e, t: base + e.t };
        try { c.i.note(ev); } catch (err) { console.warn(err); }
        onEvent && onEvent(c.id, ev.t);
      }
    },
    start(t) { for (const [, i] of inst) try { i.start && i.start(t); } catch {} },
    stop(t) { for (const [, i] of inst) try { i.stop && i.stop(t); } catch {} },
  };
}

/** Schedule iterations of a period-L loop covering absolute window [a,b) from origin T0. */
function scheduleRange(g, T0, a, b, L, onEvent) {
  let t = a;
  while (t < b - 1e-9) {
    const k = Math.floor((t - T0) / L + 1e-9);
    const base = T0 + k * L;
    const end = Math.min(b, base + L);
    g.schedule(base, t - base, end - base, L, onEvent);
    t = end;
  }
}

export class Engine {
  constructor(getProject) {
    this.getProject = getProject;
    this.buffers = new Map();     // sampleId -> AudioBuffer
    this.ctx = null;
    this.graph = null;
    this.playing = false;
    this.loop = true;
    this.solo = null;
    this.onActivity = null;       // (nodeId, ctxTime) => void
    this.onStop = null;
  }

  async ensureCtx() {
    if (!this.ctx) {
      this.ctx = new AudioContext({ latencyHint: 'interactive' });
      this.master = this.ctx.createGain();
      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = 2048;
      this.master.connect(this.analyser).connect(this.ctx.destination);
      await ensureWorklets(this.ctx);
    }
    if (this.ctx.state !== 'running') await this.ctx.resume();
    return this.ctx;
  }

  async decode(id, bytes) {
    const ctx = this.ctx || new OfflineAudioContext(1, 1, 44100);
    const buf = await ctx.decodeAudioData(bytes.slice(0));
    this.buffers.set(id, buf);
    return buf;
  }

  get L() {
    const p = this.getProject();
    if (this.solo) {
      const o = p.nodes.find((n) => n.id === this.solo);
      if (o && o.params.length > 0) return o.params.length;
    }
    return loopSeconds(p);
  }

  position() {
    if (!this.playing) return 0;
    const t = this.ctx.currentTime - this.T0;
    return this.loop ? ((t % this.L) + this.L) % this.L : Math.min(t, this.L);
  }

  async play(solo = null) {
    await this.ensureCtx();
    if (this.playing) this.stop();
    this.solo = solo;
    this.T0 = this.ctx.currentTime + 0.06;
    this._build();
    this.playing = true;
    this._timer = setInterval(() => this._tick(), TICK_MS);
    this._tick();
  }

  _build() {
    const ctx = this.ctx;
    this.bus = ctx.createGain();
    this.bus.connect(this.master);
    this.graph = compile(ctx, this.getProject(), this.buffers, this.bus, this.solo);
    const start = Math.max(this.T0, ctx.currentTime + 0.01);
    this.graph.start(start);
    this.until = start;
  }

  _teardown() {
    if (!this.graph) return;
    const t = this.ctx.currentTime, bus = this.bus, g = this.graph;
    bus.gain.setTargetAtTime(0, t, 0.008);
    g.stop(t + 0.06);
    setTimeout(() => { try { bus.disconnect(); } catch {} }, 200);
    this.graph = null;
  }

  _tick() {
    if (!this.playing) return;
    const now = this.ctx.currentTime, L = this.L;
    const horizon = now + LOOKAHEAD;
    if (!this.loop && now > this.T0 + L + this._tailGuess()) { this.stop(); return; }
    if (this.until < horizon) {
      const end = this.loop ? horizon : Math.min(horizon, this.T0 + L);
      if (end > this.until) scheduleRange(this.graph, this.T0, this.until, end, L, this.onActivity);
      this.until = horizon;
    }
  }

  _tailGuess() {
    const p = this.getProject();
    return Math.max(0.5, ...p.nodes.filter((n) => n.type === 'output').map((n) => n.params.tail || 0));
  }

  stop() {
    if (!this.playing) return;
    clearInterval(this._timer);
    this._teardown();
    this.playing = false;
    this.onStop && this.onStop();
  }

  /** Graph structure changed: rebuild in place, keeping the transport running. */
  rebuild() {
    if (!this.playing) return;
    this._teardown();
    this._build(); // schedules from "now" onward; the transport position is unchanged
  }

  setParam(nodeId, key, value) {
    if (!this.playing || !this.graph) return;
    const i = this.graph.inst.get(nodeId);
    if (!i) return;
    const t = this.ctx.currentTime;
    const r = i.set ? i.set(key, value, t) : undefined;
    if (r === true) return;
    const p = i.params && i.params[key];
    if (r !== null && p) {
      for (const x of Array.isArray(p) ? p : [p]) { x.cancelScheduledValues(t); x.setTargetAtTime(value, t, 0.012); }
      return;
    }
    if (r === null || (!p && !i.set)) this.rebuild();
  }

  analyserFor(nodeId) {
    const i = this.graph && this.graph.inst.get(nodeId);
    return i && i.analyser;
  }

  /**
   * Offline render of one Output node to processed float channels.
   * Returns {channels, sampleRate, loop:{start,end}|null, seconds, peak}.
   */
  async render(outputId, exp) {
    const project = this.getProject();
    const o = project.nodes.find((n) => n.id === outputId);
    const P = o.params, sr = exp.sampleRate, ch = exp.channels;
    const L = P.length > 0 ? P.length : loopSeconds(project);
    const seam = P.loop ? Math.min(P.seam, L / 3) : 0;
    const total = P.loop ? 2 * L + seam : L + P.tail;
    const frames = Math.max(1, Math.ceil(total * sr));
    const ctx = new OfflineAudioContext(ch, frames, sr);
    await ensureWorklets(ctx);
    const g = compile(ctx, project, this.buffers, ctx.destination, outputId);
    g.start(0);
    if (P.loop) scheduleRange(g, 0, 0, total, L);
    else g.schedule(0, 0, L, L);
    const rendered = await ctx.startRendering();
    let chans = Array.from({ length: ch }, (_, c) => rendered.getChannelData(c));
    let loop = null;
    if (P.loop) {
      // take the 2nd iteration so tails from the 1st are already ringing into it,
      // then fold `seam` seconds of the 3rd over its head
      const a = Math.round(L * sr), n = Math.round(L * sr), f = Math.round(seam * sr);
      chans = chans.map((c) => c.slice(a, a + n + f));
      if (f > 1) chans = wav.loopSeam(chans, sr, seam);
      loop = { start: 0, end: chans[0].length };
    } else {
      chans = chans.map((c) => c.slice());
      if (exp.trim) chans = wav.trimTail(chans, sr, exp.trimDb ?? -60);
      wav.fadeIn(chans, Math.round(sr * 0.0005));
      wav.fadeOut(chans, Math.min(chans[0].length, Math.round(sr * 0.004)));
    }
    const rawPeak = wav.peak(chans);
    if (exp.normalize) wav.normalize(chans, exp.peakDb);
    return { channels: chans, sampleRate: sr, loop, seconds: chans[0].length / sr, peak: rawPeak, name: P.name };
  }

  async renderWav(outputId, exp) {
    const r = await this.render(outputId, exp);
    return { ...r, blob: wav.encodeWav(r.channels, r.sampleRate, exp.bitDepth, r.loop) };
  }
}
