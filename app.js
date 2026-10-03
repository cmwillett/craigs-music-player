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
function songRow(song, list) {
  const tags = (song.tags || []).map((t) => el('span', { className: 'tag', textContent: t }));
  const text = el('div', { style: 'min-width:0;flex:1' },
    el('div', { className: 'title', textContent: song.title }));
  if (song.description) text.append(el('div', { className: 'desc', textContent: song.description }));
  if (tags.length) text.append(el('div', { className: 'meta', style: 'margin-top:4px' }, tags));
  else if (!song.description) text.append(el('div', { className: 'meta', textContent: 'Tap to play' }));

  const main = el('button', { className: 'main' }, coverImg(song), text);
  main.onclick = () => playList(list, list.indexOf(song));

  const yt = el('a', {
    className: 'yt' + (song.youtube ? '' : ' disabled'),
    textContent: '▶ Lyrics',
    href: song.youtube || '#',
    target: '_blank',
    rel: 'noopener',
    title: song.youtube ? 'Watch the lyric video on YouTube' : 'No video yet',
  });
  const li = el('li', { className: 'row' }, main, yt);
  li.dataset.id = song.id;

  // "more" toggle for long descriptions
  if (song.description && song.description.length > 80) {
    const more = el('span', { className: 'more', textContent: 'More', role: 'button', tabIndex: 0 });
    more.onclick = (e) => {
      e.stopPropagation();
      li.classList.toggle('expanded');
      more.textContent = li.classList.contains('expanded') ? 'Less' : 'More';
    };
    text.insertBefore(more, text.children[2] || null);
  }
  return li;
}

function renderSongs() {
  renderChips();
  const box = $('#song-list');
  box.replaceChildren();
  const list = filtered();
  $('#count').textContent = `${list.length} song${list.length === 1 ? '' : 's'}`;
  if (!list.length) { box.append(el('p', { className: 'empty', textContent: 'No songs here yet.' })); return; }

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
    play.onclick = () => playList(songs, 0);
    const shuf = el('button', { className: 'pill', textContent: '⤮', title: 'Shuffle' });
    shuf.onclick = () => playList(shuffle(songs), 0);
    ul.append(el('li', { className: 'row' }, open, play, shuf));
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
      el('span', { className: 'yt', textContent: 'Open ↗' }));
    yt.append(el('li', {}, a));
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
  $('#pl-play').onclick = () => playList(songs, 0);
  $('#pl-shuffle').onclick = () => playList(shuffle(songs), 0);
  const ul = $('#pl-songs');
  ul.replaceChildren();
  if (!songs.length) ul.append(el('li', { className: 'empty', textContent: 'This playlist is empty.' }));
  songs.forEach((s) => ul.append(songRow(s, songs)));
  markPlaying();
}
$('#pl-back').onclick = () => { openPlaylist = null; renderPlaylistDetail(); };

function markPlaying() {
  const id = queue[index]?.id;
  document.querySelectorAll('.row[data-id]').forEach((r) => r.classList.toggle('playing', r.dataset.id === id));
}

// ---------- playback ----------
function playList(list, i) {
  if (!list.length) return;
  queue = list;
  load(i);
}

function load(i) {
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

$('#toggle').onclick = () => (audio.paused ? audio.play() : audio.pause());
$('#next').onclick = next;
$('#prev').onclick = prev;
$('#play-all').onclick = () => playList(filtered(), 0);
$('#shuffle-all').onclick = () => playList(shuffle(filtered()), 0);

audio.addEventListener('play', () => { $('#toggle').textContent = '⏸'; });
audio.addEventListener('pause', () => { $('#toggle').textContent = '▶'; });
audio.addEventListener('ended', () => { if (index < queue.length - 1) next(); });
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
  if (audio.duration) audio.currentTime = (seek.value / 100) * audio.duration;
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
