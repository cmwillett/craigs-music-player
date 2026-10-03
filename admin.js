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

async function enterAdmin() {
  await connect();
  show('admin');
  await refresh();
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

function renderPending() {
  const bar = $('#pending');
  bar.hidden = !ops.length;
  $('#pending-count').textContent = `${ops.length} unsaved change${ops.length === 1 ? '' : 's'}`;
  const ul = $('#pending-list');
  ul.replaceChildren(...ops.map((o) => Object.assign(document.createElement('li'), { textContent: o.label })));
}

function render() {
  const data = draft();
  renderEdit(data);
  renderPlaylistEditors(data);
  $('#yt-lists').value = (data.youtubePlaylists || []).map((p) => `${p.name} | ${p.url}`).join('\n');
  $('#sp-lists').value = (data.spotifyPlaylists || []).map((p) => `${p.name} | ${p.url}`).join('\n');
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

  queue(`Add "${title}"`, (data, ctx) => {
    let song = data.songs.find((s) => s.id === id);
    if (!song) { song = { id, title, file: '', cover: '', youtube: '', tags: [] }; data.songs.push(song); }
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
    `${p.name} · ${p.songs === 'all' ? 'every song' : (p.songs || []).length + ' songs'}${pending ? ' · edited' : ''}`;
  q('.p-name').value = p.name || '';
  q('.p-all').checked = all;

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
