// Songs Admin: edits the repo through the GitHub API.
// The GitHub token is stored on this device only, encrypted with a key derived from the PIN.
const $ = (s) => document.querySelector(s);
const STORE = 'songs-admin-v1';
const API = 'https://api.github.com';

let token = null;   // decrypted token, in memory only while unlocked
let repo = null;    // "owner/name"
let branch = null;

// ---------- crypto (PIN -> AES key) ----------
const enc = new TextEncoder(), dec = new TextDecoder();
const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function keyFromPin(pin, salt) {
  const base = await crypto.subtle.importKey('raw', enc.encode(pin), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: 310000, hash: 'SHA-256' },
    base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
async function saveSecret(pin, tok, repoName) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await keyFromPin(pin, salt);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(tok));
  localStorage.setItem(STORE, JSON.stringify({ repo: repoName, salt: b64(salt), iv: b64(iv), ct: b64(ct) }));
}
async function openSecret(pin) {
  const s = JSON.parse(localStorage.getItem(STORE));
  const key = await keyFromPin(pin, unb64(s.salt));
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(s.iv) }, key, unb64(s.ct));
  return { token: dec.decode(pt), repo: s.repo };
}
const stored = () => { try { return JSON.parse(localStorage.getItem(STORE)); } catch { return null; } };

// ---------- GitHub API ----------
async function gh(path, opts = {}) {
  const res = await fetch(API + path, {
    cache: 'no-store',
    ...opts,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: opts.raw ? 'application/vnd.github.raw' : 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
    },
  });
  if (!res.ok) {
    let m = `${res.status}`;
    try { m += ' ' + (await res.json()).message; } catch {}
    throw new Error(`GitHub error ${m}`);
  }
  return opts.raw ? res.text() : res.json();
}

async function connect() {
  const info = await gh(`/repos/${repo}`);
  if (!info.permissions?.push) throw new Error("This token can't write to that repo.");
  branch = info.default_branch;
}

async function readSongs() {
  const text = await gh(`/repos/${repo}/contents/songs.json?ref=${branch}`, { raw: true });
  return JSON.parse(text);
}

// files: [{ path, base64 } | { path, text } | { path, delete: true }]
async function commit(message, files) {
  const ref = await gh(`/repos/${repo}/git/ref/heads/${branch}`);
  const parent = await gh(`/repos/${repo}/git/commits/${ref.object.sha}`);
  const tree = [];
  for (const f of files) {
    if (f.delete) { tree.push({ path: f.path, mode: '100644', type: 'blob', sha: null }); continue; }
    const blob = await gh(`/repos/${repo}/git/blobs`, {
      method: 'POST',
      body: JSON.stringify(f.base64 != null ? { content: f.base64, encoding: 'base64' } : { content: f.text, encoding: 'utf-8' }),
    });
    tree.push({ path: f.path, mode: '100644', type: 'blob', sha: blob.sha });
  }
  const newTree = await gh(`/repos/${repo}/git/trees`, { method: 'POST', body: JSON.stringify({ base_tree: parent.tree.sha, tree }) });
  const c = await gh(`/repos/${repo}/git/commits`, { method: 'POST', body: JSON.stringify({ message, tree: newTree.sha, parents: [parent.sha] }) });
  await gh(`/repos/${repo}/git/refs/heads/${branch}`, { method: 'PATCH', body: JSON.stringify({ sha: c.sha }) });
}

const fileB64 = (file) => new Promise((ok, bad) => {
  const r = new FileReader();
  r.onload = () => ok(String(r.result).split(',')[1]);
  r.onerror = () => bad(r.error);
  r.readAsDataURL(file);
});
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const json = (d) => JSON.stringify(d, null, 2) + '\n';
const tagsFrom = (s) => s.split(',').map((t) => t.trim()).filter(Boolean);
const say = (id, text, kind = '') => { const m = $(id); m.textContent = text; m.className = 'msg ' + kind; };

// ---------- screens ----------
function show(which) {
  ['setup', 'lock', 'admin'].forEach((id) => { $('#' + id).hidden = id !== which; });
}

function guessRepo() {
  const m = location.hostname.match(/^([^.]+)\.github\.io$/i);
  const first = location.pathname.split('/').filter(Boolean)[0];
  if (m && first && !first.endsWith('.html')) return `${m[1]}/${first}`;
  return '';
}

// ---------- tabs: Stats (default) / Songs / Playlists / Settings ----------
function showPanel(name) {
  document.querySelectorAll('.atab').forEach((t) => {
    const on = t.dataset.panel === name;
    t.classList.toggle('active', on);
    t.setAttribute('aria-selected', String(on));
  });
  document.querySelectorAll('.apanel').forEach((p) => { p.hidden = p.dataset.panel !== name; });
  window.scrollTo(0, 0);
}
document.querySelectorAll('.atab').forEach((t) => { t.onclick = () => showPanel(t.dataset.panel); });

async function enterAdmin() {
  await connect();
  show('admin');
  showPanel('stats');
  await refresh();
  initStats();
}

// ---------- Stats (play counts kept by the playlist helper) ----------
const STATS_ME = 'stats-me-v1';
let statsData = null;
function initStats() {
  // The first time the admin page is opened on a device, mark that device as "me".
  try {
    if (localStorage.getItem(STATS_ME) === null) {
      localStorage.setItem(STATS_ME, '1');
      say('#stats-note', "This device is now marked as you, so your plays here won't count.", 'ok');
    }
    $('#stats-me').checked = localStorage.getItem(STATS_ME) === '1';
  } catch {}
  loadStats();
}
$('#stats-me').onchange = (e) => { try { localStorage.setItem(STATS_ME, e.target.checked ? '1' : '0'); } catch {} };
$('#stats-load').onclick = () => loadStats();

async function loadStats() {
  const api = current?.community?.api;
  if (!api) { say('#stats-note', 'Stats need the playlist helper. Set it up under "Playlists from the app" first.'); return; }
  const btn = $('#stats-load');
  const lbl = btn.querySelector('.lbl');
  btn.disabled = true;
  btn.classList.remove('done');
  btn.classList.add('loading');
  lbl.textContent = 'Refreshing…';
  $('#stats-body').classList.add('loading');
  const started = Date.now();
  const settle = () => new Promise((r) => setTimeout(r, Math.max(0, 600 - (Date.now() - started)))); // long enough to see
  let ok = false;
  try {
    const res = await fetch(`${api.replace(/\/+$/, '')}/stats?tz=${new Date().getTimezoneOffset()}`, {
      headers: { Authorization: `Bearer ${token}` }, cache: 'no-store',
    });
    const body = await res.json().catch(() => ({}));
    if (res.status === 501) { say('#stats-note', 'Play counting is not set up yet. Follow "Play counts" in worker/SETUP.md (about 5 minutes).'); return; }
    if (res.status === 404 || res.status === 405) { say('#stats-note', 'Your Cloudflare helper needs the newer code. Paste the latest worker/playlist-worker.js into it and Deploy.', 'err'); return; }
    if (!res.ok || !body.ok) throw new Error(body.error || `Stats error ${res.status}`);
    await settle();
    const TILES = ['#st-7', '#st-30', '#st-all', '#st-dev', '#st-v30', '#st-vall'];
    const before = statsData ? TILES.map((s) => $(s).textContent) : null;
    statsData = body;
    renderStats();
    if (before) TILES.forEach((s, i) => {
      const tile = $(s).parentElement;
      if ($(s).textContent !== before[i]) { tile.classList.remove('changed'); void tile.offsetWidth; tile.classList.add('changed'); }
    });
    $('#stats-updated').textContent = `Updated ${new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
    ok = true;
  } catch (e) {
    say('#stats-note', e.message === 'Failed to fetch' ? "Couldn't reach the helper. Check its address and that it's deployed." : e.message, 'err');
  } finally {
    await settle();
    btn.classList.remove('loading');
    $('#stats-body').classList.remove('loading');
    btn.disabled = false;
    if (ok) {
      btn.classList.add('done');
      lbl.textContent = 'Updated ✓';
      setTimeout(() => { btn.classList.remove('done'); lbl.textContent = 'Refresh'; }, 1500);
    } else lbl.textContent = 'Refresh';
  }
}

function renderStats() {
  const s = statsData;
  const t = s.totals || {};
  const fmtN = (n) => Number(n || 0).toLocaleString();
  $('#st-7').textContent = fmtN(t.plays7);
  $('#st-30').textContent = fmtN(t.plays30);
  $('#st-all').textContent = fmtN(t.plays);
  $('#st-dev').textContent = fmtN(t.devices30);
  $('#st-v30').textContent = fmtN(t.views30);
  $('#st-vall').textContent = fmtN(t.views);
  $('#stats-body').hidden = false;
  if (!t.plays && !t.views) say('#stats-note', 'No plays from other people yet. Counting starts once someone plays a song for 30 seconds.');
  else if (!$('#stats-note').classList.contains('ok')) say('#stats-note', '');

  // Plays per day: 30 bars, oldest -> today (local days).
  const offset = new Date().getTimezoneOffset();
  const today = Math.floor((s.now - offset * 60000) / 864e5);
  const byDay = new Map((s.daily || []).map((r) => [Number(r.d), Number(r.plays)]));
  const days = Array.from({ length: 30 }, (_, k) => today - 29 + k);
  const max = Math.max(1, ...days.map((d) => byDay.get(d) || 0));
  const dateOf = (d) => new Date(d * 864e5 + offset * 60000);
  const label = (d) => dateOf(d).toLocaleDateString([], { month: 'short', day: 'numeric' });
  const chart = $('#st-chart');
  chart.replaceChildren();
  const maxLabel = document.createElement('span');
  maxLabel.className = 'max';
  maxLabel.textContent = `${max} play${max === 1 ? '' : 's'}`;
  chart.append(maxLabel);
  const tip = $('#st-tip');
  days.forEach((d) => {
    const n = byDay.get(d) || 0;
    const bar = document.createElement('div');
    bar.className = 'bar' + (n ? '' : ' zero');
    const fill = document.createElement('i');
    fill.style.height = `${(n / max) * 100}%`;
    bar.append(fill);
    const text = `${dateOf(d).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })}: ${n} play${n === 1 ? '' : 's'}`;
    bar.setAttribute('aria-label', text);
    const showTip = (e) => {
      chart.querySelectorAll('.bar.active').forEach((b) => b.classList.remove('active'));
      bar.classList.add('active');
      tip.textContent = text;
      tip.hidden = false;
      const r = bar.getBoundingClientRect();
      tip.style.left = `${Math.min(innerWidth - tip.offsetWidth - 8, Math.max(8, r.left + r.width / 2 - tip.offsetWidth / 2))}px`;
      tip.style.top = `${Math.max(8, r.bottom - fill.offsetHeight - tip.offsetHeight - 8)}px`;
    };
    bar.addEventListener('pointerenter', showTip);
    bar.addEventListener('pointerdown', showTip);
    bar.addEventListener('pointerleave', () => { tip.hidden = true; bar.classList.remove('active'); });
    chart.append(bar);
  });
  chart.setAttribute('aria-label', `Plays per day for the last 30 days, most in one day: ${max}`);
  $('#st-first').textContent = label(days[0]);
  $('#st-last').textContent = 'Today';

  // By song
  const titles = Object.fromEntries((current?.songs || []).map((x) => [x.id, x.title]));
  const ago = (ms) => {
    const m = Math.round((s.now - ms) / 60000);
    if (m < 60) return `${Math.max(1, m)} min ago`;
    const h = Math.round(m / 60);
    if (h < 24) return `${h} hr ago`;
    const dd = Math.round(h / 24);
    return dd === 1 ? 'yesterday' : `${dd} days ago`;
  };
  const tbody = $('#st-songs');
  tbody.replaceChildren();
  // Merge plays and lyric-video views per song.
  const bySong = new Map();
  (s.songs || []).forEach((r) => bySong.set(r.song, { song: r.song, plays: r.plays, plays30: r.plays30, devices: r.devices, last: r.last, views: 0 }));
  (s.views || []).forEach((v) => {
    const r = bySong.get(v.song) || { song: v.song, plays: 0, plays30: 0, devices: 0, last: 0, views: 0 };
    r.views = v.views; r.last = Math.max(r.last || 0, v.last || 0);
    bySong.set(v.song, r);
  });
  const rows = [...bySong.values()].sort((x, y) => (y.plays + y.views) - (x.plays + x.views));
  if (!rows.length) {
    const tr = document.createElement('tr');
    tr.innerHTML = '<td colspan="6" style="color:var(--muted)">No plays yet.</td>';
    tbody.append(tr);
  }
  rows.forEach((r) => {
    const tr = document.createElement('tr');
    const cells = [titles[r.song] || r.song, fmtN(r.plays30), fmtN(r.plays), fmtN(r.views), fmtN(r.devices), r.last ? ago(r.last) : ''];
    cells.forEach((v, i) => {
      const td = document.createElement('td');
      td.textContent = v;
      if (i >= 1 && i <= 4) td.className = 'num';
      tr.append(td);
    });
    tbody.append(tr);
  });
}

$('#setup-save').onclick = async () => {
  const r = $('#setup-repo').value.trim(), t = $('#setup-token').value.trim(), p = $('#setup-pin').value.trim();
  if (!/^[\w.-]+\/[\w.-]+$/.test(r)) return say('#setup-msg', 'Repo should look like owner/name.', 'err');
  if (!t) return say('#setup-msg', 'Paste your GitHub token.', 'err');
  if (!/^\d{4,8}$/.test(p)) return say('#setup-msg', 'PIN must be 4–8 digits.', 'err');
  say('#setup-msg', 'Checking…');
  token = t; repo = r;
  try {
    await connect();
    await saveSecret(p, t, r);
    $('#setup-token').value = ''; $('#setup-pin').value = '';
    await enterAdmin();
  } catch (e) { token = null; say('#setup-msg', e.message, 'err'); }
};

$('#unlock').onclick = async () => {
  say('#lock-msg', 'Unlocking…');
  try {
    ({ token, repo } = await openSecret($('#pin').value.trim()));
  } catch { $('#pin').value = ''; return say('#lock-msg', 'Wrong PIN.', 'err'); }
  $('#pin').value = '';
  try { await enterAdmin(); } catch (e) { say('#lock-msg', e.message, 'err'); }
};
$('#pin').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#unlock').click(); });

$('#reset').onclick = () => {
  if (!confirm('Remove the saved token from this device?')) return;
  localStorage.removeItem(STORE); token = null;
  $('#setup-repo').value = guessRepo(); show('setup');
};
$('#lock-now').onclick = () => {
  if (ops.length && !confirm('You have unsaved changes. Lock anyway and lose them?')) return;
  ops = []; token = null; show('lock'); renderPending();
};

// ---------- pending changes ----------
// Edits are queued here and sent to GitHub together with "Save all" (one commit = one site rebuild).
// Each change is replayed on top of the latest songs.json at save time, so nothing made
// elsewhere in the meantime (e.g. the music-folder automation) gets overwritten.
let current = null;  // songs.json as last loaded from GitHub
let ops = [];        // [{ label, apply(data, ctx) }]

const clone = (d) => JSON.parse(JSON.stringify(d));
function replay(base, list = ops) {
  const data = clone(base);
  const ctx = { files: new Map(), deletes: new Set() };
  list.forEach((op) => op.apply(data, ctx));
  return { data, ctx };
}
const draft = () => replay(current).data;

function queue(label, apply) {
  ops.push({ label, apply });
  render();
}

function markTabs() {
  const which = new Set(ops.map((o) => (o.tab || (String(o.id || '').startsWith('pl:') ? 'playlists' : o.id ? 'songs' : tabForLabel(o.label)))));
  document.querySelectorAll('.atab').forEach((t) => {
    let dot = t.querySelector('.dot');
    if (which.has(t.dataset.panel)) { if (!dot) { dot = document.createElement('span'); dot.className = 'dot'; t.append(dot); } }
    else if (dot) dot.remove();
  });
}
function tabForLabel(label = '') {
  if (/^Add "/.test(label)) return 'songs';
  if (/playlist/i.test(label) && !/helper|Client ID|from the app/i.test(label)) return 'playlists';
  return 'settings';
}

function renderPending() {
  const bar = $('#pending');
  bar.hidden = !ops.length;
  $('#pending-count').textContent = `${ops.length} unsaved change${ops.length === 1 ? '' : 's'}`;
  const ul = $('#pending-list');
  ul.replaceChildren(...ops.map((o) => Object.assign(document.createElement('li'), { textContent: o.label })));
  markTabs();
}

function render() {
  const data = draft();
  renderEdit(data);
  renderPlaylistEditors(data);
  $('#yt-lists').value = (data.youtubePlaylists || []).map((p) => `${p.name} | ${p.url}`).join('\n');
  $('#sp-lists').value = (data.spotifyPlaylists || []).map((p) => `${p.name} | ${p.url}`).join('\n');
  $('#sp-client').value = data.spotify?.clientId || '';
  $('#cm-api').value = data.community?.api || '';
  renderPending();
}

async function refresh() {
  current = await readSongs();
  render();
}

$('#save-all').onclick = async () => {
  if (!ops.length) return;
  const btn = $('#save-all'); btn.disabled = true; $('#discard').disabled = true;
  try {
    say('#pending-msg', 'Saving…');
    const latest = await readSongs();
    const { data, ctx } = replay(latest);
    const files = [...ctx.files.entries()].map(([path, base64]) => ({ path, base64 }));
    if (ctx.deletes.size) {
      const tree = await gh(`/repos/${repo}/git/trees/${branch}?recursive=1`);
      const exists = new Set(tree.tree.map((t) => t.path));
      ctx.deletes.forEach((path) => { if (exists.has(path) && !ctx.files.has(path)) files.push({ path, delete: true }); });
    }
    files.push({ path: 'songs.json', text: json(data) });
    const msg = ops.length === 1 ? ops[0].label : `${ops.length} changes: ` + ops.map((o) => o.label).join('; ');
    await commit(msg.slice(0, 300), files);
    current = data;
    ops = [];
    render();
    say('#pending-msg', '');
    const t = $('#toast');
    t.textContent = 'Saved! The site will show it in about a minute.';
    t.hidden = false;
    setTimeout(() => { t.hidden = true; }, 5000);
  } catch (e) { say('#pending-msg', e.message, 'err'); }
  btn.disabled = false; $('#discard').disabled = false;
};

$('#discard').onclick = () => {
  if (!confirm('Throw away all unsaved changes?')) return;
  ops = [];
  render();
};

window.addEventListener('beforeunload', (e) => {
  if (ops.length) { e.preventDefault(); e.returnValue = ''; }
});

// ---------- admin actions ----------
$('#add-save').onclick = async () => {
  const title = $('#add-title').value.trim();
  const mp3 = $('#add-mp3').files[0];
  const cover = $('#add-cover').files[0];
  if (!title) return say('#add-msg', 'Give the song a title.', 'err');
  if (!mp3) return say('#add-msg', 'Pick the MP3 file.', 'err');
  if (mp3.size > 50 * 1024 * 1024) return say('#add-msg', 'That MP3 is over 50 MB.', 'err');
  const id = slug(title);
  const fields = {
    youtube: $('#add-yt').value.trim(),
    description: $('#add-desc').value.trim(),
    tags: tagsFrom($('#add-tags').value),
  };
  const mp3B64 = await fileB64(mp3);
  const coverExt = cover ? (cover.name.split('.').pop() || 'jpg').toLowerCase() : null;
  const coverB64 = cover ? await fileB64(cover) : null;
  const today = new Date().toISOString().slice(0, 10);

  queue(`Add "${title}"`, (data, ctx) => {
    let song = data.songs.find((s) => s.id === id);
    if (!song) { song = { id, title, file: '', cover: '', youtube: '', tags: [], added: today }; data.songs.push(song); }
    song.title = title;
    song.file = `music/${id}.mp3`;
    ctx.files.set(song.file, mp3B64);
    if (fields.youtube) song.youtube = fields.youtube;
    if (fields.description) song.description = fields.description;
    if (fields.tags.length) song.tags = fields.tags;
    if (coverB64) { song.cover = `covers/${id}.${coverExt}`; ctx.files.set(song.cover, coverB64); }
  });
  ['#add-title', '#add-desc', '#add-mp3', '#add-yt', '#add-cover', '#add-tags'].forEach((sel) => { $(sel).value = ''; });
  say('#add-msg', `"${title}" added to your changes. Tap Save all when you're done.`, 'ok');
};

// Tap an existing category to add it, so spelling stays consistent ("Family" vs "family").
function fillPicks(box, input, data) {
  const tags = [...new Set(data.songs.flatMap((s) => s.tags || []))].sort();
  box.replaceChildren();
  tags.forEach((t) => {
    const b = document.createElement('button');
    b.type = 'button'; b.textContent = '+ ' + t;
    b.onclick = () => {
      const cur = tagsFrom(input.value);
      if (!cur.some((x) => x.toLowerCase() === t.toLowerCase())) input.value = [...cur, t].join(', ');
    };
    box.append(b);
  });
}

function renderEdit(data) {
  fillPicks(document.querySelector('.tag-picks[data-for=add-tags]'), $('#add-tags'), data);
  const ul = $('#edit-list');
  const open = new Set([...ul.querySelectorAll('details[open]')].map((d) => d.dataset.id));
  ul.replaceChildren();
  data.songs.forEach((song) => {
    const li = document.createElement('li');
    li.innerHTML = `
      <details class="edit-row">
        <summary></summary>
        <label>Title</label><input class="e-title" type="text">
        <label>Short description</label><textarea class="e-desc" rows="2" maxlength="300"></textarea>
        <label>YouTube lyric video</label><input class="e-yt" type="url" placeholder="https://youtu.be/…">
        <label>Categories (comma separated)</label><input class="e-tags" type="text">
        <div class="tag-picks"></div>
        <label>Replace MP3 (optional)</label><input class="e-mp3" type="file" accept="audio/mpeg,.mp3">
        <label>Replace cover art (optional)</label><input class="e-cover" type="file" accept="image/*">
        <div class="btns"><button class="e-save">Done</button><button class="e-del danger">Delete</button></div>
        <div class="msg"></div>
      </details>`;
    const q = (sel) => li.querySelector(sel);
    q('details').dataset.id = song.id;
    if (open.has(song.id)) q('details').open = true;
    const pendingHere = ops.some((o) => o.id === song.id);
    q('summary').textContent = song.title + (pendingHere ? '  · edited' : '') + (song.youtube ? '' : '  · no video link');
    q('.e-title').value = song.title;
    q('.e-yt').value = song.youtube || '';
    q('.e-tags').value = (song.tags || []).join(', ');
    q('.e-desc').value = song.description || '';
    fillPicks(q('.tag-picks'), q('.e-tags'), data);
    const msg = (t, k = '') => { q('.msg').textContent = t; q('.msg').className = 'msg ' + k; };

    q('.e-save').onclick = async () => {
      const title = q('.e-title').value.trim();
      const youtube = q('.e-yt').value.trim();
      const tags = tagsFrom(q('.e-tags').value);
      const description = q('.e-desc').value.trim();
      const mp3 = q('.e-mp3').files[0], cover = q('.e-cover').files[0];
      const changed = title !== song.title || youtube !== (song.youtube || '') ||
        description !== (song.description || '') || tags.join('|') !== (song.tags || []).join('|') || mp3 || cover;
      if (!changed) { q('details').open = false; return; }
      msg('Adding to your changes…');
      const mp3B64 = mp3 ? await fileB64(mp3) : null;
      const coverExt = cover ? (cover.name.split('.').pop() || 'jpg').toLowerCase() : null;
      const coverB64 = cover ? await fileB64(cover) : null;
      const id = song.id;
      ops.push({
        id,
        label: `Edit "${title || song.title}"`,
        apply: (d, ctx) => {
          const s = d.songs.find((x) => x.id === id);
          if (!s) return; // removed elsewhere
          if (title) s.title = title;
          s.youtube = youtube;
          s.tags = tags;
          if (description) s.description = description; else delete s.description;
          if (mp3B64) { s.file = s.file || `music/${id}.mp3`; ctx.files.set(s.file, mp3B64); }
          if (coverB64) {
            const path = `covers/${id}.${coverExt}`;
            if (s.cover && s.cover !== path) ctx.deletes.add(s.cover);
            s.cover = path;
            ctx.files.set(path, coverB64);
          }
        },
      });
      q('details').open = false;
      render();
    };

    q('.e-del').onclick = () => {
      if (!confirm(`Delete "${song.title}" from the app? (Happens when you tap Save all.)`)) return;
      const id = song.id;
      ops.push({
        id,
        label: `Delete "${song.title}"`,
        apply: (d, ctx) => {
          const s = d.songs.find((x) => x.id === id);
          if (!s) return;
          d.songs = d.songs.filter((x) => x.id !== id);
          (d.playlists || []).forEach((p) => { if (Array.isArray(p.songs)) p.songs = p.songs.filter((x) => x !== id); });
          if (s.file) { ctx.files.delete(s.file); ctx.deletes.add(s.file); }
          if (s.cover) { ctx.files.delete(s.cover); ctx.deletes.add(s.cover); }
        },
      });
      render();
    };
    ul.append(li);
  });
}

// ---------- in-app playlists ----------
let newPlaylist = null; // an unsaved "New playlist" editor that's open

function playlistEditor(p, data, isNew) {
  const key = p.id || p.name;
  const stableId = p.id || slug(p.name) || 'playlist-' + Date.now();
  let picked = p.songs === 'all' ? [] : [...(p.songs || [])];
  let all = p.songs === 'all';
  const byId = Object.fromEntries(data.songs.map((s) => [s.id, s]));

  const li = document.createElement('li');
  li.innerHTML = `
    <details class="edit-row">
      <summary></summary>
      <label>Playlist name</label><input class="p-name" type="text" placeholder="Road trip">
      <label class="check"><input class="p-all" type="checkbox"> Every song (updates automatically)</label>
      <label class="check"><input class="p-hide" type="checkbox"> Hide from the app</label>
      <div class="p-pick">
        <ul class="pl-songs"></ul>
        <select class="pl-add"></select>
      </div>
      <div class="btns"><button class="p-done">Done</button><button class="p-del danger">${isNew ? 'Cancel' : 'Delete'}</button></div>
      <div class="msg"></div>
    </details>`;
  const q = (sel) => li.querySelector(sel);
  const det = q('details');
  det.dataset.id = 'pl:' + key;
  const pending = ops.some((o) => o.id === 'pl:' + stableId);
  q('summary').textContent = isNew ? 'New playlist' :
    `${p.name} · ${p.songs === 'all' ? 'every song' : (p.songs || []).length + ' songs'}${p.by ? ' · by ' + p.by : ''}${p.hidden ? ' · hidden' : ''}${pending ? ' · edited' : ''}`;
  q('.p-name').value = p.name || '';
  q('.p-all').checked = all;
  q('.p-hide').checked = !!p.hidden;

  function draw() {
    q('.p-pick').hidden = all;
    const ul = q('.pl-songs');
    ul.replaceChildren();
    picked.forEach((id, i) => {
      const row = document.createElement('li');
      const name = document.createElement('span');
      name.textContent = byId[id]?.title || id;
      const mk = (txt, label, fn, disabled) => {
        const b = document.createElement('button');
        b.type = 'button'; b.textContent = txt; b.setAttribute('aria-label', label); b.disabled = disabled;
        b.onclick = () => { fn(); draw(); };
        return b;
      };
      row.append(name,
        mk('↑', 'Move up', () => { [picked[i - 1], picked[i]] = [picked[i], picked[i - 1]]; }, i === 0),
        mk('↓', 'Move down', () => { [picked[i + 1], picked[i]] = [picked[i], picked[i + 1]]; }, i === picked.length - 1),
        mk('✕', 'Remove', () => { picked.splice(i, 1); }, false));
      ul.append(row);
    });
    const sel = q('.pl-add');
    sel.replaceChildren(new Option(picked.length ? '+ Add another song…' : '+ Add a song…', ''));
    data.songs.filter((s) => !picked.includes(s.id)).forEach((s) => sel.append(new Option(s.title, s.id)));
    sel.onchange = () => { if (sel.value) { picked.push(sel.value); draw(); } };
  }
  q('.p-all').onchange = (e) => { all = e.target.checked; draw(); };
  draw();

  q('.p-done').onclick = () => {
    const name = q('.p-name').value.trim();
    if (!name) { q('.msg').textContent = 'Give the playlist a name.'; q('.msg').className = 'msg err'; return; }
    const songs = all ? 'all' : [...picked];
    const hide = q('.p-hide').checked;
    const id = isNew ? (slug(name) || 'playlist') + '-' + Date.now().toString(36) : stableId;
    ops.push({
      id: 'pl:' + (isNew ? id : stableId),
      label: `${isNew ? 'New' : 'Edit'} playlist "${name}"`,
      apply: (d) => {
        d.playlists = d.playlists || [];
        let pl = d.playlists.find((x) => (x.id || x.name) === key || x.id === id);
        if (!pl || isNew) { pl = { id }; d.playlists.push(pl); }
        pl.id = pl.id || id;
        pl.name = name;
        pl.songs = songs;
        if (hide) pl.hidden = true; else delete pl.hidden;
      },
    });
    if (isNew) newPlaylist = null;
    det.open = false;
    render();
  };
  q('.p-del').onclick = () => {
    if (isNew) { newPlaylist = null; render(); return; }
    if (!confirm(`Delete the playlist "${p.name}"? (The songs stay.)`)) return;
    ops.push({
      id: 'pl:' + stableId,
      label: `Delete playlist "${p.name}"`,
      apply: (d) => { d.playlists = (d.playlists || []).filter((x) => (x.id || x.name) !== key); },
    });
    render();
  };
  return li;
}

function renderPlaylistEditors(data) {
  const ul = $('#pl-edit-list');
  const open = new Set([...ul.querySelectorAll('details[open]')].map((d) => d.dataset.id));
  ul.replaceChildren();
  (data.playlists || []).forEach((p) => {
    const li = playlistEditor(p, data, false);
    if (open.has(li.querySelector('details').dataset.id)) li.querySelector('details').open = true;
    ul.append(li);
  });
  if (newPlaylist) {
    const li = playlistEditor({ name: '', songs: [] }, data, true);
    li.querySelector('details').open = true;
    ul.append(li);
  }
}

$('#pl-new').onclick = () => {
  if (newPlaylist) return;
  newPlaylist = true;
  renderPlaylistEditors(draft());
  const last = $('#pl-edit-list').lastElementChild;
  last?.querySelector('.p-name')?.focus();
};

// Playlists-from-the-app helper (Cloudflare Worker)
$('#cm-api-test').onclick = async () => {
  const url = $('#cm-api').value.trim();
  if (!url) return say('#cm-api-msg', 'Paste the helper address first.', 'err');
  say('#cm-api-msg', 'Testing…');
  try {
    const res = await fetch(url, { cache: 'no-store' });
    const body = await res.json();
    say('#cm-api-msg', body.ok ? 'Connected! Now tap Add to changes, then Save all.' : 'It answered, but not like the playlist helper.', body.ok ? 'ok' : 'err');
  } catch { say('#cm-api-msg', "Couldn't reach it. Check the address (it should start with https://).", 'err'); }
};
$('#cm-api-save').onclick = () => {
  const url = $('#cm-api').value.trim().replace(/\/+$/, '');
  if (url && !/^https:\/\/[^\s]+$/.test(url)) return say('#cm-api-msg', 'The address should start with https://', 'err');
  queue(url ? 'Set playlist helper address' : 'Turn off playlists from the app', (d) => {
    if (url) d.community = { ...(d.community || {}), api: url }; else delete d.community;
  });
  say('#cm-api-msg', 'Added to your changes.', 'ok');
};

// Spotify Connect setup
$('#sp-redirect').textContent = location.origin + location.pathname.replace(/[^/]*$/, '');
$('#sp-copy').onclick = async () => {
  try { await navigator.clipboard.writeText($('#sp-redirect').textContent); $('#sp-copy').textContent = 'Copied!'; }
  catch { $('#sp-copy').textContent = 'Select it and copy'; }
};
$('#sp-client-save').onclick = () => {
  const id = $('#sp-client').value.trim();
  if (id && !/^[0-9a-f]{32}$/i.test(id)) return say('#sp-client-msg', "That doesn't look like a Spotify Client ID (32 letters and numbers).", 'err');
  queue(id ? 'Set Spotify Client ID' : 'Remove Spotify Client ID', (d) => { if (id) d.spotify = { ...(d.spotify || {}), clientId: id }; else delete d.spotify; });
  say('#sp-client-msg', 'Added to your changes.', 'ok');
};

$('#sp-save').onclick = () => {
  const lines = $('#sp-lists').value.split('\n').map((l) => l.split('|').map((x) => x.trim())).filter(([n, u]) => n || u);
  const bad = lines.find(([n, u]) => !n || !/spotify\.com\/|^spotify:/.test(u || ''));
  if (bad) return say('#sp-msg', `Check this line: "${bad.join(' | ')}". It needs a name, then |, then a Spotify link.`, 'err');
  const lists = lines.map(([name, url]) => ({ name, url }));
  queue('Update Spotify playlists', (d) => { d.spotifyPlaylists = lists; });
  say('#sp-msg', 'Added to your changes.', 'ok');
};

$('#yt-save').onclick = () => {
  const lists = $('#yt-lists').value.split('\n').map((l) => l.split('|').map((x) => x.trim()))
    .filter(([n, u]) => n && u).map(([name, url]) => ({ name, url }));
  queue('Update YouTube playlists', (d) => { d.youtubePlaylists = lists; });
  say('#yt-msg', 'Added to your changes.', 'ok');
};

// ---------- boot ----------
if (stored()) show('lock');
else { $('#setup-repo').value = guessRepo(); show('setup'); }
