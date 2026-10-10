// Lets Craig add songs to his Admin playlists from the main app (⋯ → Add to playlist).
// Only on a device where the Admin page is set up: it uses the same saved GitHub key,
// which stays encrypted with the Admin PIN. Unlocked only in memory, until the app is closed.
// Loaded before community.js.

const ADMIN = (() => {
  const STORE = 'songs-admin-v1';
  const API = 'https://api.github.com';
  let token = null, repo = null;
  const stored = () => { try { return JSON.parse(localStorage.getItem(STORE) || 'null'); } catch { return null; } };

  const enc = new TextEncoder(), dec = new TextDecoder();
  const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  async function open(pin) { // same as admin.js openSecret()
    const s = stored();
    const base = await crypto.subtle.importKey('raw', enc.encode(pin), 'PBKDF2', false, ['deriveKey']);
    const key = await crypto.subtle.deriveKey({ name: 'PBKDF2', salt: unb64(s.salt), iterations: 310000, hash: 'SHA-256' },
      base, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(s.iv) }, key, unb64(s.ct));
    return { token: dec.decode(pt), repo: s.repo };
  }

  // Shows a PIN box under the playlist list; resolves once unlocked.
  function unlock(msgEl) {
    return new Promise((resolve, reject) => {
      document.querySelector('.pin-row')?.remove();
      const input = el('input', { className: 'cm-input', type: 'password', inputMode: 'numeric', autocomplete: 'off', placeholder: 'Admin PIN' });
      const go = el('button', { textContent: 'Unlock' });
      const row = el('div', { className: 'pin-row' }, input, go);
      msgEl.before(row);
      setTimeout(() => input.focus(), 30);
      const done = (fn) => { obs.disconnect(); row.remove(); fn(); };
      const tryIt = async () => {
        go.disabled = true; msgEl.textContent = 'Checking…';
        try { ({ token, repo } = await open(input.value.trim())); msgEl.textContent = ''; done(resolve); }
        catch { msgEl.textContent = 'Wrong PIN.'; go.disabled = false; input.select(); }
      };
      go.onclick = tryIt;
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') tryIt(); });
      // If the picker is closed while asking, give up quietly.
      const obs = new MutationObserver(() => { if ($('#pick-modal').hidden) done(() => reject(new Error('cancelled'))); });
      obs.observe($('#pick-modal'), { attributes: true, attributeFilter: ['hidden'] });
    });
  }

  async function gh(path, opts = {}) {
    const res = await fetch(API + path, {
      cache: 'no-store', ...opts,
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', ...(opts.body ? { 'Content-Type': 'application/json' } : {}) },
    });
    const body = await res.json().catch(() => ({}));
    if (res.status === 401) { token = null; throw new Error('Your Admin key no longer works. Set it up again on the Admin page.'); }
    if (!res.ok) { const e = new Error(`GitHub error ${res.status} ${body.message || ''}`.trim()); e.status = res.status; throw e; }
    return body;
  }
  const fromB64 = (s) => dec.decode(unb64(s.replace(/\n/g, '')));
  const toB64 = (text) => { const b = enc.encode(text); let s = ''; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000)); return btoa(s); };

  // Adds song ids to the playlist (by id or name) in songs.json. Retries if something else saved at the same moment.
  async function addSongs(key, ids) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const file = await gh(`/repos/${repo}/contents/songs.json`);
      const d = JSON.parse(fromB64(file.content));
      const p = (d.playlists || []).find((x) => (x.id || x.name) === key && !x.user);
      if (!p || !Array.isArray(p.songs)) throw new Error("That playlist isn't there any more.");
      const before = p.songs.length;
      ids.forEach((id) => { if (!p.songs.includes(id)) p.songs.push(id); });
      const added = p.songs.length - before;
      if (!added) return { playlist: p, added: 0 };
      try {
        await gh(`/repos/${repo}/contents/songs.json`, { method: 'PUT', body: JSON.stringify({
          message: `Add ${added} song${added === 1 ? '' : 's'} to "${p.name}" (from the app)`,
          content: toB64(JSON.stringify(d, null, 2) + '\n'), sha: file.sha }) });
        return { playlist: p, added };
      } catch (e) { if (e.status !== 409 && e.status !== 422) throw e; } // changed underneath us: re-read and retry
    }
    throw new Error('Someone else was saving at the same time. Try again.');
  }

  return { available: () => !!stored(), unlocked: () => !!token, unlock, addSongs };
})();
