# NodeAudio

A node-based audio workstation that runs entirely in the browser, in the spirit of
Blender's *Audionodes*. Patch sequencers, oscillators, samplers and effects together,
hear it live, and export game-ready `.wav` cues.

Static files only: no build step, no server code. Open it from GitHub Pages or any
static host.

## Run locally

ES modules need to be served over http (not `file://`):

```bash
python -m http.server 5517
```

Then open <http://localhost:5517>.

## Deploy to GitHub Pages

Push this folder to a public repo, then either:

- **Settings → Pages → Deploy from a branch → `main` / root**, or
- keep `.github/workflows/pages.yml` (included) and set **Settings → Pages → Source → GitHub Actions**.

`.nojekyll` is included so Pages serves the files untouched.

## How it works

| Socket | Meaning |
| --- | --- |
| ● cyan | audio |
| ◆ amber | notes (event streams from sequencers) |
| ◆ violet, beside a value | modulation input; audio patched here is added to that parameter |

Typical chain: **Trigger / Step Sequencer / Piano Roll → Oscillator / Noise / Sampler →
Envelope → Filter → effects → Output**.

- **Every Output node is one cue.** Its *Cue name* becomes the filename. A project with
  several outputs is a whole SFX bank; *Export all* writes a `.zip`.
- Unconnected Oscillators/Samplers/Envelopes fire once at the start of each loop, so a
  one-shot SFX needs no sequencer at all.
- Playback and export share one graph compiler: export renders the same patch in an
  `OfflineAudioContext`, so the file matches what you heard.

## Export format (space-rogue-repo)

The game (Godot 4) synthesises its cues at `Synth.MIX_RATE = 22050` Hz, mono, into
16-bit `AudioStreamWAV`. The **Godot SFX** preset matches that exactly; **Godot music**
is 44.1 kHz stereo 16-bit for the `Music` bus.

- PCM WAV, 8/16/24-bit or 32-bit float.
- Each cue normalised to a peak (default −1 dBFS); one-shots have trailing silence
  trimmed.
- **Loop** outputs render two passes and keep the second, so reverb/delay tails from the
  previous pass ring into the start, then fold a short equal-power crossfade over the
  seam (same idea as `Synth.loop_seam`). They carry a `smpl` chunk with the loop points:
  Godot 4's default import loop mode, *Detect From WAV*, picks them up, so the file
  loops in-game with no `.import` edits.
- Leave reverb off cues that the game routes through `SFX`/`SFXFar`: those buses
  already add the room. `Cockpit` and `UI` cues are played dry.

## Project files

*Save* writes `<name>.nodeaudio.json`: nodes, links, settings and every imported sample
embedded as base64, so one file is the whole project. The working copy is also
autosaved to IndexedDB in the browser.

```jsonc
{
  "format": "nodeaudio-project", "version": 1,
  "name": "sfx_bank", "bpm": 120, "lengthBeats": 2,
  "export": { "sampleRate": 22050, "channels": 1, "bitDepth": 16, "normalize": true, "peakDb": -1, "trim": true },
  "nodes": [{ "id": "…", "type": "osc", "x": 240, "y": 0, "params": { "wave": "square", "freq": 220 } }],
  "links": [{ "id": "…", "from": { "node": "…", "port": "out" }, "to": { "node": "…", "port": "p:cutoff" } }],
  "samples": [{ "id": "…", "name": "kick.wav", "mime": "audio/wav", "data": "<base64>" }]
}
```

## Shortcuts

`Right-click` / `Shift A` / `Tab` add node · drag a socket to connect, drag from an input to
unplug · drop a wire on empty canvas to add a connected node · `Space` play ·
`X`/`Del` delete · `Ctrl D` duplicate · `Ctrl Z`/`Ctrl Shift Z` undo/redo · `F` frame all ·
`Ctrl S` save · `Ctrl E` export. Values: drag sideways (Shift = fine), click to type
(`2k`, `40ms` work), double-click to reset.

## Layout

```
index.html
css/style.css
js/main.js        app shell, panels, file I/O, export
js/editor.js      node canvas, wires, parameter widgets
js/nodes.js       node type definitions (sockets, params, Web Audio builders)
js/engine.js      graph compiler, look-ahead scheduler, offline render
js/pianoroll.js   piano roll drawer
js/wav.js         WAV encoder (+smpl), loop seam, normalise/trim, zip writer
js/project.js     project JSON, undo history, autosave
js/templates.js   starter projects
js/worklets.js    bitcrusher AudioWorklet
```
