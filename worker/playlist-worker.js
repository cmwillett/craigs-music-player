// Craig's Songs — playlist middleman (Cloudflare Worker)
//
// Lets people create, edit and delete their own playlists from the app.
// It holds the GitHub key (as a Cloudflare secret) so the app never sees it, and it can
// ONLY change playlists in songs.json. It stores nothing itself and logs nothing.
//
// Settings (Cloudflare → this Worker → Settings → Variables and Secrets):
//   GITHUB_TOKEN    (Secret)  fine-grained token, this repo only, Contents: Read and write
//   REPO            (Text)    cmwillett/craigs-music-player
//   BRANCH          (Text)    main
//   ALLOWED_ORIGIN  (Text)    https://cmwillett.github.io

export default {
  async fetch(req, env) {
    const origin = req.headers.get('Origin') || '';
    const allowed = String(env.ALLOWED_ORIGIN || '').split(',').map((s) => s.trim()).filter(Boolean);
    const originOk = allowed.includes(origin);
    const cors = {
      'Access-Control-Allow-Origin': originOk ? origin : (allowed[0] || ''),
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400',
      Vary: 'Origin',
    };
    const reply = (body, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (req.method === 'GET') return reply({ ok: true, service: "Craig's Songs playlists" });
    if (req.method !== 'POST') return reply({ error: 'Use POST' }, 405);
    if (!originOk) return reply({ error: 'This app is not allowed to save playlists here.' }, 403);
    if (!env.GITHUB_TOKEN || !env.REPO) return reply({ error: 'The playlist service is not set up yet (missing GITHUB_TOKEN or REPO).' }, 500);

    let body;
    try { body = await req.json(); } catch { return reply({ error: 'Bad request' }, 400); }

    const action = body.action;
    if (!['save', 'delete'].includes(action)) return reply({ error: 'Unknown action' }, 400);
    const ownerKey = String(body.ownerKey || '');
    if (ownerKey.length < 16 || ownerKey.length > 200) return reply({ error: 'Missing device key' }, 400);
    const owner = await hash(ownerKey);

    try {
      const result = await withRetries(env, (data) => applyChange(data, action, body, owner));
      return reply({ ok: true, ...result });
    } catch (e) {
      return reply({ error: e.message || 'Something went wrong' }, e.status || 500);
    }
  },
};

// ---------- the only change this service can make: playlists ----------
function applyChange(data, action, body, owner) {
  data.playlists = Array.isArray(data.playlists) ? data.playlists : [];
  const songIds = new Set((data.songs || []).map((s) => s.id));
  const input = body.playlist || {};
  const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };

  const existing = input.id ? data.playlists.find((p) => p.id === input.id) : null;
  if (input.id && !existing) fail('That playlist no longer exists.', 404);
  if (existing && (!existing.user || existing.owner !== owner)) fail('You can only change playlists you made.', 403);

  if (action === 'delete') {
    if (!existing) fail('Which playlist?');
    data.playlists = data.playlists.filter((p) => p !== existing);
    return { message: `Delete playlist "${existing.name}"`, deleted: existing.id };
  }

  const name = clean(input.name, 60);
  if (!name) fail('Give the playlist a name.');
  const by = clean(body.by, 40);
  const songs = [...new Set((Array.isArray(input.songs) ? input.songs : []).map(String))].filter((id) => songIds.has(id)).slice(0, 300);
  const today = new Date().toISOString().slice(0, 10);

  let p = existing;
  if (!p) {
    const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30) || 'playlist';
    p = { id: `${base}-${crypto.randomUUID().slice(0, 6)}`, user: true, owner, created: today };
    data.playlists.push(p);
  }
  p.name = name;
  p.songs = songs;
  if (by) p.by = by; else delete p.by;
  p.updated = new Date().toISOString();
  return { message: `${existing ? 'Update' : 'New'} playlist "${name}"${by ? ` (by ${by})` : ''}`, playlist: p };
}

const clean = (s, max) => String(s || '').replace(/[\u0000-\u001f\u007f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, max);

async function hash(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('songs:' + text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 32);
}

// ---------- GitHub: read songs.json, change it, write it back (retry if someone saved at the same time) ----------
async function withRetries(env, change) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const { data, sha } = await readSongs(env);
    const result = change(data);
    const saved = await writeSongs(env, data, sha, result.message);
    if (saved) return result;
    await new Promise((r) => setTimeout(r, 300 + Math.random() * 500));
  }
  throw Object.assign(new Error('Busy right now, try again in a moment.'), { status: 503 });
}

function gh(env, path, init = {}) {
  return fetch(`https://api.github.com/repos/${env.REPO}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'craigs-songs-playlists',
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
    },
  });
}

async function readSongs(env) {
  const res = await gh(env, `/contents/songs.json?ref=${encodeURIComponent(env.BRANCH || 'main')}`);
  if (!res.ok) throw Object.assign(new Error(`Could not read the song list (GitHub ${res.status}).`), { status: 502 });
  const file = await res.json();
  const bytes = Uint8Array.from(atob(file.content.replace(/\s/g, '')), (c) => c.charCodeAt(0));
  return { data: JSON.parse(new TextDecoder().decode(bytes)), sha: file.sha };
}

async function writeSongs(env, data, sha, message) {
  const bytes = new TextEncoder().encode(JSON.stringify(data, null, 2) + '\n');
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  const res = await gh(env, '/contents/songs.json', {
    method: 'PUT',
    body: JSON.stringify({ message: message.slice(0, 200), content: btoa(bin), sha, branch: env.BRANCH || 'main' }),
  });
  if (res.ok) return true;
  if (res.status === 409 || res.status === 422) return false; // someone else saved first: re-read and try again
  throw Object.assign(new Error(`Could not save (GitHub ${res.status}).`), { status: 502 });
}
