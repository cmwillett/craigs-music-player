// Lyrics: big, readable words while the MP3 plays.
// Where the words come from (first match wins):
//   1. song.lyrics in songs.json (typed or pasted in the admin page)
//   2. the MP3 itself: Suno stores the lyrics in the file's ID3 tag (USLT frame).
//      We only download the tag at the start of the file, not the whole song.
// Loaded after app.js, so it can use $, el, audio, queue, index, playList, etc.

const LY = (() => {
  const SIZE_KEY = 'lyrics-size-v1';
  const FOLLOW_KEY = 'lyrics-follow-v1';
  const cache = new Map(); // song id -> lyrics text ('' = none)
  let current = null;      // song shown
  let size = (() => { try { return Number(localStorage.getItem(SIZE_KEY)) || 24; } catch { return 24; } })();
  let follow = (() => { try { return localStorage.getItem(FOLLOW_KEY) !== '0'; } catch { return true; } })();
  let userScrollUntil = 0;
  let userScrolling = false; // finger/mouse is moving the lyrics
  let shift = 0;             // px the listener moved us from our guess (kept for the rest of the song)
  let marks = [];            // [{el, at}] lyric lines with the fraction of the sung part where each starts
  let wakeLock = null;

  // ---------- read lyrics from the MP3's ID3 tag ----------
  async function fetchRange(url, start, end) {
    const res = await fetch(url, { headers: { Range: `bytes=${start}-${end}` } });
    if (!res.ok && res.status !== 206) throw new Error('fetch failed');
    if (res.status === 206) return new Uint8Array(await res.arrayBuffer());
    // Server ignored Range: read only what we need, then stop the download.
    const reader = res.body.getReader();
    const parts = []; let got = 0;
    while (got <= end) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value); got += value.length;
    }
    reader.cancel().catch(() => {});
    const out = new Uint8Array(Math.min(got, end + 1)); let o = 0;
    for (const p of parts) { const n = Math.min(p.length, out.length - o); out.set(p.subarray(0, n), o); o += n; if (o >= out.length) break; }
    return out;
  }
  const syncsafe = (b, i) => (b[i] << 21) | (b[i + 1] << 14) | (b[i + 2] << 7) | b[i + 3];
  const int32 = (b, i) => ((b[i] << 24) >>> 0) + (b[i + 1] << 16) + (b[i + 2] << 8) + b[i + 3];

  function decodeText(bytes, enc) {
    if (enc === 1 || enc === 2) {
      let le = enc === 1;
      let start = 0;
      if (enc === 1 && bytes[0] === 0xff && bytes[1] === 0xfe) { le = true; start = 2; }
      else if (enc === 1 && bytes[0] === 0xfe && bytes[1] === 0xff) { le = false; start = 2; }
      return new TextDecoder(le ? 'utf-16le' : 'utf-16be').decode(bytes.subarray(start));
    }
    return new TextDecoder(enc === 3 ? 'utf-8' : 'latin1').decode(bytes);
  }
  // Skip the "content descriptor" (a null-terminated string) inside a USLT frame.
  function afterTerminator(b, i, enc) {
    if (enc === 1 || enc === 2) { while (i + 1 < b.length && !(b[i] === 0 && b[i + 1] === 0)) i += 2; return i + 2; }
    while (i < b.length && b[i] !== 0) i++;
    return i + 1;
  }

  async function lyricsFromMp3(url) {
    const head = await fetchRange(url, 0, 9);
    if (head.length < 10 || head[0] !== 0x49 || head[1] !== 0x44 || head[2] !== 0x33) return ''; // no "ID3"
    const ver = head[3];
    const tagSize = syncsafe(head, 6);
    if (tagSize <= 0 || tagSize > 8 * 1024 * 1024) return '';
    const tag = await fetchRange(url, 0, 10 + tagSize - 1);
    let i = 10;
    if (head[5] & 0x40) i += ver === 4 ? syncsafe(tag, 10) : int32(tag, 10) + 4; // extended header
    while (i + 10 <= tag.length) {
      const id = String.fromCharCode(tag[i], tag[i + 1], tag[i + 2], tag[i + 3]);
      if (!/^[A-Z0-9]{4}$/.test(id)) break; // reached padding
      const size = ver === 4 ? syncsafe(tag, i + 4) : int32(tag, i + 4);
      const body = tag.subarray(i + 10, i + 10 + size);
      if (id === 'USLT' && body.length > 4) {
        const enc = body[0];
        const textStart = afterTerminator(body, 4, enc); // 1 byte encoding + 3 bytes language, then descriptor
        const text = decodeText(body.subarray(textStart), enc).replace(/\u0000+$/, '').trim();
        if (text) return text;
      }
      // Some tools store them as a custom text tag named "lyrics…" / "unsyncedlyrics" instead.
      if (id === 'TXXX' && body.length > 2) {
        const enc = body[0];
        const descEnd = afterTerminator(body, 1, enc);
        const desc = decodeText(body.subarray(1, descEnd), enc).replace(/\u0000/g, '').trim().toLowerCase();
        if (/^(unsynced)?lyrics/.test(desc)) {
          const text = decodeText(body.subarray(descEnd), enc).replace(/\u0000+$/, '').trim();
          if (text) return text;
        }
      }
      i += 10 + size;
    }
    return '';
  }

  async function getLyrics(song) {
    if (song.lyrics && song.lyrics.trim()) return song.lyrics.trim();
    if (cache.has(song.id)) return cache.get(song.id);
    let text = '';
    try { if (song.file) text = await lyricsFromMp3(song.file); } catch (_) { text = ''; }
    cache.set(song.id, text);
    return text;
  }

  // ---------- show them ----------
  const SECTION = /^(intro|verse|pre-?chorus|chorus|final chorus|post-?chorus|bridge|outro|hook|refrain|interlude|break|breakdown|spoken verse|rap|solo|instrumental|drop|end)\b/i;
  function render(text) {
    const box = $('#ly-text');
    box.replaceChildren();
    text.split(/\r?\n/).forEach((raw) => {
      const line = raw.trim();
      if (!line) { box.append(el('div', { className: 'ly-gap' })); return; }
      const m = line.match(/^\[(.+)\]$/);
      if (m) {
        const label = m[1].trim();
        if (SECTION.test(label)) box.append(el('div', { className: 'ly-section', textContent: label }));
        else box.append(el('div', { className: 'ly-cue', textContent: label })); // e.g. "Sound effect: thunder"
        return;
      }
      box.append(el('div', { className: 'ly-line', textContent: line }));
    });
    // Guess when each line is sung. Only real lyric lines take time (longer lines a bit more);
    // a section label adds a short pause for the music between sections.
    marks = [];
    let t = 0;
    [...box.children].forEach((n) => {
      if (n.classList.contains('ly-section')) t += 1.5;
      else if (n.classList.contains('ly-line')) { marks.push({ el: n, at: t }); t += 0.6 + n.textContent.length / 35; }
    });
    marks.forEach((m) => { m.at /= t || 1; });
    shift = 0;
  }
  function applySize() {
    $('#ly-text').style.fontSize = size + 'px';
    try { localStorage.setItem(SIZE_KEY, String(size)); } catch {}
  }
  function applyFollow() {
    $('#ly-follow').classList.toggle('on', follow);
    $('#ly-follow').setAttribute('aria-pressed', String(follow));
    try { localStorage.setItem(FOLLOW_KEY, follow ? '1' : '0'); } catch {}
  }

  async function keepAwake(on) {
    try {
      if (on && 'wakeLock' in navigator && !wakeLock) {
        wakeLock = await navigator.wakeLock.request('screen');
        wakeLock.addEventListener('release', () => { wakeLock = null; });
      } else if (!on && wakeLock) { await wakeLock.release(); wakeLock = null; }
    } catch (_) { /* not supported or not allowed */ }
  }
  // Keep the lyrics just above the player bar, whatever its height.
  const player = $('#player');
  const setPlayerH = () => document.documentElement.style.setProperty('--player-h', (player.hidden ? 0 : player.offsetHeight) + 'px');
  if ('ResizeObserver' in window) new ResizeObserver(setPlayerH).observe(player);
  new MutationObserver(setPlayerH).observe(player, { attributes: true, attributeFilter: ['hidden'] });
  document.addEventListener('visibilitychange', () => { if (!document.hidden && !$('#lyrics-view').hidden) keepAwake(true); });

  async function open(song, list = null, src = null) {
    current = song;
    $('#ly-title').textContent = song.title;
    $('#ly-text').replaceChildren(el('div', { className: 'ly-loading', textContent: 'Loading lyrics…' }));
    applySize(); applyFollow();
    $('#lyrics-view').hidden = false;
    document.body.classList.add('lyrics-open');
    $('#ly-scroll').scrollTop = 0;
    keepAwake(true);
    // Start the song if it isn't the one playing.
    const isCurrent = queue[index]?.id === song.id && !!audio.src && !(typeof SP !== 'undefined' && SP.active());
    if (!isCurrent) {
      const l = list && list.includes(song) ? list : (typeof filtered === 'function' && filtered().includes(song) ? filtered() : [song]);
      playList(l, l.indexOf(song), list ? src : null);
    } else if (audio.paused) audio.play().catch(() => {});
    const text = await getLyrics(song);
    if (current !== song) return;
    if (text) render(text);
    else $('#ly-text').replaceChildren(el('div', { className: 'ly-loading', textContent: "This song doesn't have lyrics yet." }));
  }
  function close() {
    $('#lyrics-view').hidden = true;
    document.body.classList.remove('lyrics-open');
    current = null;
    keepAwake(false);
  }

  // Follow along: keep the line being sung about a third of the way down the screen.
  // Suno doesn't give per-line timing, so this is a guess: singing starts after a short intro,
  // ends a little before the song does, and lines are spread by length.
  function target() {
    const sc = $('#ly-scroll');
    const d = audio.duration;
    if (!marks.length || !d) return null;
    const start = Math.min(18, Math.max(6, d * 0.07));
    const end = d - Math.min(25, Math.max(10, d * 0.1));
    const p = Math.min(1, Math.max(0, (audio.currentTime - start) / Math.max(1, end - start)));
    let i = 0;
    while (i + 1 < marks.length && marks[i + 1].at <= p) i++;
    const a = marks[i], b = marks[i + 1];
    const k = b ? Math.min(1, (p - a.at) / Math.max(1e-6, b.at - a.at)) : 0;
    const y = a.el.offsetTop + (b ? (b.el.offsetTop - a.el.offsetTop) * k : 0);
    return y - sc.clientHeight * 0.35;
  }
  function tick() {
    if (!current || $('#lyrics-view').hidden || !follow || userScrolling) return;
    if (queue[index]?.id !== current.id || !audio.duration) return;
    if (Date.now() < userScrollUntil) return;
    const sc = $('#ly-scroll');
    const t = target();
    if (t == null) return;
    const top = Math.max(0, Math.min(sc.scrollHeight - sc.clientHeight, t + shift));
    if (Math.abs(top - sc.scrollTop) > 2) sc.scrollTo({ top, behavior: 'smooth' });
  }
  audio.addEventListener('timeupdate', tick);
  // If the next song in the list starts while lyrics are open, switch to its lyrics.
  audio.addEventListener('play', () => {
    const s = queue[index];
    if (current && s && s.id !== current.id && !$('#lyrics-view').hidden) open(s, queue, null);
  });

  $('#ly-close').onclick = close;
  $('#ly-smaller').onclick = () => { size = Math.max(16, size - 3); applySize(); };
  $('#ly-bigger').onclick = () => { size = Math.min(44, size + 3); applySize(); };
  $('#ly-follow').onclick = () => { follow = !follow; applyFollow(); if (follow) { userScrollUntil = 0; tick(); } };
  // When the listener scrolls, follow along from wherever they leave it (we were ahead or behind).
  let settleTimer = null;
  const settle = () => {
    clearTimeout(settleTimer);
    settleTimer = setTimeout(() => {
      userScrolling = false;
      const t = target();
      if (t != null) shift = $('#ly-scroll').scrollTop - t;
      userScrollUntil = Date.now() + 1500;
    }, 1200);
  };
  const grab = () => { userScrolling = true; settle(); };
  ['touchstart', 'wheel', 'mousedown'].forEach((ev) => $('#ly-scroll').addEventListener(ev, grab, { passive: true }));
  $('#ly-scroll').addEventListener('scroll', () => { if (userScrolling) settle(); }, { passive: true });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#lyrics-view').hidden) close(); });

  return { open, close, getLyrics, isOpen: () => !$('#lyrics-view').hidden };
})();
