// Project model: JSON (de)serialisation, undo history, autosave.
//
// A saved project is a single self-contained JSON file. Imported samples are embedded
// as base64 of the original file bytes, so a project opened on another machine (or
// from a GitHub Pages deploy) sounds the same without any side files.

import { TYPES, defaultParams } from './nodes.js';

export const FORMAT = 'nodeaudio-project';
export const VERSION = 1;

export const GODOT_EXPORT = { sampleRate: 22050, channels: 1, bitDepth: 16, normalize: true, normMode: 'peak', lufs: -16, peakDb: -1, trim: true, trimDb: -60 };

let counter = 0;
export const uid = (p = 'n') => p + Date.now().toString(36).slice(-5) + (counter++).toString(36) + Math.random().toString(36).slice(2, 5);

export function emptyProject() {
  return {
    format: FORMAT, version: VERSION, name: 'untitled',
    bpm: 120, lengthBeats: 4,
    export: { ...GODOT_EXPORT },
    view: { x: 0, y: 0, zoom: 1 },
    nodes: [], links: [], samples: [],
    song: emptySong(),
  };
}

export const emptySong = () => ({ enabled: false, bars: 16, tracks: [], clips: [] });

export function makeNode(type, x, y) {
  const T = TYPES[type];
  return { id: uid('n'), type, x: Math.round(x), y: Math.round(y), params: defaultParams(type), ...(T.initData ? { data: T.initData() } : {}) };
}

/** Fill in anything a hand-edited or older file is missing, drop what no longer exists. */
export function migrate(p) {
  if (!p || p.format !== FORMAT) throw new Error('Not a NodeAudio project file');
  const base = emptyProject();
  const out = { ...base, ...p, export: { ...base.export, ...(p.export || {}) }, view: { ...base.view, ...(p.view || {}) } };
  Object.assign(out, migrateGraph(p));
  out.samples = p.samples || [];
  out.song = { ...emptySong(), ...(p.song || {}) };
  const ids = new Set(out.nodes.map((n) => n.id));
  out.song.tracks = out.song.tracks.filter((t) => ids.has(t.node));
  const tids = new Set(out.song.tracks.map((t) => t.id));
  out.song.clips = out.song.clips.filter((c) => tids.has(c.track));
  return out;
}

function migrateGraph(g) {
  const nodes = (g.nodes || []).filter((n) => TYPES[n.type]).map((n) => {
    const T = TYPES[n.type];
    const node = { ...n, params: { ...defaultParams(n.type), ...(n.params || {}) } };
    if (n.type === 'group') node.data = { inputs: [], outputs: [], ...(n.data || {}), ...migrateGraph(n.data || {}) };
    else if (T.initData) node.data = { ...T.initData(), ...(n.data || {}) };
    return node;
  });
  const ids = new Set(nodes.map((n) => n.id));
  return { nodes, links: (g.links || []).filter((l) => ids.has(l.from.node) && ids.has(l.to.node)) };
}

export function serialize(p) { return JSON.stringify(p, null, 1); }

/** Graph-only snapshot for undo (samples are append-only and kept out of history). */
export const snapshot = (p) => JSON.stringify({ nodes: p.nodes, links: p.links, bpm: p.bpm, lengthBeats: p.lengthBeats, name: p.name, export: p.export, song: p.song });

export class History {
  constructor() { this.stack = []; this.i = -1; }
  reset(p) { this.stack = [snapshot(p)]; this.i = 0; }
  push(p) {
    const s = snapshot(p);
    if (this.stack[this.i] === s) return false;
    this.stack.length = this.i + 1;
    this.stack.push(s);
    if (this.stack.length > 200) this.stack.shift();
    this.i = this.stack.length - 1;
    return true;
  }
  undo(p) { if (this.i <= 0) return false; this.i--; Object.assign(p, JSON.parse(this.stack[this.i])); return true; }
  redo(p) { if (this.i >= this.stack.length - 1) return false; this.i++; Object.assign(p, JSON.parse(this.stack[this.i])); return true; }
}

// --- base64 helpers ----------------------------------------------------------

export function bytesToB64(bytes) {
  let s = '';
  const u = new Uint8Array(bytes);
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000));
  return btoa(s);
}
export function b64ToBytes(b64) {
  const s = atob(b64), u = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i);
  return u.buffer;
}

// --- autosave (IndexedDB: samples easily outgrow localStorage's ~5 MB) --------

function db() {
  return new Promise((res, rej) => {
    const r = indexedDB.open('nodeaudio', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
export async function idbSet(key, val) {
  try {
    const d = await db();
    await new Promise((res, rej) => { const t = d.transaction('kv', 'readwrite'); t.objectStore('kv').put(val, key); t.oncomplete = res; t.onerror = () => rej(t.error); });
  } catch (e) { console.warn('autosave failed', e); }
}
export async function idbGet(key) {
  try {
    const d = await db();
    return await new Promise((res, rej) => { const r = d.transaction('kv').objectStore('kv').get(key); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  } catch { return undefined; }
}

// --- file I/O ----------------------------------------------------------------

export function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

export const safeName = (s) => (s || 'untitled').trim().toLowerCase().replace(/[^a-z0-9_\-]+/g, '_').replace(/^_+|_+$/g, '') || 'untitled';
