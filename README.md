# NodeAudio

A node-based audio workstation that runs entirely in the browser, in the spirit of
Blender's *Audionodes*. Build sound effects and full soundtracks by patching
sequencers, synths, samplers and effects together; arrange them into songs; export
game-ready `.wav` files — or, for the game's own synth, GDScript.

Static files only: no build step and no server code. Live at
<https://junetimneyrhodes.github.io/nodeaudio/>, installable as an offline app.

## Run locally

ES modules need to be served over http (not `file://`):

```bash
python -m http.server 5517
```

Then open <http://localhost:5517>. Run the tests with `node --test tests/`.

## Templates

*New from template…* in the top bar:

| Template | What it shows |
| --- | --- |
| SFX bank (space combat) | Laser, explosion and a seamless engine loop as WAV cues, plus a Game Synth cue |
| Chip groove (music loop) | Step-sequenced bass, polyphonic lead, an arrangement to try |
| Drum beat (music loop) | Kick, snare and hats synthesised from oscillators and noise, mixed and compressed |
| Ambient pad (music loop) | Wavetable chords morphing under a slow LFO, chorus, delay, long reverb |
| Deep space ambient (3 min) | Slow D-minor drone, drifting wavetable pads, distant echoing bells, a filtered mid-section pulse and solar-wind noise, arranged over 3:12 and exported as a seamless Music-bus loop |
| Battle theme (song arrangement) | Drums, bass, lead and pads arranged over 16 bars — intro, build, full |
| Game Synth cues (GDScript) | lock, laser, pickup, shield_hit, explosion, engine_hum built from `Synth.*` calls |
| UI sounds (menu bank) | ui_move / confirm / cancel / deny on the UI bus |
| Sample chops (drop a sample in) | A slicing sampler played by a step sequencer — drop audio onto the Sampler |

## What's in it

**Patching.** Sockets: ● audio, ◆ notes, ▬ Game Synth buffers, and ◆ beside a value
for modulation (anything audio patched there is added to that parameter). Drop a wire
on empty canvas to add a node already connected. **Ctrl G** collapses a selection into
a **Group** (Tab to enter/leave, Ctrl Shift G to ungroup); drop a wire on a group's `+`
socket to add a socket. Save any selection as a **preset**; presets export/import as JSON.

**Synthesis.** Oscillator (unison + spread, pitch sweep, glide), Wavetable (8-frame
morph, built-in tables or frames sliced from a sample), Sampler (pitched or sliced,
loop points), Granular, Noise, Envelope, LFO (tempo sync), Random (per-variant or
per-note), Filter (to 48 dB/oct), Delay (tempo sync), Reverb, Chorus, Distortion,
Bitcrusher, Compressor, Mixer (level + pan), Pan, Gain, Scope.

**Polyphony.** Set *Voices* on an Oscillator, Wavetable, Sampler or Synth Cue.
Envelopes, filters, gains, distortion and pan placed after it become polyphonic too,
so a poly envelope on a filter's cutoff works per note. Chord turns single notes into
chords.

**Playing and sequencing.** Trigger, Step Sequencer, Piano Roll (with recording),
Transpose, Chord, and **Live Input** — MIDI keyboards (Web MIDI, Chrome/Edge) or the
computer keyboard (⌨ in the top bar: `A W S E D F T G Y H U J K O L P ;`, Z/X octave,
C/V velocity).

**Arrangement.** The dock's Arrangement tab is a timeline. Each track plays one node:
a sequencer plays its notes only inside its clips (from the clip's offset); a Sampler
plays its sample from the clip start, so you can lay out vocal chops or loops. Toggle
**Song** in the top bar to play and export the arrangement instead of the pattern.

**Samples.** Drop audio *or video* files anywhere (video is reduced to its audio), or
record the microphone, or capture the audio of another tab/window (e.g. a video you
are watching) with **● Tab audio**. Only use audio you have the rights to. The
Sample editor trims, cuts, normalises, reverses, fades, changes gain, resamples to
shrink the project, auto-slices at transients (or equal slices), and sets loop regions.

**Visualizers.** The dock's **Visualizer** tab shows the master output (or any Scope
node) as *Spectrum* bars, a scrolling *Waterfall* spectrogram, a stereo *Scope*, a
*Stereo* field goniometer with phase correlation, a *Radial* spectrum, *Nebula* — an
audio-reactive starfield whose speed, clouds and core glow follow the lows, mids and
highs — and level *Meters*. **⛶ Fullscreen** for showing a track off (keys 1–7 switch
modes, Esc leaves); where a browser refuses fullscreen it fills the window instead.
Scope nodes offer the same modes inline; double-click one to open it in the panel.

## Exporting for space-rogue-repo

The game (Godot 4) synthesises its cues at `Synth.MIX_RATE = 22050` Hz mono and plays
them on the `SFX`, `SFXFar`, `Cockpit`, `UI` and `Music` buses.

- **WAV.** Every Output node is one cue named by its *Cue name*. Presets: **Godot SFX**
  (22050 Hz mono 16-bit) and **Godot music** (44.1 kHz stereo, −14 LUFS). Normalise to a
  peak or to a loudness target (BS.1770 LUFS, with a peak ceiling) so a bank feels even.
- **OGG Vorbis.** Set *Format* to OGG (the **Godot music** preset does) for files about a
  tenth the size of WAV — Godot plays them natively as `AudioStreamOggVorbis`. Quality is
  Vorbis VBR −1…10 (5 ≈ 160 kb/s, 6 ≈ 192 kb/s stereo). OGG has no loop chunk, so tick
  *Loop* in Godot's Import dock for looping cues (the manifest lists which ones). WAV stays
  the default for short SFX, matching the game's `AudioStreamWAV` cues. Encoding uses
  libvorbis compiled to WebAssembly, vendored in `js/vendor/wasm-media-encoders/`
  (MIT / BSD — see its `NOTICE.md`) and loaded only when you export an OGG.
- **Loops** render two passes and keep the second (so tails ring into the start), fold
  an equal-power crossfade over the seam, and carry a `smpl` chunk: Godot 4's default
  import mode, *Detect From WAV*, loops them with no `.import` edits.
- **Variants.** Set *Variants* on an Output to export `name_2.wav`, `name_3.wav`… with
  different noise seeds, Random-node values and a small pitch offset — the game already
  plays several variants per weapon so repeats don't buzz.
- **Bus monitoring.** *Monitor: game buses* plays each cue through approximations of
  `default_bus_layout.tres` (the SFX room, SFXFar's echo) according to its Output's
  *Game bus*. Exports stay dry, so the room is not baked in twice.
- **Export to folder** (Chrome/Edge) writes the WAVs plus `nodeaudio_cues.json` (bus,
  loop, length, peak, loudness per cue) straight into a folder such as
  `assets/audio/sfx`, and remembers it per project. *Export all* puts the same files in
  a zip.
- **Inspect** renders a cue and shows its waveform, spectrogram, peak, RMS, LUFS and
  crest factor.

### GDScript (Game Synth nodes)

The game prefers making sounds in code to shipping files. The **Game Synth** nodes
(`Synth.tone`, `Synth.noise`, `Synth.lowpass`, `Synth.band`, `Synth.layer`,
`Synth.drive`, `Synth.comb`, `Synth.chorus`, `Synth.reverb_approx`, …) are a one-to-one
port of `scripts/audio/synth.gd`. End a chain in a **Synth Cue**: it plays the buffer
exactly as the game would bake it, and **GDScript** / **⤓ .gd** export a
`bake_<name>(rng)` function that calls `Synth` with the same numbers. Noise uses a
different random generator, so it is equivalent rather than bit-identical.

## Project files

*Save* writes `<name>.nodeaudio.json`: nodes (with groups nested), links, the
arrangement, settings and every sample embedded as base64 — one file is the whole
project and opens the same on any device. The working copy also autosaves in the
browser. *Share* copies a link with the project deflated into the URL (no samples).

## Layout

```
index.html, css/            page and styles
js/main.js                  app shell, panels, file I/O, export
js/editor.js                node canvas, wires, groups, parameter widgets
js/nodes.js                 node types (sockets, params, Web Audio builders)
js/engine.js                flattening, voices, scheduler, live input, offline render
js/gamesynth.js             Synth.gd port, Game Synth nodes, GDScript codegen
js/gamebus.js               approximations of the game's buses for monitoring
js/song.js                  arrangement timeline
js/pianoroll.js             piano roll
js/sampleeditor.js          sample editor
js/live.js, recorder.js     MIDI/keyboard input, mic/tab recording
js/loudness.js, dsp.js      BS.1770 loudness, FFT, spectrogram, onset detection
js/renderview.js            render inspector
js/wav.js                   WAV encoder (+smpl), loop seam, normalise/trim, zip
js/project.js, presets.js   project JSON, undo, autosave, presets
js/share.js, worklets.js    share links, AudioWorklets (bitcrusher, granular)
sw.js, manifest.webmanifest offline app
tests/                      node --test unit tests
```
