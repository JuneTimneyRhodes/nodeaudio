// Playing notes in: Web MIDI keyboards and the computer keyboard (Ableton-style
// layout: A W S E D F T G Y H U J K O L P ; — Z/X octave, C/V velocity).

const KEYMAP = { KeyA: 0, KeyW: 1, KeyS: 2, KeyE: 3, KeyD: 4, KeyF: 5, KeyT: 6, KeyG: 7, KeyY: 8, KeyH: 9, KeyU: 10, KeyJ: 11, KeyK: 12, KeyO: 13, KeyL: 14, KeyP: 15, Semicolon: 16, Quote: 17 };

export class LiveInput {
  constructor(app) {
    this.app = app;
    this.keys = false;
    this.octave = 4;
    this.vel = 0.8;
    this.midi = null;
    this.down = new Set();
    window.addEventListener('keydown', (e) => this.onKey(e, true), true);
    window.addEventListener('keyup', (e) => this.onKey(e, false), true);
    window.addEventListener('blur', () => this.allOff());
  }

  setKeys(on) {
    this.keys = on;
    if (!on) this.allOff();
    this.app.updateLiveUI();
  }

  onKey(e, isDown) {
    if (!this.keys || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.target.closest && e.target.closest('input,select,textarea')) return;
    const code = e.code;
    if (isDown && (code === 'KeyZ' || code === 'KeyX')) { this.octave = Math.max(0, Math.min(8, this.octave + (code === 'KeyX' ? 1 : -1))); this.app.updateLiveUI(); e.preventDefault(); e.stopPropagation(); return; }
    if (isDown && (code === 'KeyC' || code === 'KeyV')) { this.vel = Math.max(0.1, Math.min(1, this.vel + (code === 'KeyV' ? 0.1 : -0.1))); this.app.updateLiveUI(); e.preventDefault(); e.stopPropagation(); return; }
    if (!(code in KEYMAP)) return;
    e.preventDefault(); e.stopPropagation();
    const id = 'k' + code;
    if (isDown) {
      if (e.repeat || this.down.has(id)) return;
      this.down.add(id);
      this.app.engine.liveOn(id, 12 * (this.octave + 1) + KEYMAP[code], this.vel, 0);
    } else if (this.down.has(id)) {
      this.down.delete(id);
      this.app.engine.liveOff(id);
    }
  }

  allOff() { for (const id of this.down) this.app.engine.liveOff(id); this.down.clear(); }

  async enableMidi() {
    if (!navigator.requestMIDIAccess) { this.app.toast('Web MIDI is not available in this browser (use Chrome or Edge)', 'err'); return false; }
    try {
      this.midi = await navigator.requestMIDIAccess();
      const bind = () => { for (const inp of this.midi.inputs.values()) inp.onmidimessage = (m) => this.onMidi(m.data); this.app.updateLiveUI(); };
      bind();
      this.midi.onstatechange = bind;
      const names = [...this.midi.inputs.values()].map((i) => i.name);
      this.app.toast(names.length ? `MIDI: ${names.join(', ')}` : 'MIDI enabled — no devices connected yet');
      return true;
    } catch (e) { this.app.toast('MIDI access was refused', 'err'); return false; }
  }

  get midiCount() { return this.midi ? this.midi.inputs.size : 0; }

  onMidi([st, d1, d2]) {
    const type = st & 0xf0, ch = (st & 0x0f) + 1, id = `m${ch}:${d1}`;
    if (type === 0x90 && d2 > 0) this.app.engine.liveOn(id, d1, d2 / 127, ch);
    else if (type === 0x80 || (type === 0x90 && d2 === 0)) this.app.engine.liveOff(id);
  }
}
