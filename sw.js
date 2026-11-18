// Offline support. Network-first for the app's own files, so a new deploy is picked up
// on the next load; the cache only answers when the network does not.
const CACHE = 'nodeaudio-v5';
const SHELL = ['./', 'index.html', 'css/style.css', 'css/v2.css', 'icon.svg', 'manifest.webmanifest',
  'js/main.js', 'js/editor.js', 'js/engine.js', 'js/nodes.js', 'js/gamesynth.js', 'js/gamebus.js', 'js/loudness.js', 'js/dsp.js',
  'js/pianoroll.js', 'js/song.js', 'js/sampleeditor.js', 'js/renderview.js', 'js/live.js', 'js/recorder.js', 'js/presets.js',
  'js/share.js', 'js/topbar.js', 'js/project.js', 'js/templates.js', 'js/wav.js', 'js/worklets.js', 'js/ogg.js', 'js/visualizer.js', 'js/vizpanel.js',
  'js/vendor/wasm-media-encoders/WasmMediaEncoder.min.js', 'js/vendor/wasm-media-encoders/ogg.wasm'];

self.addEventListener('install', (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const fonts = url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com';
  if (url.origin !== location.origin && !fonts) return;
  // revalidate our own files every time, so all modules of a new deploy arrive together
  const net = fonts ? fetch(req) : fetch(req.mode === 'navigate' ? req.url : new Request(req, { cache: 'no-cache' }), req.mode === 'navigate' ? { cache: 'no-cache' } : undefined);
  e.respondWith(net.then((res) => {
    if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
    return res;
  }).catch(() => caches.match(req, { ignoreSearch: true }).then((r) => r || caches.match('index.html'))));
});
