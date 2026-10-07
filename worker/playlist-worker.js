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
//
// Optional — play counts (Settings → Bindings → D1 database, variable name DB):
//   DB              (D1)      a D1 database. Stores only: song id, time, random device code.
//                             Free plan: going over a limit just pauses counting; never billed.
//   Stats can only be read with the admin page's GitHub key (checked against GitHub).

export default {
  async fetch(req, env) {
    const origin = req.headers.get('Origin') || '';
    const allowed = String(env.ALLOWED_ORIGIN || '').split(',').map((s) => s.trim()).filter(Boolean);
    const originOk = allowed.includes(origin);
    const cors = {
      'Access-Control-Allow-Origin': originOk ? origin : (allowed[0] || ''),
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Max-Age': '86400',
      Vary: 'Origin',
    };
    const reply = (body, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    const path = new URL(req.url).pathname.replace(/\/+$/, '') || '/';
    if (path === '/play') return recordPlay(req, env, originOk, reply, 'plays');
    if (path === '/view') return recordPlay(req, env, originOk, reply, 'views'); // lyric video opened
    if (path === '/stats') return readStats(req, env, originOk, reply);
    if (req.method === 'GET') return reply({ ok: true, service: "Craig's Songs playlists", stats: !!env.DB });
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

// ======================================================================
// Play counts (optional; needs the D1 binding named DB)
// ======================================================================
let tableReady = false;
async function ensureTable(env) {
  if (tableReady) return;
  await env.DB.batch([
    env.DB.prepare('CREATE TABLE IF NOT EXISTS plays (id INTEGER PRIMARY KEY, song TEXT NOT NULL, device TEXT NOT NULL, ts INTEGER NOT NULL)'),
    env.DB.prepare('CREATE INDEX IF NOT EXISTS plays_ts ON plays (ts)'),
    env.DB.prepare('CREATE INDEX IF NOT EXISTS plays_song ON plays (song)'),
    env.DB.prepare('CREATE TABLE IF NOT EXISTS views (id INTEGER PRIMARY KEY, song TEXT NOT NULL, device TEXT NOT NULL, ts INTEGER NOT NULL)'),
    env.DB.prepare('CREATE INDEX IF NOT EXISTS views_ts ON views (ts)'),
  ]);
  tableReady = true;
}

// /play: the app calls this once a song has played for 30 seconds (or half of it).
// /view: the app calls this when someone opens a song's lyric video.
async function recordPlay(req, env, originOk, reply, table) {
  if (req.method !== 'POST') return reply({ error: 'Use POST' }, 405);
  if (!originOk) return reply({ error: 'Not allowed' }, 403);
  if (!env.DB) return reply({ ok: false, error: 'Play counts are not set up.' }, 501);
  let body;
  try { body = JSON.parse(await req.text()); } catch { return reply({ error: 'Bad request' }, 400); }
  const song = String(body.song || '');
  const device = String(body.device || '');
  if (!/^[a-z0-9-]{1,120}$/.test(song) || !/^[a-f0-9]{16,64}$/.test(device)) return reply({ error: 'Bad request' }, 400);
  try {
    await ensureTable(env);
    // Ignore the same song from the same device within 60 seconds (double taps, retries).
    const now = Date.now();
    const dup = await env.DB.prepare(`SELECT 1 FROM ${table} WHERE song = ? AND device = ? AND ts > ? LIMIT 1`).bind(song, device, now - 60000).first();
    if (!dup) await env.DB.prepare(`INSERT INTO ${table} (song, device, ts) VALUES (?, ?, ?)`).bind(song, device, now).run();
    return reply({ ok: true });
  } catch {
    return reply({ ok: false }, 503); // over a free limit or a D1 hiccup: the app ignores this
  }
}

// Only the admin page can read stats: it must send the same GitHub key it uses to edit the repo.
const adminCache = new Map(); // token hash -> expiry
async function isAdmin(req, env) {
  const auth = req.headers.get('Authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if (!token) return false;
  const key = await hash(token);
  if ((adminCache.get(key) || 0) > Date.now()) return true;
  const res = await fetch(`https://api.github.com/repos/${env.REPO}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'craigs-songs-playlists' },
  });
  if (!res.ok) return false;
  const info = await res.json();
  if (!info.permissions?.push) return false;
  adminCache.set(key, Date.now() + 10 * 60e3);
  return true;
}

async function readStats(req, env, originOk, reply) {
  if (req.method !== 'GET') return reply({ error: 'Use GET' }, 405);
  if (!originOk) return reply({ error: 'Not allowed' }, 403);
  if (!env.DB) return reply({ error: 'Play counts are not set up yet (no D1 database linked as DB).' }, 501);
  if (!(await isAdmin(req, env))) return reply({ error: 'Only the admin page can see stats.' }, 401);
  await ensureTable(env);
  const now = Date.now();
  const day = 864e5;
  const d7 = now - 7 * day, d30 = now - 30 * day;
  const tz = Number(new URL(req.url).searchParams.get('tz') || 0); // browser's UTC offset in minutes
  const [totals, songs, daily, vtotals, vsongs] = await env.DB.batch([
    env.DB.prepare(`SELECT COUNT(*) AS plays,
        COALESCE(SUM(ts > ?1), 0) AS plays7, COALESCE(SUM(ts > ?2), 0) AS plays30,
        COUNT(DISTINCT device) AS devices,
        COUNT(DISTINCT CASE WHEN ts > ?2 THEN device END) AS devices30
      FROM plays`).bind(d7, d30),
    env.DB.prepare(`SELECT song, COUNT(*) AS plays, SUM(ts > ?1) AS plays30,
        COUNT(DISTINCT device) AS devices, MAX(ts) AS last
      FROM plays GROUP BY song ORDER BY plays DESC`).bind(d30),
    env.DB.prepare(`SELECT CAST((ts - ?2 * 60000) / 86400000 AS INTEGER) AS d, COUNT(*) AS plays
      FROM plays WHERE ts > ?1 GROUP BY d ORDER BY d`).bind(d30, tz),
    env.DB.prepare(`SELECT COUNT(*) AS views, COALESCE(SUM(ts > ?1), 0) AS views7, COALESCE(SUM(ts > ?2), 0) AS views30,
        COUNT(DISTINCT CASE WHEN ts > ?2 THEN device END) AS viewers30 FROM views`).bind(d7, d30),
    env.DB.prepare(`SELECT song, COUNT(*) AS views, SUM(ts > ?1) AS views30, MAX(ts) AS last FROM views GROUP BY song`).bind(d30),
  ]);
  return reply({ ok: true, now, totals: { ...totals.results[0], ...vtotals.results[0] }, songs: songs.results, views: vsongs.results, daily: daily.results });
}
