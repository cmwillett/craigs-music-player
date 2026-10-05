// Playlists anyone can make from the app. Saving goes through a small Cloudflare Worker
// (worker/playlist-worker.js) that holds the GitHub key and can only change playlists.
// Loaded after app.js, so it can use $, el, data, renderPlaylists, toast, etc.

const CM = (() => {
  const KEY = 'community-owner-key-v1';   // random secret that marks "playlists I made" on this device
  const NAME = 'community-name-v1';       // the name shown as "by …"
  const OVERLAY = 'community-overlay-v1'; // just-saved changes, shown until GitHub Pages catches up
  const OVERLAY_MINUTES = 10;

  const load = (k) => { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } };
  const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };

  let ownerKey = load(KEY);
  if (!ownerKey) {
    ownerKey = Array.from(crypto.getRandomValues(new Uint8Array(24)), (b) => b.toString(16).padStart(2, '0')).join('');
    save(KEY, ownerKey);
  }
  let ownerHash = null;
  const ready = (async () => {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('songs:' + ownerKey));
    ownerHash = [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 32);
  })();

  const api = () => data?.community?.api || '';
  const isMine = (p) => !!(p && p.user && ownerHash && p.owner === ownerHash);

  // ---------- show fresh saves right away ----------
  function applyOverlay(d) {
    const now = Date.now();
    const list = (load(OVERLAY) || []).filter((o) => now - o.at < OVERLAY_MINUTES * 60e3);
    save(OVERLAY, list);
    d.playlists = d.playlists || [];
    list.forEach((o) => {
      const i = d.playlists.findIndex((p) => p.id === o.id);
      if (o.playlist === null) { if (i >= 0) d.playlists.splice(i, 1); return; }
      if (i >= 0) d.playlists[i] = o.playlist; else d.playlists.push(o.playlist);
    });
  }
  function remember(id, playlist) {
    const list = (load(OVERLAY) || []).filter((o) => o.id !== id);
    list.push({ id, playlist, at: Date.now() });
    save(OVERLAY, list);
  }

  // ---------- talking to the Worker ----------
  async function send(action, playlist) {
    const res = await fetch(api(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, playlist, ownerKey, by: load(NAME) || '' }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body.ok) throw new Error(body.error || `Couldn't save (error ${res.status}).`);
    return body;
  }

  // ---------- editor ----------
  let editing = null;  // playlist being edited (null = new)
  let picked = [];

  function open(p = null) {
    editing = p;
    picked = p ? [...(p.songs === 'all' ? [] : p.songs || [])] : [];
    $('#cm-title').textContent = p ? 'Edit playlist' : 'New playlist';
    $('#cm-name').value = p ? p.name : '';
    $('#cm-by').value = load(NAME) || '';
    $('#cm-delete').hidden = !p;
    $('#cm-msg').textContent = '';
    $('#cm-save').disabled = false;
    draw();
    $('#cm-modal').hidden = false;
    document.body.classList.add('modal-open');
    setTimeout(() => (p ? null : $('#cm-name').focus()), 50);
  }
  function close() {
    $('#cm-modal').hidden = true;
    document.body.classList.remove('modal-open');
  }

  function draw() {
    const byId = Object.fromEntries(data.songs.map((s) => [s.id, s]));
    picked = picked.filter((id) => byId[id]);
    const ul = $('#cm-songs');
    ul.replaceChildren();
    if (!picked.length) ul.append(el('li', { className: 'cm-empty', textContent: 'No songs yet. Add some below.' }));
    picked.forEach((id, i) => {
      const btn = (txt, label, fn, disabled) => {
        const b = el('button', { type: 'button', textContent: txt, disabled });
        b.setAttribute('aria-label', label);
        b.onclick = () => { fn(); draw(); };
        return b;
      };
      ul.append(el('li', {},
        el('span', { textContent: byId[id].title }),
        btn('↑', 'Move up', () => { [picked[i - 1], picked[i]] = [picked[i], picked[i - 1]]; }, i === 0),
        btn('↓', 'Move down', () => { [picked[i + 1], picked[i]] = [picked[i], picked[i + 1]]; }, i === picked.length - 1),
        btn('✕', 'Remove', () => { picked.splice(i, 1); }, false)));
    });
    const sel = $('#cm-add');
    sel.replaceChildren(new Option(picked.length ? '+ Add another song…' : '+ Add a song…', ''));
    data.songs.filter((s) => s.file && !picked.includes(s.id))
      .sort((a, b) => a.title.localeCompare(b.title))
      .forEach((s) => sel.append(new Option(s.title, s.id)));
    $('#cm-count').textContent = picked.length ? `· ${picked.length}` : '';
    $('#cm-msg').textContent = '';
  }

  async function onSave() {
    const name = $('#cm-name').value.trim();
    const by = $('#cm-by').value.trim();
    if (!name) { $('#cm-msg').textContent = 'Give the playlist a name.'; return; }
    if (!picked.length) { $('#cm-msg').textContent = 'Add at least one song.'; return; }
    save(NAME, by);
    $('#cm-save').disabled = true;
    $('#cm-msg').textContent = 'Saving…';
    try {
      const res = await send('save', { id: editing?.id, name, songs: picked });
      remember(res.playlist.id, res.playlist);
      applyOverlay(data);
      close();
      renderPlaylists();
      if (typeof showPlaylist === 'function') showPlaylist(res.playlist.id);
      toast(editing ? 'Playlist updated.' : 'Playlist saved! Everyone will see it in about a minute.', null, null, 4000);
    } catch (e) {
      $('#cm-msg').textContent = e.message;
      $('#cm-save').disabled = false;
    }
  }

  async function onDelete() {
    if (!editing) return;
    if (!confirm(`Delete the playlist "${editing.name}"? (The songs stay.)`)) return;
    $('#cm-msg').textContent = 'Deleting…';
    try {
      await send('delete', { id: editing.id });
      remember(editing.id, null);
      applyOverlay(data);
      close();
      if (typeof openPlaylist !== 'undefined') openPlaylist = null;
      renderPlaylists();
      toast('Playlist deleted.', null, null, 3000);
    } catch (e) { $('#cm-msg').textContent = e.message; }
  }

  // ---------- hooks used by app.js ----------
  function decorateDetail(p) {
    const by = $('#pl-by');
    by.textContent = p && p.by ? `by ${p.by}` : '';
    by.hidden = !(p && p.by);
    const mine = isMine(p) && !!api();
    $('#pl-edit').hidden = !mine;
    if (mine) $('#pl-edit').onclick = () => open(p);
  }
  function refreshButtons() {
    $('#pl-new').hidden = !api();
  }

  $('#pl-new').onclick = () => open(null);
  ['#cm-name', '#cm-by'].forEach((sel) => $(sel).addEventListener('input', () => { $('#cm-msg').textContent = ''; }));
  $('#cm-cancel').onclick = close;
  $('#cm-save').onclick = onSave;
  $('#cm-delete').onclick = onDelete;
  $('#cm-add').onchange = (e) => { if (e.target.value) { picked.push(e.target.value); draw(); } };
  $('#cm-modal').addEventListener('click', (e) => { if (e.target.id === 'cm-modal') close(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#cm-modal').hidden) close(); });

  return { applyOverlay, decorateDetail, refreshButtons, isMine, ready };
})();
