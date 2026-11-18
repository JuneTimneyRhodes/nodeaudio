// Recording samples: microphone / line-in, or the audio of another browser tab or
// window (e.g. a video you are watching) via screen-capture with audio.
// Only capture audio you have the right to use.

export class Recorder {
  constructor(app) { this.app = app; this.rec = null; }

  get active() { return !!this.rec; }

  async start(kind) {
    if (this.rec) return;
    let stream;
    try {
      if (kind === 'tab') {
        stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false }, preferCurrentTab: false, selfBrowserSurface: 'exclude', systemAudio: 'include' });
        stream.getVideoTracks().forEach((t) => t.stop());
        if (!stream.getAudioTracks().length) { this.app.toast('No audio was shared — tick “Share tab audio” in the picker', 'err'); return; }
      } else {
        stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
      }
    } catch (e) { if (e.name !== 'NotAllowedError') this.app.toast('Could not start recording: ' + e.message, 'err'); return; }
    const audio = new MediaStream(stream.getAudioTracks());
    const mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'].find((m) => MediaRecorder.isTypeSupported(m)) || '';
    const rec = new MediaRecorder(audio, mime ? { mimeType: mime, audioBitsPerSecond: 192000 } : undefined);
    const chunks = [];
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    rec.onstop = async () => {
      stream.getTracks().forEach((t) => t.stop());
      this.rec = null;
      this.app.updateRecUI();
      if (!chunks.length) return;
      const type = rec.mimeType || 'audio/webm';
      const ext = type.includes('ogg') ? 'ogg' : type.includes('mp4') ? 'm4a' : 'webm';
      const stamp = new Date().toTimeString().slice(0, 8).replace(/:/g, '');
      const file = new File(chunks, `${kind === 'tab' ? 'capture' : 'rec'}_${stamp}.${ext}`, { type });
      const s = await this.app.importSample(file);
      if (s) this.app.openSampleEditor(s.id);
    };
    // the tab-share bar's "Stop sharing" ends the track: treat that as stop
    audio.getAudioTracks().forEach((t) => (t.onended = () => this.stop()));
    rec.start(250);
    this.rec = rec;
    this.t0 = performance.now();
    this.kind = kind;
    this.app.updateRecUI();
  }

  stop() { if (this.rec && this.rec.state !== 'inactive') this.rec.stop(); }

  elapsed() { return this.rec ? (performance.now() - this.t0) / 1000 : 0; }
}
