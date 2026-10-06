// "How to use" guide: the ? button at the top. Sections only show for features that are set up.
// Loaded after app.js, so it can use $, el, data, toast.

const HELP = (() => {
  const SEEN = 'help-seen-v1';
  const ua = navigator.userAgent;
  const device = /iphone|ipad|ipod/i.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1) ? 'iphone'
    : /android/i.test(ua) ? 'android' : 'computer';
  const installed = () => window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

  const has = {
    spotify: () => !!(data.spotify && data.spotify.clientId),
    sharedSpotify: () => (data.spotifyPlaylists || []).some((p) => p.url),
    youtube: () => (data.youtubePlaylists || []).some((p) => p.url) || data.songs.some((s) => s.youtube),
    community: () => !!(data.community && data.community.api),
  };

  // Each section: id, title, html (string), optional show()
  const sections = () => [
    {
      id: 'install',
      title: '📲 Install the app',
      html: (() => {
        const steps = {
          iphone: `<li>Open this page in <b>Safari</b>.</li>
            <li>Tap the <b>Share</b> button (the square with an arrow, at the bottom or next to the address bar).</li>
            <li>Scroll down and tap <b>Add to Home Screen</b>, then <b>Add</b>.</li>`,
          android: `<li>Open this page in <b>Chrome</b>.</li>
            <li>Tap <b>Install</b> on the banner, or the <b>⋮</b> menu → <b>Install app</b> (or <b>Add to Home screen</b>).</li>`,
          computer: `<li>In <b>Chrome</b> or <b>Edge</b>, click the install icon at the right end of the address bar (a monitor with a down arrow).</li>
            <li>Or open the browser menu → <b>Install Craig's Songs</b>.</li>`,
        };
        const order = [device, ...['iphone', 'android', 'computer'].filter((d) => d !== device)];
        const name = { iphone: 'iPhone / iPad', android: 'Android', computer: 'Computer' };
        return (installed() ? '<p class="help-ok">✓ You\'re using the installed app.</p>' : '')
          + order.map((d, i) => `<h4>${name[d]}${i === 0 ? ' <span class="help-you">this device</span>' : ''}</h4><ol>${steps[d]}</ol>`).join('')
          + '<p>Once installed it opens full screen like a regular app, and music keeps playing when your phone is locked.</p>';
      })(),
    },
    {
      id: 'play',
      title: '▶️ Play music',
      html: `<ul>
        <li><b>Tap a song</b> to play it. Tap it again to pause or resume.</li>
        <li><b>▶ Play these</b> plays everything in the list you're looking at; <b>⤮ Shuffle</b> plays it in random order.</li>
        <li>The <b>player bar</b> at the bottom has back, play/pause and skip. Drag the line above it to jump around in a song.</li>
        <li><b>Shuffle</b> (crossed arrows, left of the controls) mixes up what's left to play.</li>
        <li><b>Repeat</b> (circle arrows, right of the controls) cycles: off → repeat the list → repeat this song (shows a small "1").</li>
        <li>Tap the <b>song name in the player bar</b> to see what's playing, with its description and lyric video.</li>
        <li>In the car: it plays over Bluetooth like any music app, with play, pause and skip on your lock screen and car display.</li>
      </ul>`,
    },
    {
      id: 'find',
      title: '🔎 Find songs',
      html: `<ul>
        <li><b>Search</b> box at the top of the Songs tab searches titles, descriptions and categories.</li>
        <li><b>Category buttons</b> (like Family or Friends) show just those songs. <b>All songs</b> shows everything.</li>
        <li><b>Sort</b>: Newest, Oldest, Title A–Z, or By category.</li>
        <li>A small <b>gold dot</b> before a title means it was added in the last two weeks.</li>
        <li>Tap <b>⋯</b> on a song to read its description and see more options.</li>
      </ul>`,
    },
    {
      id: 'lyrics',
      title: '🎬 Watch lyric videos',
      show: has.youtube,
      html: `<ul>
        <li>Tap <b>⋯</b> on a song → <b>Watch lyric video</b> to watch it right in the app. If music is playing, it pauses.</li>
        <li>Close it with <b>✕</b> or by tapping outside the video.</li>
        <li>If the button is grayed out, that song doesn't have a video yet.</li>
        <li>More lyric-video playlists are under <b>Playlists → YouTube</b>.</li>
      </ul>`,
    },
    {
      id: 'share',
      title: '📤 Share a song',
      html: `<ul>
        <li>Tap <b>⋯</b> on a song → <b>Share</b>.</li>
        <li>On a phone, pick Messages or any app; on a computer, the link is copied, so paste it anywhere.</li>
        <li>Whoever opens the link lands right on that song with a <b>▶ Play</b> button.</li>
      </ul>`,
    },
    {
      id: 'pl-songs',
      title: '➕ Make a playlist from the Songs tab',
      show: has.community,
      html: `<ol>
        <li>On <b>Songs</b>, tap <b>Select</b>.</li>
        <li>Tap the songs you want. They get a ✓ (tapping selects instead of playing while you're selecting).</li>
        <li>Tap <b>+ Add to playlist</b> at the top:
          <ul><li><b>New playlist</b>: name it and tap <b>Save playlist</b>.</li>
          <li>Or tap one of <b>your</b> playlists to add the songs to it.</li></ul></li>
        <li>Tap <b>✕</b> or <b>Cancel</b> to stop selecting.</li>
      </ol>
      <p>Tip: search or filter first (e.g. tap <b>Family</b>), then select.</p>`,
    },
    {
      id: 'pl-new',
      title: '📝 Make or change a playlist from the Playlists tab',
      show: has.community,
      html: `<ol>
        <li>Go to <b>Playlists</b> and tap <b>+ New playlist</b>.</li>
        <li>Give it a name, and your name if you want it to say "by you".</li>
        <li>Add songs with <b>+ Add a song…</b>; reorder with <b>↑ ↓</b>, remove with <b>✕</b>.</li>
        <li>Tap <b>Save playlist</b>. You'll see it right away; everyone else sees it in about a minute.</li>
      </ol>
      <p><b>To change one you made:</b> open it and tap <b>Edit</b> (rename, change songs, or <b>Delete</b>). You can only change playlists you made, on the device you made them on.</p>`,
    },
    {
      id: 'playlists',
      title: '🎶 Play a playlist',
      html: `<ul>
        <li>On <b>Playlists</b>, tap <b>▶</b> to play or <b>⤮</b> to shuffle, or tap the name to see its songs.</li>
        <li>The playlist that's playing is outlined with "Now playing · 2 of 5".</li>
        <li>The tabs at the top switch between <b>Playlists</b>${has.spotify() || has.sharedSpotify() ? ', <b>Spotify</b>' : ''}${(data.youtubePlaylists || []).some((p) => p.url) ? ' and <b>YouTube</b>' : ''}.</li>
      </ul>`,
    },
    {
      id: 'spotify',
      title: '🟢 Spotify',
      show: () => has.spotify() || has.sharedSpotify(),
      html: (has.spotify() ? `
        <h4>Full songs (Spotify Premium)</h4>
        <ol>
          <li>Ask Craig to add your Spotify email to the app (it allows up to 5 people).</li>
          <li><b>Playlists → Spotify → Connect Spotify</b>, sign in and approve. Do this once on each device.</li>
          <li>Your Spotify playlists appear. Tap one to play; it plays in the <b>Spotify app</b> with full songs, and this app's player bar controls it.</li>
        </ol>
        <ul>
          <li><b>Keep Spotify open in the background.</b> If it's closed you'll see <b>Open Spotify</b>; tap it, come back, and tap the playlist again.</li>
          <li><b>Play on</b> picks where the music goes (this phone, your computer, a speaker). Leave it on automatic normally.</li>
          <li><b>Choose playlists</b>: check the ones to show and drag <b>≡</b> to reorder, then tap <b>Done</b>.</li>
        </ul>` : '')
        + (has.sharedSpotify() ? `
        <h4>Shared Spotify playlists</h4>
        <p>These play in a Spotify player inside the app. Without Spotify Premium (or on many iPhones) Spotify only allows <b>30-second previews</b>${has.spotify() ? '; connecting Spotify above gets you full songs' : ''}.</p>` : ''),
    },
    {
      id: 'help',
      title: '🛠️ Something not working?',
      html: `<ul>
        <li><b>Don't see a new song or playlist?</b> Close the app completely and open it again. Changes take about a minute to show up.</li>
        <li><b>A song won't play?</b> Check your connection, then try another song. If one song never plays, let Craig know.</li>
        ${has.spotify() ? '<li><b>Spotify says "playing" but no sound?</b> Check <b>Play on</b>. It may be playing on another device. Make sure Spotify is open on this one.</li>' : ''}
        <li><b>Install banner went away?</b> Use the steps under <b>Install the app</b> above.</li>
      </ul>`,
    },
  ];

  function render(openId) {
    const box = $('#help-body');
    box.replaceChildren();
    sections().filter((s) => !s.show || s.show()).forEach((s) => {
      const d = el('details', { className: 'help-sec' });
      d.id = 'help-' + s.id;
      d.append(el('summary', { textContent: s.title }), el('div', { className: 'help-text', innerHTML: s.html }));
      if (s.id === openId) d.open = true;
      box.append(d);
    });
    $('#help-version').textContent = typeof APP_VERSION !== 'undefined' ? `Version ${APP_VERSION}` : '';
  }

  function open(sectionId) {
    render(sectionId || (installed() ? null : 'install'));
    $('#help-modal').hidden = false;
    document.body.classList.add('modal-open');
    try { localStorage.setItem(SEEN, '1'); } catch {}
    if (sectionId) setTimeout(() => $('#help-' + sectionId)?.scrollIntoView({ block: 'start' }), 50);
  }
  function close() {
    $('#help-modal').hidden = true;
    document.body.classList.remove('modal-open');
  }

  $('#help-btn').onclick = () => open();
  $('#help-close').onclick = close;
  $('#help-modal').addEventListener('click', (e) => { if (e.target.id === 'help-modal') close(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#help-modal').hidden) close(); });

  // One-time nudge for first-time visitors (after the song list loads).
  function nudge() {
    let seen = false;
    try { seen = !!localStorage.getItem(SEEN); } catch {}
    if (seen || new URLSearchParams(location.search).has('song')) return;
    try { localStorage.setItem(SEEN, '1'); } catch {}
    setTimeout(() => toast('New here? Tap ? at the top for a quick how-to.', 'Show me', () => open(), 9000), 1200);
  }

  return { open, nudge };
})();
