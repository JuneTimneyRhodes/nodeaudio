// Graph compiler + transport.
//
// `compile` turns the (flattened) project graph into real Web Audio nodes inside any
// BaseAudioContext. Live playback runs a look-ahead scheduler over it; export runs the
// very same compile in an OfflineAudioContext, so a rendered .wav is the patch you
// were listening to.

import { TYPES, POLY_AWARE, flat, setp, rng } from './nodes.js';
import { GS_TYPES, evaluate as gsEvaluate, cueKey, MIX_RATE } from './gamesynth.js';
import { ensureWorklets } from './worklets.js';
import { makeBus } from './gamebus.js';
import * as wav from './wav.js';
import { measureLufs } from './loudness.js';

const LOOKAHEAD = 0.25;
const TICK_MS = 40;
const LIVE_DUR = 1e5;

export function loopSeconds(project) { return (project.lengthBeats * 60) / project.bpm; }
export function songSeconds(project) { return ((project.song?.bars || 0) * 4 * 60) / project.bpm; }
export function timelineSeconds(project) { return project.song?.enabled ? songSeconds(project) : loopSeconds(project); }

// ---------------------------------------------------------------- flattening

/**
 * Inline every group into one flat graph. Inner node ids become "<groupId>/<id>"; the
 * params objects are shared with the project (not copied) so live edits reach the
 * running graph. Group In/Out become relay nodes that are then contracted away.
 */
export function flatten(graph, prefix = '') {
  const nodes = [], links = [], relays = new Set();
  const gid = new Map();
  for (const n of graph.nodes) {
    if (n.type === 'group') {
      const sub = flatten(n.data, prefix + n.id + '/');
      nodes.push(...sub.nodes); links.push(...sub.links);
      sub.relays.forEach((r) => relays.add(r));
      const gi = n.data.nodes.find((x) => x.type === 'group_in'), go = n.data.nodes.find((x) => x.type === 'group_out');
      gid.set(n.id, { gi: gi && prefix + n.id + '/' + gi.id, go: go && prefix + n.id + '/' + go.id });
    } else if (n.type === 'group_in' || n.type === 'group_out') {
      relays.add(prefix + n.id);
    } else nodes.push({ ...n, id: prefix + n.id, local: n.id, src: n });
  }
  for (const l of graph.links) {
    let from = { node: prefix + l.from.node, port: l.from.port }, to = { node: prefix + l.to.node, port: l.to.port };
    if (gid.has(l.from.node)) { const g = gid.get(l.from.node); if (!g.go) continue; from = { node: g.go, port: l.from.port }; }
    if (gid.has(l.to.node)) { const g = gid.get(l.to.node); if (!g.gi) continue; to = { node: g.gi, port: l.to.port }; }
    links.push({ from, to });
  }
  if (prefix) return { nodes, links, relays };
  return { nodes, links: contract(links, relays) };
}

function contract(links, relays) {
  let ls = links;
  for (const r of relays) {
    const into = ls.filter((l) => l.to.node === r), outof = ls.filter((l) => l.from.node === r);
    const rest = ls.filter((l) => l.to.node !== r && l.from.node !== r);
    for (const a of into) for (const b of outof) if (a.to.port === b.from.port) rest.push({ from: a.from, to: b.to });
    ls = rest;
  }
  return ls;
}

// ---------------------------------------------------------------- voices

/** Voice count per node: sources with a Voices param set it; poly-aware processors inherit. */
export function computeVoices(g) {
  const byId = new Map(g.nodes.map((n) => [n.id, n]));
  const memo = new Map();
  const V = (id, depth = 0) => {
    if (memo.has(id)) return memo.get(id);
    const n = byId.get(id);
    if (!n || depth > 64) return 1;
    const T = TYPES[n.type];
    let v = 1;
    if (T.voicesParam) v = Math.max(1, n.params.voices | 0);
    else if (POLY_AWARE.has(n.type)) {
      memo.set(id, 1); // cycle guard
      for (const l of g.links) if (l.to.node === id && !l.to.port.startsWith('p:')) v = Math.max(v, V(l.from.node, depth + 1));
    }
    memo.set(id, v);
    return v;
  };
  const out = new Map();
  for (const n of g.nodes) out.set(n.id, V(n.id));
  return out;
}

/** Deterministic voice allocator: two consumers fed the same notes allocate identically. */
export function makeAllocator(V) {
  const free = new Array(V).fill(-Infinity);
  return {
    alloc(ev) {
      if (V === 1) return 0;
      let best = -1;
      for (let i = 0; i < V; i++) if (free[i] <= ev.t + 1e-9) { best = i; break; }
      if (best < 0) { best = 0; for (let i = 1; i < V; i++) if (free[i] < free[best]) best = i; }
      free[best] = ev.t + ev.dur;
      return best;
    },
    release(voice, t) { if (voice < V) free[voice] = Math.min(free[voice], t); },
  };
}

// ---------------------------------------------------------------- song

/** Clip windows for a node on the arrangement, in seconds. */
export function clipsFor(project, nodeId) {
  const song = project.song;
  if (!song || !song.enabled) return null;
  const track = song.tracks.find((t) => t.node === nodeId);
  if (!track) return null;
  const spb = 60 / project.bpm;
  if (track.mute) return [];
  return song.clips.filter((c) => c.track === track.id).map((c) => ({ start: c.start * spb, end: (c.start + c.len) * spb, offset: (c.offset || 0) * spb }));
}

/** Events of a producer, gated/shifted by its clips when it lives on the arrangement. */
export function clipEvents(clips, eventsFn, p0, p1) {
  if (!clips) return eventsFn(p0, p1);
  const out = [];
  for (const c of clips) {
    const a = Math.max(p0, c.start), b = Math.min(p1, c.end);
    if (a >= b) continue;
    for (const e of eventsFn(a - c.start + c.offset, b - c.start + c.offset)) {
      const t = e.t - c.offset + c.start;
      out.push({ ...e, t, dur: Math.min(e.dur, c.end - t) });
    }
  }
  return out;
}

// ---------------------------------------------------------------- compile

const arr = (x) => (Array.isArray(x) ? x : x ? [x] : []);

function connectArrays(A, B) {
  if (!A.length || !B.length) return;
  if (A.length === B.length) A.forEach((a, i) => flat(B[i]).forEach((b) => a.connect(b)));
  else if (A.length === 1) B.forEach((b) => flat(b).forEach((x) => A[0].connect(x)));
  else if (B.length === 1) A.forEach((a) => flat(B[0]).forEach((x) => a.connect(x)));
  else A.forEach((a, i) => flat(B[i % B.length]).forEach((x) => a.connect(x)));
}

function compile(ctx, project, g, opts) {
  const byId = new Map(g.nodes.map((n) => [n.id, n]));
  let outs = g.nodes.filter((n) => n.type === 'output' && (opts.onlyOutput ? n.id === opts.onlyOutput : !n.params.mute));
  if (opts.liveOnly) {
    // idle (keyboard) mode: only outputs that something played live can reach
    const reach = new Set(g.nodes.filter((n) => n.type === 'liveinput').map((n) => n.id)), stack = [...reach];
    while (stack.length) { const id = stack.pop(); for (const l of g.links) if (l.from.node === id && !reach.has(l.to.node)) { reach.add(l.to.node); stack.push(l.to.node); } }
    outs = outs.filter((n) => reach.has(n.id));
  }
  const active = new Set(outs.map((n) => n.id)), stack = [...active];
  while (stack.length) { const id = stack.pop(); for (const l of g.links) if (l.to.node === id && !active.has(l.from.node)) { active.add(l.from.node); stack.push(l.from.node); } }

  const voicesOf = computeVoices(g);
  const env = {
    ctx, buffers: opts.buffers, sampleMeta: opts.sampleMeta, bpm: project.bpm, variant: opts.variant || 0, cents: opts.cents || 0, live: !!opts.live,
    gsBuffer: opts.gsBuffer,
  };
  const inst = new Map();
  for (const id of active) {
    const n = byId.get(id), T = TYPES[n.type];
    if (!T || !T.build) continue;
    try { inst.set(id, T.build(ctx, n.params, { ...env, id, graph: g }, voicesOf.get(id) || 1)); } catch (e) { console.warn('build failed', n.type, e); }
  }
  for (const l of g.links) {
    const a = inst.get(l.from.node), b = inst.get(l.to.node);
    if (!a || !b || !a.outputs) continue;
    const src = arr(a.outputs[l.from.port]);
    try {
      if (l.to.port.startsWith('p:')) connectArrays(src, arr(b.params && b.params[l.to.port.slice(2)]));
      else if (b.inputs) connectArrays(src, arr(b.inputs[l.to.port]));
    } catch (e) { console.warn('connect failed', e); }
  }
  const buses = new Map();
  for (const n of outs) {
    const i = inst.get(n.id);
    if (!i || !i.sink) continue;
    if (opts.monitor === 'game') {
      const b = n.params.bus || 'Master';
      if (!buses.has(b)) buses.set(b, makeBus(ctx, b, opts.dest));
      i.sink.connect(buses.get(b));
    } else i.sink.connect(opts.dest);
  }

  // note routing -------------------------------------------------------------
  const linksInto = (id, port) => g.links.filter((l) => l.to.node === id && l.to.port === port);
  const clipCache = new Map();
  const clipsOf = (n) => {
    if (n.id.includes('/')) return null; // only root-level nodes live on the arrangement
    if (!clipCache.has(n.id)) clipCache.set(n.id, clipsFor(project, n.id));
    return clipCache.get(n.id);
  };
  const resolve = (id, port, p0, p1, depth = 0) => {
    if (depth > 32) return [];
    let evs = [];
    for (const l of linksInto(id, port)) {
      const src = byId.get(l.from.node), T = TYPES[src.type];
      if (T.events) evs = evs.concat(clipEvents(clipsOf(src), (a, b) => T.events(src.params, a, b, env, src.data || {}), p0, p1));
      else if (T.transform) evs = evs.concat(T.transform(src.params, resolve(src.id, 'notes', p0, p1, depth + 1)));
    }
    return evs;
  };
  const liveRoutes = (id, depth = 0) => {
    if (depth > 32) return [];
    const out = [];
    for (const l of linksInto(id, 'notes')) {
      const src = byId.get(l.from.node);
      if (src.type === 'liveinput') out.push({ live: src, chain: [] });
      else if (TYPES[src.type].transform) for (const r of liveRoutes(src.id, depth + 1)) out.push({ live: r.live, chain: [...r.chain, src] });
    }
    return out;
  };
  const consumers = [];
  for (const [id, i] of inst) {
    if (!i.note) continue;
    const n = byId.get(id), T = TYPES[n.type];
    consumers.push({ id, n, i, T, connected: linksInto(id, 'notes').length > 0, clips: clipsOf(n), alloc: makeAllocator(voicesOf.get(id) || 1), routes: liveRoutes(id) });
  }
  const byParams = new Map();
  for (const n of g.nodes) byParams.set(n.params, n.id);

  return {
    inst, consumers, active, byParams, byId,
    /** Schedule events in project-local window [p0,p1) at ctx time `base` + t. */
    schedule(base, p0, p1, L, onEvent, fresh = false) {
      const batch = [];
      for (const c of consumers) {
        let evs = [];
        if (c.clips && TYPES[c.n.type].implicit) {
          // a source on the arrangement: each clip plays it from the clip's offset
          for (const cl of c.clips) {
            if (cl.start >= p0 && cl.start < p1) evs.push({ t: cl.start, dur: cl.end - cl.start, note: null, vel: 1, offset: cl.offset, gate: true });
            else if (fresh && cl.start < p0 && cl.end > p0) evs.push({ t: p0, dur: cl.end - p0, note: null, vel: 1, offset: cl.offset + p0 - cl.start, gate: true });
          }
          if (c.connected) evs = evs.concat(resolve(c.id, 'notes', p0, p1));
        } else if (c.connected) evs = resolve(c.id, 'notes', p0, p1);
        else if (c.T.implicit && p0 <= 0 && 0 < p1) evs = [{ t: 0, dur: c.T.implicit === 'hold' ? c.n.params.hold : L, note: null, vel: 1 }];
        evs.sort((a, b) => a.t - b.t);
        for (const e of evs) { e.voice = c.alloc.alloc(e); batch.push([c, e]); }
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
function scheduleRange(g, T0, a, b, L, onEvent, fresh = false) {
  let t = a;
  while (t < b - 1e-9) {
    const k = Math.floor((t - T0) / L + 1e-9);
    const base = T0 + k * L;
    const end = Math.min(b, base + L);
    g.schedule(base, t - base, end - base, L, onEvent, fresh);
    fresh = false;
    t = end;
  }
}

function hashStr(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }

export class Engine {
  constructor(getProject) {
    this.getProject = getProject;
    this.buffers = new Map();     // sampleId -> AudioBuffer
    this.ctx = null;
    this.graph = null;
    this.playing = false;
    this.idle = false;
    this.loop = true;
    this.solo = null;
    this.monitor = 'dry';
    this.onActivity = null;
    this.onStop = null;
    this.onLiveNote = null;       // (on, note, vel) for recording
    this.held = new Map();
    this.released = new Set();    // live notes let go before their note-on finished
    this.gsCache = new Map();     // cueKey -> AudioBuffer
  }

  get sampleMeta() {
    const m = new Map();
    for (const s of this.getProject().samples) m.set(s.id, { slices: s.slices, loop: s.loop });
    return m;
  }

  gsBufferFor(graph, id, P) {
    const key = cueKey(graph, id) + '#' + P.seed;
    if (this.gsCache.has(key)) return this.gsCache.get(key);
    const data = gsEvaluate(graph, id, P.seed);
    const b = new AudioBuffer({ length: Math.max(1, data.length), numberOfChannels: 1, sampleRate: MIX_RATE });
    b.copyToChannel(data, 0);
    if (this.gsCache.size > 64) this.gsCache.clear();
    this.gsCache.set(key, b);
    return b;
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
      const o = flatten(p).nodes.find((n) => n.id === this.solo);
      if (o && o.params.length > 0) return o.params.length;
    }
    return Math.max(0.05, timelineSeconds(p));
  }

  position() {
    if (!this.playing) return this._pos || 0;
    const t = this.ctx.currentTime - this.T0;
    return this.loop ? ((t % this.L) + this.L) % this.L : Math.max(0, Math.min(t, this.L));
  }

  async play(solo = null, from = null) {
    await this.ensureCtx();
    if (this.playing || this.idle) this._halt();
    this.solo = solo;
    const start = from == null ? (this._pos || 0) : from;
    this.T0 = this.ctx.currentTime + 0.06 - start;
    this.playing = true;
    this._build(false);
    this._timer = setInterval(() => this._tick(), TICK_MS);
    this._tick();
  }

  /** Move the playhead. Keeps playing if playing. */
  seek(pos) {
    this._pos = Math.max(0, pos);
    if (this.playing) this.play(this.solo, this._pos);
  }

  /** Build the graph without the transport, so live notes can play. */
  async startIdle() {
    await this.ensureCtx();
    if (this.playing || this.idle) return;
    this.T0 = this.ctx.currentTime;
    this.idle = true;
    this._build(true);
  }

  _build(liveOnly) {
    const ctx = this.ctx;
    this.bus = ctx.createGain();
    this.bus.connect(this.master);
    const p = this.getProject();
    const g = flatten(p);
    this.flat = g;
    this.graph = compile(ctx, p, g, {
      buffers: this.buffers, sampleMeta: this.sampleMeta, dest: this.bus, onlyOutput: this.solo, live: true, liveOnly,
      monitor: this.monitor, gsBuffer: (id, P) => this.gsBufferFor(g, id, P),
    });
    const start = Math.max(this.T0, ctx.currentTime + 0.01);
    this.graph.start(Math.min(start, ctx.currentTime + 0.07));
    this.until = Math.max(ctx.currentTime + 0.01, this.T0);
    this._fresh = true;
    this.held.clear();
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
    if (!this.loop && now > this.T0 + L + this._tailGuess()) { this._pos = 0; this.stop(); return; }
    if (this.until < horizon) {
      const end = this.loop ? horizon : Math.min(horizon, this.T0 + L);
      if (end > this.until) scheduleRange(this.graph, this.T0, this.until, end, L, this.onActivity, this._fresh);
      this._fresh = false;
      this.until = horizon;
    }
  }

  _tailGuess() {
    return Math.max(0.5, ...flatten(this.getProject()).nodes.filter((n) => n.type === 'output').map((n) => n.params.tail || 0));
  }

  _halt() {
    clearInterval(this._timer);
    this._teardown();
    this.playing = false;
    this.idle = false;
  }

  stop() {
    if (!this.playing && !this.idle) return;
    if (this.playing) this._pos = this.loop ? this.position() : 0;
    this._halt();
    this.onStop && this.onStop();
  }

  /** Back to bar 1. */
  rewind() { this._pos = 0; if (this.playing) this.play(this.solo, 0); }

  /** Graph structure changed: rebuild in place, keeping the transport running. */
  rebuild() {
    if (this.playing) { this._teardown(); this._build(false); this._fresh = true; }
    else if (this.idle) { this._teardown(); this._build(true); }
  }

  rebuildSoon() { clearTimeout(this._rb); this._rb = setTimeout(() => this.rebuild(), 80); }

  setMonitor(mode) { this.monitor = mode; this.rebuild(); }

  /** Live edit of a parameter. Found by params identity, so it works inside groups. */
  setParam(params, key, value) {
    if (!this.graph) return;
    const id = this.graph.byParams.get(params);
    if (id == null) return;
    const n = this.graph.byId.get(id);
    if (n && GS_TYPES[n.type] && n.type !== 'gs_out') { this.rebuildSoon(); return; }
    const i = this.graph.inst.get(id);
    if (!i) return;
    const t = this.ctx.currentTime;
    const r = i.set ? i.set(key, value, t) : undefined;
    if (r === true) return;
    const p = i.params && i.params[key];
    if (r !== null && p) { setp(p, value, t); return; }
    if (r === null || (!p && !i.set)) this.rebuild();
  }

  idOf(params) { return this.graph ? this.graph.byParams.get(params) : null; }
  isActive(params) { const id = this.idOf(params); return !!(id && this.graph.active.has(id)); }
  analyserFor(params) { const id = this.idOf(params); const i = id && this.graph.inst.get(id); return i && i.analyser; }

  // ---------------------------------------------------------------- live notes
  async liveOn(id, note, vel = 0.9, channel = 0) {
    this.released.delete(id);
    if (!this.graph) await this.startIdle();
    const g = this.graph;
    if (!g) return;
    const now = this.ctx.currentTime + 0.005, list = [];
    for (const c of g.consumers) {
      for (const r of c.routes) {
        const ch = r.live.params.channel | 0;
        if (ch && channel && ch !== channel) continue;
        let evs = [{ t: now, dur: LIVE_DUR, note: note + 12 * (r.live.params.octave | 0), vel, id }];
        for (const tr of r.chain) evs = TYPES[tr.type].transform(tr.params, evs);
        for (const e of evs) {
          e.t = Math.max(now, e.t); e.dur = LIVE_DUR; e.id = id;
          e.voice = c.alloc.alloc(e);
          try { c.i.note(e); } catch (err) { console.warn(err); }
          list.push([c, e]);
          this.onActivity && this.onActivity(c.id, e.t);
        }
      }
    }
    this.held.set(id, list);
    this.onLiveNote && this.onLiveNote(true, note, vel, id);
    // the key was let go while the graph was still starting: play it as a short tap
    if (this.released.has(id)) { this.released.delete(id); this.liveOff(id, 0.12); }
  }

  liveOff(id, after = 0.005) {
    const list = this.held.get(id);
    this.held.delete(id);
    if (!list || !this.ctx) { this.released.add(id); return; }
    const t = this.ctx.currentTime + after;
    for (const [c, e] of list) { try { c.i.release && c.i.release(e, t); } catch {} c.alloc.release(e.voice, t); }
    this.onLiveNote && this.onLiveNote(false, null, 0, id);
  }

  // ---------------------------------------------------------------- export
  /**
   * Offline render of one Output node (flattened id) to processed float channels.
   * Returns {channels, sampleRate, loop, seconds, peak, lufs, name}.
   */
  async render(outputId, exp, variant = 0) {
    const project = this.getProject();
    const g = flatten(project);
    const o = g.nodes.find((n) => n.id === outputId);
    const P = o.params, sr = exp.sampleRate, ch = exp.channels;
    const L = P.length > 0 ? P.length : Math.max(0.05, timelineSeconds(project));
    const seam = P.loop ? Math.min(P.seam, L / 3) : 0;
    const total = P.loop ? 2 * L + seam : L + P.tail;
    const frames = Math.max(1, Math.ceil(total * sr));
    const ctx = new OfflineAudioContext(ch, frames, sr);
    await ensureWorklets(ctx);
    const cents = variant ? (rng(hashStr(P.name) + variant * 7919)() * 2 - 1) * P.vpitch : 0;
    const graph = compile(ctx, project, g, {
      buffers: this.buffers, sampleMeta: this.sampleMeta, dest: ctx.destination, onlyOutput: outputId, variant, cents,
      gsBuffer: (id, PP) => this.gsBufferFor(g, id, PP),
    });
    graph.start(0);
    if (P.loop) scheduleRange(graph, 0, 0, total, L);
    else graph.schedule(0, 0, L, L);
    const rendered = await ctx.startRendering();
    let chans = Array.from({ length: ch }, (_, c) => rendered.getChannelData(c));
    let loop = null;
    if (P.loop) {
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
    let lufs = measureLufs(chans, sr);
    if (exp.normalize) {
      if (exp.normMode === 'lufs' && isFinite(lufs)) {
        let gain = Math.pow(10, (exp.lufs - lufs) / 20);
        const ceil = Math.pow(10, exp.peakDb / 20);
        if (rawPeak * gain > ceil) gain = ceil / rawPeak;
        for (const c of chans) for (let i = 0; i < c.length; i++) c[i] *= gain;
      } else wav.normalize(chans, exp.peakDb);
      lufs = measureLufs(chans, sr);
    }
    const name = variant ? `${P.name}_${variant + 1}` : P.name;
    return { channels: chans, sampleRate: sr, loop, seconds: chans[0].length / sr, peak: wav.peak(chans), rawPeak, lufs, name, bus: P.bus, variant };
  }

  async renderWav(outputId, exp, variant = 0) {
    const r = await this.render(outputId, exp, variant);
    return { ...r, blob: wav.encodeWav(r.channels, r.sampleRate, exp.bitDepth, r.loop) };
  }
}
