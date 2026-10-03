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

function songRow(song, list) {
  const tags = (song.tags || []).map((t) => el('span', { className: 'tag', textContent: t }));
  const main = el('button', { className: 'main' },
    coverImg(song),
    el('div', { style: 'min-width:0' },
      el('div', { className: 'title', textContent: song.title }),
      el('div', { className: 'meta' }, tags.length ? tags : 'Tap to play'))
  );
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
  return li;
}

function renderSongs() {
  const ul = $('#song-list');
  ul.replaceChildren();
  const list = playable();
  if (!list.length) ul.append(el('li', { className: 'empty', textContent: 'No songs yet.' }));
  list.forEach((s) => ul.append(songRow(s, list)));
}

function resolvePlaylist(p) {
  if (p.songs === 'all') return playable();
  const byId = Object.fromEntries(data.songs.map((s) => [s.id, s]));
  return (p.songs || []).map((id) => byId[id]).filter(Boolean);
}

function renderPlaylists() {
  const ul = $('#app-playlists');
  ul.replaceChildren();
  (data.playlists || []).forEach((p) => {
    const songs = resolvePlaylist(p);
    const play = el('button', { className: 'main' },
      el('div', { className: 'cover' }),
      el('div', {},
        el('div', { className: 'title', textContent: p.name }),
        el('div', { className: 'meta', textContent: `${songs.length} song${songs.length === 1 ? '' : 's'}` })));
    play.onclick = () => playList(songs, 0);
    const shuf = el('button', { className: 'pill', textContent: '⤮' , title: 'Shuffle' });
    shuf.onclick = () => playList(shuffle(songs), 0);
    ul.append(el('li', { className: 'row' }, play, shuf));
  });

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
$('#play-all').onclick = () => playList(playable(), 0);
$('#shuffle-all').onclick = () => playList(shuffle(playable()), 0);

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
  };
});

// ---------- boot ----------
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

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}
