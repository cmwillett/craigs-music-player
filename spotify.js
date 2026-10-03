// Spotify Connect: sign in with Spotify, list your playlists, and play them in the
// Spotify app (full songs, Premium) while controlling playback from this app.
// No server needed: uses Spotify's PKCE sign-in, which runs entirely in the browser.
// Loaded after app.js, so it can use $, el, audio, data, markPlaying, etc.

const SP = (() => {
  const ACCOUNTS = 'https://accounts.spotify.com';
  const API = 'https://api.spotify.com/v1';
  const STORE = 'spotify-auth-v1';
  const VERIFIER = 'spotify-pkce-verifier';
  const SCOPES = [
    'user-read-playback-state',
    'user-modify-playback-state',
    'user-read-currently-playing',
    'playlist-read-private',
    'playlist-read-collaborative',
  ].join(' ');

  let clientId = '';
  let auth = null;          // { access, refresh, expires }
  let playlists = null;     // user's playlists from Spotify
  let state = null;         // last /me/player response
  let stateAt = 0;          // when `state` was fetched (for smooth progress)
  let mode = 'local';       // 'local' (our MP3s) or 'spotify'
  let pollTimer = null;
  let tickTimer = null;
  let lastDevice = null;
  let managing = false;     // showing the "choose playlists" checklist
  const HIDDEN = 'spotify-hidden-v1';
  let hidden = new Set();   // playlist URIs this person chose to hide (saved on this device)
  const saveHidden = () => save(HIDDEN, [...hidden]);

  // ---------- helpers ----------
  const load = (k) => { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } };
  const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };
  const drop = (k) => { try { localStorage.removeItem(k); } catch {} };
  const redirectUri = () => location.origin + location.pathname.replace(/[^/]*$/, '');
  const b64url = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const isPhone = /android|iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

  function message(text, action) {
    const box = $('#sp-msg-box');
    if (!box) return;
    box.replaceChildren();
    box.hidden = !text;
    if (!text) return;
    box.append(el('span', { textContent: text }));
    if (action) box.append(action);
  }

  // ---------- sign in (PKCE) ----------
  async function connect() {
    const verifier = b64url(crypto.getRandomValues(new Uint8Array(48)));
    const challenge = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
    const nonce = b64url(crypto.getRandomValues(new Uint8Array(12)));
    save(VERIFIER, { verifier, nonce });
    const q = new URLSearchParams({
      client_id: clientId,
      response_type: 'code',
      redirect_uri: redirectUri(),
      code_challenge_method: 'S256',
      code_challenge: challenge,
      scope: SCOPES,
      state: nonce,
    });
    location.href = `${ACCOUNTS}/authorize?${q}`;
  }

  async function tokenRequest(params) {
    const res = await fetch(`${ACCOUNTS}/api/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: clientId, ...params }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error_description || body.error || `Spotify sign-in failed (${res.status})`);
    auth = {
      access: body.access_token,
      refresh: body.refresh_token || auth?.refresh,
      expires: Date.now() + (body.expires_in - 60) * 1000,
    };
    save(STORE, auth);
  }

  // Finish sign-in when Spotify sends us back with ?code=…
  async function finishSignIn() {
    const q = new URLSearchParams(location.search);
    if (!q.has('code') && !q.has('error')) return;
    const pending = load(VERIFIER);
    drop(VERIFIER);
    history.replaceState(null, '', location.pathname + location.hash);
    if (q.get('error')) { message(q.get('error') === 'access_denied' ? 'Spotify sign-in was cancelled.' : `Spotify sign-in failed: ${q.get('error')}`); return; }
    if (!pending || pending.nonce !== q.get('state')) { message('Spotify sign-in expired. Try connecting again.'); return; }
    await tokenRequest({ grant_type: 'authorization_code', code: q.get('code'), redirect_uri: redirectUri(), code_verifier: pending.verifier });
    showPlaylistsTab();
  }

  async function token() {
    if (!auth) return null;
    if (Date.now() > auth.expires) {
      try { await tokenRequest({ grant_type: 'refresh_token', refresh_token: auth.refresh }); }
      catch { disconnect('Your Spotify sign-in expired. Connect again.'); return null; }
    }
    return auth.access;
  }

  function disconnect(why) {
    auth = null; playlists = null; state = null;
    drop(STORE);
    stopPolling();
    if (mode === 'spotify') setMode('local');
    render();
    if (why) message(why);
  }

  // ---------- Web API ----------
  async function api(path, opts = {}) {
    const t = await token();
    if (!t) throw Object.assign(new Error('Not connected'), { code: 'AUTH' });
    const res = await fetch(API + path, {
      ...opts,
      headers: { Authorization: `Bearer ${t}`, ...(opts.body ? { 'Content-Type': 'application/json' } : {}) },
    });
    if (res.status === 204 || res.status === 202) return null;
    const text = await res.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch {}
    if (!res.ok) {
      const msg = body?.error?.message || text || `Spotify error ${res.status}`;
      const err = new Error(msg);
      err.status = res.status;
      err.reason = body?.error?.reason;
      throw err;
    }
    return body;
  }

  function explain(err) {
    if (err.status === 401) return disconnect('Your Spotify sign-in expired. Connect again.');
    if (err.status === 403 && /premium/i.test(err.reason || err.message)) return message('Playing from Spotify here needs Spotify Premium.');
    if (err.status === 403 && /registered|developer/i.test(err.message)) {
      return disconnect("This Spotify account isn't on the app's allowed list yet. Ask Craig to add your Spotify email.");
    }
    if (err.status === 404 || err.reason === 'NO_ACTIVE_DEVICE') return needDevice();
    message(err.message);
  }

  function needDevice() {
    const open = el('a', {
      className: 'sp-btn',
      textContent: 'Open Spotify',
      href: isPhone ? 'spotify:' : 'https://open.spotify.com/',
      target: isPhone ? '_self' : '_blank',
      rel: 'noopener',
    });
    message(isPhone
      ? 'Spotify needs to be open on this phone. Tap Open Spotify, then come back and tap the playlist again.'
      : 'Open Spotify (the app or open.spotify.com) on this computer, then tap the playlist again.', open);
  }

  async function loadPlaylists() {
    const out = [];
    let url = '/me/playlists?limit=50';
    while (url && out.length < 500) {
      const page = await api(url);
      (page.items || []).forEach((p) => p && out.push(p));
      url = page.next ? page.next.replace(API, '') : null;
    }
    playlists = out;
  }

  async function pickDevice() {
    const { devices = [] } = (await api('/me/player/devices')) || {};
    const usable = devices.filter((d) => !d.is_restricted);
    const pick = usable.find((d) => d.is_active)
      || (isPhone ? usable.find((d) => d.type === 'Smartphone') : usable.find((d) => d.type === 'Computer'))
      || usable.find((d) => d.id === lastDevice)
      || usable[0];
    return pick ? pick.id : null;
  }

  // ---------- playback ----------
  async function playContext(uri, { shuffle = false } = {}) {
    message('');
    try {
      const device = await pickDevice();
      if (!device) return needDevice();
      lastDevice = device;
      await api(`/me/player/shuffle?state=${shuffle}&device_id=${device}`, { method: 'PUT' }).catch(() => {});
      await api(`/me/player/play?device_id=${device}`, { method: 'PUT', body: JSON.stringify({ context_uri: uri }) });
      setMode('spotify');
      setTimeout(refresh, 600);
    } catch (e) { explain(e); }
  }

  async function control(action) {
    try {
      if (action === 'toggle') {
        const playing = state?.is_playing;
        await api(`/me/player/${playing ? 'pause' : 'play'}`, { method: 'PUT' });
        if (state) { state.is_playing = !playing; stateAt = Date.now(); }
      } else if (action === 'next') await api('/me/player/next', { method: 'POST' });
      else if (action === 'prev') await api('/me/player/previous', { method: 'POST' });
      paint();
      setTimeout(refresh, 500);
    } catch (e) { explain(e); }
  }

  async function seekTo(fraction) {
    const dur = state?.item?.duration_ms;
    if (!dur) return;
    const ms = Math.round(fraction * dur);
    try {
      await api(`/me/player/seek?position_ms=${ms}`, { method: 'PUT' });
      state.progress_ms = ms; stateAt = Date.now(); paint();
    } catch (e) { explain(e); }
  }

  // Pause Spotify when one of our MP3s starts.
  function yieldToLocal() {
    if (mode !== 'spotify') return;
    setMode('local');
    if (state?.is_playing) api('/me/player/pause', { method: 'PUT' }).catch(() => {});
  }

  function setMode(m) {
    mode = m;
    if (m === 'spotify') {
      if (!audio.paused) audio.pause();
      $('#player').hidden = false;
      startPolling();
    } else {
      stopPolling();
    }
    paint();
    markPlaying();
  }

  // ---------- now-playing ----------
  async function refresh() {
    if (!auth) return;
    try {
      const s = await api('/me/player');
      state = s; stateAt = Date.now();
      if (s?.device?.id) lastDevice = s.device.id;
      paint();
      markSpotify();
    } catch (e) { if (e.status === 401) explain(e); }
  }
  function startPolling() {
    stopPolling();
    refresh();
    pollTimer = setInterval(() => { if (!document.hidden) refresh(); }, 5000);
    tickTimer = setInterval(paint, 1000);
  }
  function stopPolling() { clearInterval(pollTimer); clearInterval(tickTimer); pollTimer = tickTimer = null; }
  document.addEventListener('visibilitychange', () => { if (!document.hidden && mode === 'spotify') refresh(); });

  const fmtMs = (ms) => fmt((ms || 0) / 1000);

  function paint() {
    if (mode !== 'spotify') return;
    const item = state?.item;
    const playing = !!state?.is_playing;
    $('#toggle').textContent = playing ? '⏸' : '▶';
    if (!item) {
      $('#np-title').textContent = state ? 'Spotify' : 'Starting Spotify…';
      $('#np-time').textContent = state?.device ? `on ${state.device.name}` : '';
      return;
    }
    const artists = (item.artists || []).map((a) => a.name).join(', ');
    $('#np-title').textContent = item.name + (artists ? ` · ${artists}` : '');
    const img = item.album?.images?.slice(-2)[0]?.url || item.album?.images?.[0]?.url;
    const c = $('#np-cover');
    if (img) c.src = img; else c.removeAttribute('src');
    let pos = state.progress_ms || 0;
    if (playing) pos = Math.min(item.duration_ms, pos + (Date.now() - stateAt));
    $('#np-time').textContent = `${fmtMs(pos)} / ${fmtMs(item.duration_ms)}` + (state.device ? ` · ${state.device.name}` : '');
    if (!seeking) $('#seek').value = item.duration_ms ? (pos / item.duration_ms) * 100 : 0;
    const ctx = state.context?.uri;
    const name = ctx && (playlists || []).find((p) => p.uri === ctx)?.name
      || ctx && (data.spotifyPlaylists || []).find((p) => spotifyUri(p.url) === ctx)?.name;
    $('#np-source').hidden = false;
    $('#np-source').textContent = name ? `Spotify · ${name}` : 'Spotify';
  }

  function spotifyUri(url) {
    const s = String(url || '');
    const m = s.match(/^spotify:(\w+):(\w+)/) || s.match(/spotify\.com\/(?:intl-[a-z-]+\/)?(?:embed\/)?(playlist|album|track|artist|show|episode)\/([A-Za-z0-9]+)/);
    return m ? `spotify:${m[1]}:${m[2]}` : null;
  }

  // Highlight the Spotify playlist that's playing.
  function markSpotify() {
    const ctx = mode === 'spotify' ? state?.context?.uri : null;
    const playing = !!state?.is_playing;
    document.querySelectorAll('[data-sp-uri]').forEach((r) => {
      const on = !!ctx && r.dataset.spUri === ctx;
      r.classList.toggle('playing', on);
      const meta = r.querySelector('.sp-meta');
      if (meta) {
        meta.replaceChildren();
        if (on) meta.append(el('span', { className: 'eq' + (playing ? '' : ' paused') }, el('i'), el('i'), el('i')), playing ? 'Now playing' : 'Paused');
        else meta.textContent = r.dataset.spMeta || '';
      }
    });
  }

  // ---------- UI ----------
  function showPlaylistsTab() {
    document.querySelector('.tab[data-view=playlists]')?.click();
  }

  function render() {
    const box = $('#my-sp');
    if (!box) return;
    box.hidden = !clientId;
    if (!clientId) return;
    const list = $('#my-sp-list');
    list.replaceChildren();
    $('#sp-connect').hidden = !!auth;
    $('#sp-disconnect').hidden = !auth;
    $('#sp-manage').hidden = !auth || !playlists || !playlists.length;
    $('#sp-manage').textContent = managing ? 'Done' : 'Choose playlists';
    $('#sp-manage').className = managing ? 'sp-btn' : 'sp-link';
    $('#sp-disconnect').hidden = !auth || managing;
    if (!auth) {
      $('#my-sp-hint').textContent = 'Spotify Premium: connect once to play your own playlists here with full songs.';
      return;
    }
    $('#my-sp-hint').textContent = managing
      ? 'Check the playlists you want to see here, then tap Done.'
      : 'Plays in the Spotify app on this device. Keep Spotify open in the background.';
    if (!playlists) { list.append(el('li', { className: 'empty', textContent: 'Loading your playlists…' })); return; }
    if (!playlists.length) { list.append(el('li', { className: 'empty', textContent: 'No playlists found on your Spotify account.' })); return; }
    const shown = managing ? playlists : playlists.filter((p) => !hidden.has(p.uri));
    if (!managing && !shown.length) {
      list.append(el('li', { className: 'empty', textContent: 'All your Spotify playlists are hidden. Tap Choose playlists to show some.' }));
    }
    shown.forEach((p) => {
      const img = p.images?.slice(-1)[0]?.url || p.images?.[0]?.url;
      const cover = img ? el('img', { className: 'cover', src: img, alt: '', loading: 'lazy' }) : el('div', { className: 'cover sp-cover' });
      const count = p.tracks?.total ?? p.items?.total;
      const metaText = count != null ? `${count} song${count === 1 ? '' : 's'}` : (p.owner?.display_name || '');
      const main = el('button', { className: 'main' }, cover,
        el('div', {}, el('div', { className: 'title', textContent: p.name }), el('div', { className: 'meta sp-meta', textContent: metaText })));
      if (managing) {
        const box = el('input', { type: 'checkbox', className: 'sp-check', checked: !hidden.has(p.uri) });
        box.setAttribute('aria-label', `Show ${p.name}`);
        const flip = () => {
          if (hidden.has(p.uri)) hidden.delete(p.uri); else hidden.add(p.uri);
          saveHidden();
          box.checked = !hidden.has(p.uri);
          li.classList.toggle('sp-off', hidden.has(p.uri));
          updateCount();
        };
        main.onclick = flip;
        box.onclick = (e) => { e.stopPropagation(); flip(); box.checked = !hidden.has(p.uri); };
        const li = el('li', { className: 'row' + (hidden.has(p.uri) ? ' sp-off' : '') }, main, box);
        list.append(li);
        return;
      }
      main.onclick = () => {
        if (mode === 'spotify' && state?.context?.uri === p.uri) return control('toggle');
        playContext(p.uri);
      };
      const shuf = el('button', { className: 'pill', textContent: '⤮', title: 'Shuffle' });
      shuf.onclick = () => playContext(p.uri, { shuffle: true });
      const li = el('li', { className: 'row' }, main, shuf);
      li.dataset.spUri = p.uri;
      li.dataset.spMeta = metaText;
      list.append(li);
    });
    if (managing) {
      const bar = el('li', { className: 'sp-manage-bar' });
      const all = el('button', { className: 'sp-link', textContent: 'Show all' });
      all.onclick = () => { hidden.clear(); saveHidden(); render(); };
      const none = el('button', { className: 'sp-link', textContent: 'Hide all' });
      none.onclick = () => { playlists.forEach((p) => hidden.add(p.uri)); saveHidden(); render(); };
      bar.append(el('span', { id: 'sp-count' }), all, none);
      list.prepend(bar);
      updateCount();
    } else if (hidden.size && playlists.some((p) => hidden.has(p.uri))) {
      const n = playlists.filter((p) => hidden.has(p.uri)).length;
      list.append(el('li', { className: 'sp-hidden-note', textContent: `${n} playlist${n === 1 ? '' : 's'} hidden` }));
    }
    markSpotify();
  }

  function updateCount() {
    const c = $('#sp-count');
    if (!c || !playlists) return;
    const n = playlists.filter((p) => !hidden.has(p.uri)).length;
    c.textContent = `Showing ${n} of ${playlists.length}`;
  }

  // ---------- public ----------
  return {
    async init(d) {
      clientId = (d.spotify && d.spotify.clientId) || '';
      auth = load(STORE);
      hidden = new Set(load(HIDDEN) || []);
      $('#sp-manage').onclick = () => { managing = !managing; render(); };
      $('#sp-connect').onclick = () => connect();
      $('#sp-disconnect').onclick = () => { if (confirm('Disconnect Spotify on this device?')) disconnect(); };
      if (!clientId) { render(); return; }
      try { await finishSignIn(); } catch (e) { message(e.message); }
      render();
      if (auth) {
        try { await loadPlaylists(); } catch (e) { explain(e); playlists = playlists || []; }
        render();
        // If Spotify is already playing on this device, pick it up.
        try {
          const s = await api('/me/player');
          if (s?.is_playing) { state = s; stateAt = Date.now(); setMode('spotify'); }
        } catch {}
      }
    },
    connected: () => !!(clientId && auth),
    active: () => mode === 'spotify',
    playUrl(url) { const uri = spotifyUri(url); if (uri) playContext(uri); return !!uri; },
    control,
    seekTo,
    yieldToLocal,
    markSpotify,
  };
})();
