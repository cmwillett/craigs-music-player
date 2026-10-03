// Craig's Songs — a tiny static music player. All content comes from songs.json.
const $ = (s) => document.querySelector(s);
const audio = $('#audio');

let data = { songs: [], playlists: [], youtubePlaylists: [] };
let queue = [];     // array of song objects
let index = -1;     // position in queue

const fmt = (t) => {
  if (!isFinite(t)) return '0:00';
  const m = Math.floor(t / 60), s = Math.floor(t % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
};
const coverOf = (song) => song.cover || '';
const el = (tag, props = {}, ...kids) => {
  const n = Object.assign(document.createElement(tag), props);
  kids.flat().forEach((k) => k != null && n.append(k));
  return n;
};
const shuffle = (arr) => {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};
const playable = () => data.songs.filter((s) => s.file);

// ---------- small helpers for new features ----------
const NEW_DAYS = 14; // how long a song shows the NEW badge
const isNew = (s) => !!s.added && (Date.now() - Date.parse(s.added)) < NEW_DAYS * 864e5;
let search = '';
const SHARE_ICON = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M12 3v12M7 8l5-5 5 5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
const appUrl = () => location.origin + location.pathname.replace(/[^/]*$/, '');

let toastTimer = null;
function toast(text, actionLabel, action, ms = 5000) {
  const t = $('#toast');
  t.replaceChildren(el('span', { textContent: text }));
  if (actionLabel) {
    const b = el('button', { className: 'toast-btn', textContent: actionLabel });
    b.onclick = () => { t.hidden = true; action(); };
    t.append(b);
  }
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}

async function shareSong(song) {
  const url = `${appUrl()}?song=${encodeURIComponent(song.id)}`;
  const title = data.title || "Craig's Songs";
  if (navigator.share) {
    try { await navigator.share({ title: song.title, text: `Listen to "${song.title}" on ${title}`, url }); } catch (_) { /* cancelled */ }
    return;
  }
  try { await navigator.clipboard.writeText(url); toast('Link copied. Paste it anywhere to share.'); }
  catch { toast(url, null, null, 12000); }
}

// Opened from a shared link (?song=id): show that song with a Play button.
function openSharedSong() {
  const params = new URLSearchParams(location.search);
  const id = params.get('song');
  if (!id) return;
  params.delete('song');
  const rest = params.toString();
  history.replaceState(null, '', location.pathname + (rest ? `?${rest}` : '') + location.hash);
  const song = data.songs.find((s) => s.id === id);
  if (!song) { toast("That song isn't in the app anymore."); return; }
  document.querySelector('.tab[data-view=songs]').click();
  view.filter = 'all'; search = ''; $('#search').value = ''; $('#search-clear').hidden = true;
  renderSongs();
  const row = document.querySelector(`#song-list .row[data-id="${CSS.escape(id)}"]`);
  if (row) {
    row.scrollIntoView({ block: 'center' });
    row.classList.add('flash');
    setTimeout(() => row.classList.remove('flash'), 2500);
  }
  toast(`Shared with you: ${song.title}`, '▶ Play', () => { const list = filtered(); playList(list, list.indexOf(song)); }, 15000);
}

// ---------- shuffle / repeat ----------
const MODES = 'songs-modes-v1';
let modes = { shuffle: false, repeat: 'off' }; // repeat: off | all | one
try { Object.assign(modes, JSON.parse(localStorage.getItem(MODES)) || {}); } catch {}
const saveModes = () => { try { localStorage.setItem(MODES, JSON.stringify(modes)); } catch {} };
let baseQueue = []; // the list in its original order (so shuffle can be turned off again)

function updateModeButtons() {
  const sp = typeof SP !== 'undefined' && SP.active() ? SP.modes() : null;
  const m = sp || modes;
  const sh = $('#shuffle-mode'), rp = $('#repeat-mode');
  sh.classList.toggle('on', !!m.shuffle);
  sh.setAttribute('aria-pressed', String(!!m.shuffle));
  sh.title = m.shuffle ? 'Shuffle: on' : 'Shuffle: off';
  rp.classList.toggle('on', m.repeat !== 'off');
  rp.classList.toggle('repeat-one', m.repeat === 'one');
  const label = { off: 'Repeat: off', all: 'Repeat: all', one: 'Repeat: this song' }[m.repeat];
  rp.title = label; rp.setAttribute('aria-label', label);
}

function toggleShuffle() {
  if (typeof SP !== 'undefined' && SP.active()) return SP.setShuffle(!SP.modes().shuffle);
  modes.shuffle = !modes.shuffle;
  saveModes();
  const current = queue[index];
  if (current && baseQueue.length) {
    if (modes.shuffle) {
      queue = [current, ...shuffle(baseQueue.filter((s) => s !== current))];
      index = 0;
    } else {
      queue = baseQueue.slice();
      index = Math.max(0, queue.indexOf(current));
    }
    markPlaying();
  }
  updateModeButtons();
  toast(modes.shuffle ? 'Shuffle on' : 'Shuffle off', null, null, 1500);
}

function cycleRepeat() {
  const order = ['off', 'all', 'one'];
  if (typeof SP !== 'undefined' && SP.active()) {
    const cur = SP.modes().repeat;
    return SP.setRepeat(order[(order.indexOf(cur) + 1) % 3]);
  }
  modes.repeat = order[(order.indexOf(modes.repeat) + 1) % 3];
  saveModes();
  updateModeButtons();
  toast({ off: 'Repeat off', all: 'Repeating the list', one: 'Repeating this song' }[modes.repeat], null, null, 1500);
}

// ---------- rendering ----------
function coverImg(song, cls = 'cover') {
  const img = el('img', { className: cls, alt: '', loading: 'lazy' });
  if (coverOf(song)) img.src = coverOf(song);
  return img;
}

// ---------- filters & sorting ----------
const PREF = 'songs-view-v1';
let view = { filter: 'all', sort: 'newest' };
try { Object.assign(view, JSON.parse(localStorage.getItem(PREF)) || {}); } catch {}
const saveView = () => { try { localStorage.setItem(PREF, JSON.stringify(view)); } catch {} };

const allTags = () => {
  const seen = new Map();
  data.songs.forEach((s) => (s.tags || []).forEach((t) => {
    const k = t.toLowerCase();
    if (!seen.has(k)) seen.set(k, t);
  }));
  return [...seen.values()].sort((a, b) => a.localeCompare(b));
};
const hasTag = (s, t) => (s.tags || []).some((x) => x.toLowerCase() === t.toLowerCase());

function filtered() {
  // songs.json order = order added, so "newest" is the reverse of the file.
  let list = playable().map((s, i) => ({ s, i }));
  if (view.filter !== 'all') list = list.filter(({ s }) => hasTag(s, view.filter));
  const q = search.trim().toLowerCase();
  if (q) {
    list = list.filter(({ s }) => [s.title, s.description, ...(s.tags || [])]
      .some((t) => String(t || '').toLowerCase().includes(q)));
  }
  if (view.sort === 'newest') list.sort((a, b) => b.i - a.i);
  if (view.sort === 'oldest') list.sort((a, b) => a.i - b.i);
  if (view.sort === 'title' || view.sort === 'category') list.sort((a, b) => a.s.title.localeCompare(b.s.title));
  return list.map(({ s }) => s);
}

function renderChips() {
  const box = $('#chips');
  box.replaceChildren();
  const tags = allTags();
  if (view.filter !== 'all' && !tags.some((t) => t.toLowerCase() === view.filter.toLowerCase())) view.filter = 'all';
  ['all', ...tags].forEach((t) => {
    const on = t.toLowerCase() === view.filter.toLowerCase();
    const b = el('button', { className: 'chip' + (on ? ' on' : ''), textContent: t === 'all' ? 'All songs' : t });
    b.setAttribute('aria-pressed', on);
    b.onclick = () => { view.filter = t; saveView(); renderSongs(); };
    box.append(b);
  });
  $('#sort').value = view.sort;
}
$('#sort').onchange = (e) => { view.sort = e.target.value; saveView(); renderSongs(); };

// ---------- song rows ----------
function songRow(song, list, src = null) {
  const tags = (song.tags || []).map((t) => el('span', { className: 'tag', textContent: t }));
  const text = el('div', { style: 'min-width:0;flex:1' },
    el('div', { className: 'title' }, isNew(song) ? el('span', { className: 'new-badge', textContent: 'NEW' }) : null, song.title),
    el('div', { className: 'now', hidden: true }));
  if (song.description) text.append(el('div', { className: 'desc', textContent: song.description }));
  if (tags.length) text.append(el('div', { className: 'meta', style: 'margin-top:4px' }, tags));
  else if (!song.description) text.append(el('div', { className: 'meta', textContent: 'Tap to play' }));

  const main = el('button', { className: 'main' }, coverImg(song), text);
  main.onclick = () => {
    // Tapping the song that's already loaded pauses/resumes instead of restarting it.
    if (queue[index]?.id === song.id && audio.src) { audio.paused ? audio.play() : audio.pause(); return; }
    playList(list, list.indexOf(song), src);
  };

  const yt = el('a', {
    className: 'yt' + (song.youtube ? '' : ' disabled'),
    textContent: '▶ Lyrics',
    href: song.youtube || '#',
    target: '_blank',
    rel: 'noopener',
    title: song.youtube ? 'Watch the lyric video' : 'No video yet',
  });
  if (song.youtube) yt.onclick = (e) => { if (openVideo(song.youtube, song.title)) e.preventDefault(); };
  const share = el('button', { className: 'share-btn', title: 'Share this song', innerHTML: SHARE_ICON });
  share.setAttribute('aria-label', `Share ${song.title}`);
  share.onclick = () => shareSong(song);
  const li = el('li', { className: 'row' }, main, el('div', { className: 'row-actions' }, yt, share));
  li.dataset.id = song.id;

  // "more" toggle for long descriptions
  if (song.description && song.description.length > 80) {
    const more = el('span', { className: 'more', textContent: 'More', role: 'button', tabIndex: 0 });
    more.onclick = (e) => {
      e.stopPropagation();
      li.classList.toggle('expanded');
      more.textContent = li.classList.contains('expanded') ? 'Less' : 'More';
    };
    text.insertBefore(more, text.children[3] || null);
  }
  return li;
}

function renderSongs() {
  renderChips();
  const box = $('#song-list');
  box.replaceChildren();
  const list = filtered();
  $('#count').textContent = `${list.length} song${list.length === 1 ? '' : 's'}`;
  if (!list.length) {
    box.append(el('p', { className: 'empty', textContent: search.trim() ? `No songs match "${search.trim()}".` : 'No songs here yet.' }));
    return;
  }

  if (view.sort === 'category') {
    const groups = view.filter === 'all' ? [...allTags(), null] : [view.filter];
    groups.forEach((g) => {
      const songs = list.filter((s) => (g ? hasTag(s, g) : !(s.tags || []).length));
      if (!songs.length) return;
      box.append(el('h3', { className: 'group-title', textContent: g || 'Uncategorized' }));
      const ul = el('ul', { className: 'list' });
      songs.forEach((s) => ul.append(songRow(s, songs)));
      box.append(ul);
    });
  } else {
    const ul = el('ul', { className: 'list' });
    list.forEach((s) => ul.append(songRow(s, list)));
    box.append(ul);
  }
  markPlaying();
}

function resolvePlaylist(p) {
  if (p.songs === 'all') return playable();
  const byId = Object.fromEntries(data.songs.map((s) => [s.id, s]));
  return (p.songs || []).map((id) => byId[id]).filter(Boolean);
}

let openPlaylist = null; // key of the playlist being viewed
const plKey = (p) => p.id || p.name;

function renderPlaylists() {
  const ul = $('#app-playlists');
  ul.replaceChildren();
  const lists = data.playlists || [];
  if (!lists.length) ul.append(el('li', { className: 'empty', textContent: 'No playlists yet.' }));
  lists.forEach((p) => {
    const songs = resolvePlaylist(p);
    const open = el('button', { className: 'main' },
      el('div', { className: 'cover' }),
      el('div', {},
        el('div', { className: 'title', textContent: p.name }),
        el('div', { className: 'meta', textContent: `${songs.length} song${songs.length === 1 ? '' : 's'}` })));
    open.onclick = () => showPlaylist(plKey(p));
    const play = el('button', { className: 'pill', textContent: '▶', title: 'Play' });
    play.onclick = () => {
      if (source === plKey(p)) { audio.paused ? audio.play() : audio.pause(); return; }
      playList(songs, 0, plKey(p));
    };
    play.classList.add('pl-play');
    const shuf = el('button', { className: 'pill', textContent: '⤮', title: 'Shuffle' });
    shuf.onclick = () => playList(shuffle(songs), 0, plKey(p));
    const li = el('li', { className: 'row' }, open, play, shuf);
    li.dataset.pl = plKey(p);
    li.dataset.count = songs.length;
    ul.append(li);
  });
  renderPlaylistDetail();

  const yt = $('#yt-playlists');
  yt.replaceChildren();
  const ytLists = (data.youtubePlaylists || []).filter((p) => p.url);
  if (!ytLists.length) yt.append(el('li', { className: 'empty', textContent: 'No YouTube playlists linked yet.' }));
  ytLists.forEach((p) => {
    const a = el('a', { className: 'row', href: p.url, target: '_blank', rel: 'noopener', style: 'text-decoration:none;color:inherit' },
      el('div', { className: 'cover', style: 'background:#c4302b' }),
      el('div', { className: 'title', textContent: p.name, style: 'flex:1' }),
      el('span', { className: 'yt', textContent: '▶ Watch' }));
    a.onclick = (e) => { if (openVideo(p.url, p.name)) e.preventDefault(); };
    yt.append(el('li', {}, a));
  });

  // Spotify playlists (added in the admin page) — tap to play inside the app.
  const sp = $('#sp-playlists');
  sp.replaceChildren();
  const spLists = (data.spotifyPlaylists || []).filter((p) => p.url);
  $('#sp-section').hidden = !spLists.length;
  spLists.forEach((p) => {
    const a = el('a', { className: 'row', href: p.url, target: '_blank', rel: 'noopener', style: 'text-decoration:none;color:inherit' },
      el('div', { className: 'cover sp-cover' }),
      el('div', { className: 'title', textContent: p.name, style: 'flex:1;min-width:0' }),
      el('span', { className: 'sp-btn', textContent: '▶ Play' }));
    a.onclick = (e) => {
      if (typeof SP !== 'undefined' && SP.connected() && SP.playUrl(p.url)) { e.preventDefault(); return; }
      if (openSpotify(p.url, p.name)) e.preventDefault();
    };
    const m = String(p.url).match(/(playlist|album|track|artist|show|episode)\/([A-Za-z0-9]+)/);
    if (m) a.dataset.spUri = `spotify:${m[1]}:${m[2]}`;
    sp.append(el('li', {}, a));
  });
}

function showPlaylist(key) {
  openPlaylist = key;
  renderPlaylistDetail();
  window.scrollTo(0, 0);
}

function renderPlaylistDetail() {
  const p = (data.playlists || []).find((x) => plKey(x) === openPlaylist);
  $('#playlist-index').hidden = !!p;
  $('#playlist-detail').hidden = !p;
  if (!p) { openPlaylist = null; return; }
  const songs = resolvePlaylist(p);
  $('#pl-name').textContent = p.name;
  $('#pl-count').textContent = `${songs.length} song${songs.length === 1 ? '' : 's'}`;
  $('#pl-play').onclick = () => playList(songs, 0, plKey(p));
  $('#pl-shuffle').onclick = () => playList(shuffle(songs), 0, plKey(p));
  const ul = $('#pl-songs');
  ul.replaceChildren();
  if (!songs.length) ul.append(el('li', { className: 'empty', textContent: 'This playlist is empty.' }));
  songs.forEach((s) => ul.append(songRow(s, songs, plKey(p))));
  markPlaying();
}
$('#pl-back').onclick = () => { openPlaylist = null; renderPlaylistDetail(); };

function markPlaying() {
  const spotifyOn = typeof SP !== 'undefined' && SP.active();
  const id = spotifyOn ? null : queue[index]?.id;
  const paused0 = audio.paused;
  document.querySelectorAll('.row[data-id]').forEach((r) => {
    const on = r.dataset.id === id;
    r.classList.toggle('playing', on);
    const now = r.querySelector('.now');
    if (!now) return;
    now.hidden = !on;
    if (on) now.replaceChildren(el('span', { className: 'eq' + (paused0 ? ' paused' : '') }, el('i'), el('i'), el('i')),
      paused0 ? 'Paused · tap to resume' : 'Now playing');
  });
  // Highlight the playlist that's playing, with "Now playing · 2 of 5".
  const paused = audio.paused;
  document.querySelectorAll('.row[data-pl]').forEach((r) => {
    const on = !spotifyOn && !!source && r.dataset.pl === source;
    r.classList.toggle('playing', on);
    const meta = r.querySelector('.meta');
    const n = Number(r.dataset.count);
    if (meta) {
      meta.replaceChildren();
      if (on) {
        meta.append(el('span', { className: 'eq' + (paused ? ' paused' : '') }, el('i'), el('i'), el('i')),
          `${paused ? 'Paused' : 'Now playing'} · ${index + 1} of ${queue.length}`);
      } else meta.textContent = `${n} song${n === 1 ? '' : 's'}`;
    }
    const btn = r.querySelector('.pl-play');
    if (btn) {
      const playing = on && !paused;
      btn.innerHTML = playing
        ? '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><rect x="6" y="5" width="4" height="14" rx="1" fill="currentColor"/><rect x="14" y="5" width="4" height="14" rx="1" fill="currentColor"/></svg>'
        : '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M8 5.5v13l11-6.5z" fill="currentColor"/></svg>';
      btn.title = playing ? 'Pause' : 'Play';
      btn.setAttribute('aria-label', btn.title);
    }
  });
  if (typeof SP !== 'undefined') SP.markSpotify();
  if (spotifyOn) return; // Spotify paints its own now-playing line
  const p = source && (data.playlists || []).find((x) => plKey(x) === source);
  $('#np-source').textContent = p ? `from ${p.name}` : '';
  $('#np-source').hidden = !p;
}

// ---------- YouTube player (in-app) ----------
// Turns any YouTube link (watch, youtu.be, shorts, embed, playlist) into an embed URL.
function youtubeEmbed(url) {
  let u;
  try { u = new URL(url); } catch { return null; }
  const host = u.hostname.replace(/^www\.|^m\.|^music\./, '');
  let id = null;
  const list = u.searchParams.get('list');
  if (host === 'youtu.be') id = u.pathname.slice(1).split('/')[0];
  else if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
    if (u.pathname === '/watch') id = u.searchParams.get('v');
    else {
      const m = u.pathname.match(/^\/(shorts|embed|live)\/([\w-]{6,})/);
      if (m && m[2] !== 'videoseries') id = m[2];
    }
  } else return null;
  const params = new URLSearchParams({ autoplay: '1', rel: '0', playsinline: '1' });
  if (id && /^[\w-]{6,}$/.test(id)) {
    if (list) params.set('list', list);
    const t = parseInt(u.searchParams.get('t') || u.searchParams.get('start') || '0', 10);
    if (t) params.set('start', String(t));
    return `https://www.youtube-nocookie.com/embed/${id}?${params}`;
  }
  if (list) { params.set('list', list); return `https://www.youtube-nocookie.com/embed/videoseries?${params}`; }
  return null;
}

// Spotify link -> embed URL. Handles open.spotify.com/(intl-xx/)<type>/<id> and spotify:<type>:<id>.
function spotifyEmbed(url) {
  const s = String(url || '').trim();
  let m = s.match(/^spotify:(playlist|album|track|artist|show|episode):([A-Za-z0-9]+)$/);
  if (!m) {
    let u;
    try { u = new URL(s); } catch { return null; }
    if (!/(^|\.)spotify\.com$/.test(u.hostname)) return null;
    m = u.pathname.match(/^\/(?:intl-[a-z-]+\/)?(?:embed\/)?(playlist|album|track|artist|show|episode)\/([A-Za-z0-9]+)/);
  }
  if (!m) return null;
  return { src: `https://open.spotify.com/embed/${m[1]}/${m[2]}?utm_source=generator&theme=0`, open: `https://open.spotify.com/${m[1]}/${m[2]}` };
}

function openSpotify(url, title) {
  const sp = spotifyEmbed(url);
  if (!sp) return false;
  if (!audio.paused) audio.pause();
  $('#video-title').textContent = title || '';
  $('#video-open').href = sp.open;
  $('#video-open').textContent = 'Open in Spotify ↗';
  const frame = el('iframe', {
    src: sp.src,
    title: title || 'Spotify playlist',
    allow: 'autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture',
  });
  $('#video-frame').classList.add('spotify');
  $('#video-frame').replaceChildren(frame);
  $('#video-modal').hidden = false;
  document.body.classList.add('modal-open');
  return true;
}

function openVideo(url, title) {
  const src = youtubeEmbed(url);
  if (!src) return false; // not a YouTube link we understand -> let the link open normally
  if (!audio.paused) audio.pause();
  $('#video-title').textContent = title || '';
  $('#video-open').href = url;
  $('#video-open').textContent = 'Open in YouTube ↗';
  $('#video-frame').classList.remove('spotify');
  const frame = el('iframe', {
    src,
    title: title || 'YouTube video',
    allow: 'autoplay; encrypted-media; picture-in-picture; fullscreen',
    allowFullscreen: true,
    referrerPolicy: 'strict-origin-when-cross-origin',
  });
  $('#video-frame').replaceChildren(frame);
  $('#video-modal').hidden = false;
  document.body.classList.add('modal-open');
  return true;
}
function closeVideo() {
  $('#video-frame').replaceChildren(); // removing the iframe stops the video
  $('#video-modal').hidden = true;
  document.body.classList.remove('modal-open');
}
$('#video-close').onclick = closeVideo;
$('#video-modal').addEventListener('click', (e) => { if (e.target.id === 'video-modal') closeVideo(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#video-modal').hidden) closeVideo(); });

// ---------- playback ----------
let source = null; // key of the playlist the queue came from (null = song list)
function playList(list, i, src = null) {
  if (!list.length) return;
  source = src;
  baseQueue = list.slice();
  if (modes.shuffle) {
    const first = list[i];
    queue = [first, ...shuffle(list.filter((_, k) => k !== i))];
    load(0);
    return;
  }
  queue = list;
  load(i);
}

function load(i) {
  if (typeof SP !== 'undefined') SP.yieldToLocal();
  index = (i + queue.length) % queue.length;
  const song = queue[index];
  audio.src = song.file;
  audio.play().catch(() => {});
  $('#player').hidden = false;
  $('#np-title').textContent = song.title;
  const c = $('#np-cover');
  if (coverOf(song)) c.src = coverOf(song); else c.removeAttribute('src');
  markPlaying();
  updateMediaSession(song);
}

function updateMediaSession(song) {
  if (!('mediaSession' in navigator)) return;
  const artwork = coverOf(song)
    ? [{ src: new URL(coverOf(song), location.href).href, sizes: '512x512' }]
    : [{ src: new URL('icons/icon-512.png', location.href).href, sizes: '512x512', type: 'image/png' }];
  navigator.mediaSession.metadata = new MediaMetadata({
    title: song.title, artist: 'Craig Willett', album: data.title || "Craig's Songs", artwork,
  });
}

if ('mediaSession' in navigator) {
  const ms = navigator.mediaSession;
  ms.setActionHandler('play', () => audio.play());
  ms.setActionHandler('pause', () => audio.pause());
  ms.setActionHandler('previoustrack', () => prev());
  ms.setActionHandler('nexttrack', () => next());
  try {
    ms.setActionHandler('seekto', (e) => { audio.currentTime = e.seekTime; });
  } catch (_) { /* not supported everywhere */ }
}

const next = () => queue.length && load(index + 1);
const prev = () => {
  if (!queue.length) return;
  if (audio.currentTime > 3) audio.currentTime = 0; else load(index - 1);
};

const spOn = () => typeof SP !== 'undefined' && SP.active();
$('#toggle').onclick = () => { if (spOn()) return SP.control('toggle'); audio.paused ? audio.play() : audio.pause(); };
$('#next').onclick = () => (spOn() ? SP.control('next') : next());
$('#prev').onclick = () => (spOn() ? SP.control('prev') : prev());
$('#shuffle-mode').onclick = toggleShuffle;
$('#repeat-mode').onclick = cycleRepeat;
updateModeButtons();
$('#search').addEventListener('input', (e) => {
  search = e.target.value;
  $('#search-clear').hidden = !search;
  renderSongs();
});
$('#search-clear').onclick = () => { search = ''; $('#search').value = ''; $('#search-clear').hidden = true; renderSongs(); $('#search').focus(); };
$('#play-all').onclick = () => playList(filtered(), 0);
$('#shuffle-all').onclick = () => playList(shuffle(filtered()), 0);

audio.addEventListener('play', () => { if (typeof SP !== 'undefined') SP.yieldToLocal(); $('#toggle').textContent = '⏸'; markPlaying(); });
audio.addEventListener('pause', () => { $('#toggle').textContent = '▶'; markPlaying(); });
audio.addEventListener('ended', () => {
  if (modes.repeat === 'one') { audio.currentTime = 0; audio.play().catch(() => {}); return; }
  if (index < queue.length - 1) next();
  else if (modes.repeat === 'all') load(0);
});
audio.addEventListener('timeupdate', () => {
  const d = audio.duration || 0;
  $('#np-time').textContent = `${fmt(audio.currentTime)} / ${fmt(d)}`;
  if (d && !seeking) $('#seek').value = (audio.currentTime / d) * 100;
});
audio.addEventListener('error', () => {
  $('#np-time').textContent = "Couldn't load this song";
});

let seeking = false;
const seek = $('#seek');
seek.addEventListener('input', () => { seeking = true; });
seek.addEventListener('change', () => {
  if (spOn()) SP.seekTo(seek.value / 100);
  else if (audio.duration) audio.currentTime = (seek.value / 100) * audio.duration;
  seeking = false;
});

// ---------- tabs ----------
document.querySelectorAll('.tab').forEach((t) => {
  t.onclick = () => {
    document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('active', x === t));
    document.querySelectorAll('.view').forEach((v) => { v.hidden = v.id !== `view-${t.dataset.view}`; });
    if (t.dataset.view === 'playlists') { openPlaylist = null; renderPlaylistDetail(); }
  };
});

// ---------- boot ----------
if (typeof APP_VERSION !== 'undefined') $('#app-version').textContent = 'v' + APP_VERSION;
async function boot() {
  try {
    const res = await fetch('songs.json', { cache: 'no-cache' });
    data = await res.json();
  } catch (e) {
    $('#song-list').replaceChildren(el('li', { className: 'empty', textContent: "Couldn't load the song list." }));
    return;
  }
  if (data.title) { document.title = data.title; $('#app-title').textContent = data.title; }
  renderSongs();
  renderPlaylists();
  openSharedSong();
  if (typeof SP !== 'undefined') SP.init(data);
}
boot();

// ---------- install prompt ----------
// Android/desktop Chrome & Edge: real "Install" button via beforeinstallprompt.
// iPhone/iPad: Apple doesn't allow an install popup, so show how to do it by hand.
const INSTALL_KEY = 'songs-install-dismissed';
const isInstalled = () =>
  window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
const dismissedRecently = () => {
  try { return Date.now() - Number(localStorage.getItem(INSTALL_KEY) || 0) < 7 * 864e5; } catch { return false; }
};
const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent) ||
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
let deferredInstall = null;

function showInstall(mode) {
  if (isInstalled() || dismissedRecently()) return;
  const banner = $('#install-banner');
  if (mode === 'ios') {
    $('#install-help').textContent = 'Tap the Share button, then "Add to Home Screen".';
    $('#install-btn').hidden = true;
  } else {
    $('#install-btn').hidden = false;
  }
  banner.hidden = false;
}
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredInstall = e;
  showInstall('prompt');
});
$('#install-btn').onclick = async () => {
  if (!deferredInstall) return;
  deferredInstall.prompt();
  await deferredInstall.userChoice.catch(() => {});
  deferredInstall = null;
  $('#install-banner').hidden = true;
};
$('#install-close').onclick = () => {
  $('#install-banner').hidden = true;
  try { localStorage.setItem(INSTALL_KEY, String(Date.now())); } catch {}
};
window.addEventListener('appinstalled', () => { $('#install-banner').hidden = true; });
if (isIOS) showInstall('ios');

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}
