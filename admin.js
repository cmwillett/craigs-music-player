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
$('#lock-now').onclick = () => { token = null; show('lock'); };

// ---------- admin actions ----------
async function refresh() {
  const data = await readSongs();
  renderEdit(data);
  $('#yt-lists').value = (data.youtubePlaylists || []).map((p) => `${p.name} | ${p.url}`).join('\n');
}

$('#add-save').onclick = async () => {
  const title = $('#add-title').value.trim();
  const mp3 = $('#add-mp3').files[0];
  const cover = $('#add-cover').files[0];
  if (!title) return say('#add-msg', 'Give the song a title.', 'err');
  if (!mp3) return say('#add-msg', 'Pick the MP3 file.', 'err');
  if (mp3.size > 50 * 1024 * 1024) return say('#add-msg', 'That MP3 is over 50 MB.', 'err');
  const btn = $('#add-save'); btn.disabled = true;
  try {
    say('#add-msg', 'Uploading…');
    const id = slug(title);
    const data = await readSongs();
    let song = data.songs.find((s) => s.id === id);
    if (!song) { song = { id, title, file: '', cover: '', youtube: '', tags: [] }; data.songs.push(song); }
    song.title = title;
    song.file = `music/${id}.mp3`;
    song.youtube = $('#add-yt').value.trim() || song.youtube || '';
    const desc = $('#add-desc').value.trim();
    if (desc) song.description = desc;
    const tags = tagsFrom($('#add-tags').value);
    if (tags.length) song.tags = tags;
    const files = [{ path: song.file, base64: await fileB64(mp3) }];
    if (cover) {
      const ext = (cover.name.split('.').pop() || 'jpg').toLowerCase();
      song.cover = `covers/${id}.${ext}`;
      files.push({ path: song.cover, base64: await fileB64(cover) });
    }
    files.push({ path: 'songs.json', text: json(data) });
    await commit(`Add song: ${title}`, files);
    ['#add-title', '#add-desc', '#add-mp3', '#add-yt', '#add-cover', '#add-tags'].forEach((s) => { $(s).value = ''; });
    say('#add-msg', `Added "${title}". It'll show up in about a minute.`, 'ok');
    await refresh();
  } catch (e) { say('#add-msg', e.message, 'err'); }
  btn.disabled = false;
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
        <div class="btns"><button class="e-save">Save</button><button class="e-del danger">Delete</button></div>
        <div class="msg"></div>
      </details>`;
    const q = (s) => li.querySelector(s);
    q('summary').textContent = song.title + (song.youtube ? '' : '  · no video link');
    q('.e-title').value = song.title;
    q('.e-yt').value = song.youtube || '';
    q('.e-tags').value = (song.tags || []).join(', ');
    q('.e-desc').value = song.description || '';
    fillPicks(q('.tag-picks'), q('.e-tags'), data);
    const msg = (t, k = '') => { q('.msg').textContent = t; q('.msg').className = 'msg ' + k; };

    q('.e-save').onclick = async () => {
      try {
        msg('Saving…');
        const fresh = await readSongs();
        const s = fresh.songs.find((x) => x.id === song.id);
        if (!s) throw new Error('That song was removed.');
        s.title = q('.e-title').value.trim() || s.title;
        s.youtube = q('.e-yt').value.trim();
        s.tags = tagsFrom(q('.e-tags').value);
        const d = q('.e-desc').value.trim();
        if (d) s.description = d; else delete s.description;
        const files = [];
        const mp3 = q('.e-mp3').files[0], cover = q('.e-cover').files[0];
        if (mp3) { s.file = `music/${s.id}.mp3`; files.push({ path: s.file, base64: await fileB64(mp3) }); }
        if (cover) {
          const ext = (cover.name.split('.').pop() || 'jpg').toLowerCase();
          if (s.cover && s.cover !== `covers/${s.id}.${ext}`) files.push({ path: s.cover, delete: true });
          s.cover = `covers/${s.id}.${ext}`;
          files.push({ path: s.cover, base64: await fileB64(cover) });
        }
        files.push({ path: 'songs.json', text: json(fresh) });
        await commit(`Update song: ${s.title}`, files);
        msg('Saved.', 'ok');
        await refresh();
      } catch (e) { msg(e.message, 'err'); }
    };

    q('.e-del').onclick = async () => {
      if (!confirm(`Delete "${song.title}" from the app?`)) return;
      try {
        msg('Deleting…');
        const fresh = await readSongs();
        const s = fresh.songs.find((x) => x.id === song.id);
        fresh.songs = fresh.songs.filter((x) => x.id !== song.id);
        (fresh.playlists || []).forEach((p) => { if (Array.isArray(p.songs)) p.songs = p.songs.filter((id) => id !== song.id); });
        const files = [{ path: 'songs.json', text: json(fresh) }];
        const tree = await gh(`/repos/${repo}/git/trees/${branch}?recursive=1`);
        const exists = new Set(tree.tree.map((t) => t.path));
        if (s?.file && exists.has(s.file)) files.push({ path: s.file, delete: true });
        if (s?.cover && exists.has(s.cover)) files.push({ path: s.cover, delete: true });
        await commit(`Delete song: ${song.title}`, files);
        await refresh();
      } catch (e) { msg(e.message, 'err'); }
    };
    ul.append(li);
  });
}

$('#yt-save').onclick = async () => {
  try {
    say('#yt-msg', 'Saving…');
    const lists = $('#yt-lists').value.split('\n').map((l) => l.split('|').map((x) => x.trim()))
      .filter(([n, u]) => n && u).map(([name, url]) => ({ name, url }));
    const data = await readSongs();
    data.youtubePlaylists = lists;
    await commit('Update YouTube playlists', [{ path: 'songs.json', text: json(data) }]);
    say('#yt-msg', 'Saved.', 'ok');
  } catch (e) { say('#yt-msg', e.message, 'err'); }
};

// ---------- boot ----------
if (stored()) show('lock');
else { $('#setup-repo').value = guessRepo(); show('setup'); }
