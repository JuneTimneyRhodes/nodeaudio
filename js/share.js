// Share links: the project (minus samples) deflated into the URL hash. Nothing is
// uploaded anywhere — the whole project travels inside the link.

const b64url = (u8) => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); };
const unb64url = (s) => { s = s.replace(/-/g, '+').replace(/_/g, '/'); const b = atob(s + '==='.slice((s.length + 3) % 4)); const u = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i); return u; };

async function pipe(bytes, stream) {
  const out = new Response(new Blob([bytes]).stream().pipeThrough(stream));
  return new Uint8Array(await out.arrayBuffer());
}

export async function encodeProject(project) {
  const { samples, view, ...rest } = project;
  const json = JSON.stringify({ ...rest, samples: [], missingSamples: samples.map((s) => ({ id: s.id, name: s.name })) });
  const z = await pipe(new TextEncoder().encode(json), new CompressionStream('deflate-raw'));
  return { url: `${location.origin}${location.pathname}#p=${b64url(z)}`, dropped: samples.length };
}

export async function decodeHash(hash) {
  const m = /[#&]p=([A-Za-z0-9_-]+)/.exec(hash || '');
  if (!m) return null;
  const bytes = await pipe(unb64url(m[1]), new DecompressionStream('deflate-raw'));
  return JSON.parse(new TextDecoder().decode(bytes));
}
