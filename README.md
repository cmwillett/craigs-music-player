# Craig's Songs

A tiny web app (PWA) for listening to my songs. MP3s play right in the app (lock screen and car Bluetooth controls work), and each song links to its lyric video on YouTube.

Hosted free on GitHub Pages. No logins, no server.

## Add a song from your phone (admin page)

Open the app → Playlists tab → **Admin** at the bottom (or go to `admin.html`).

**One-time setup on each device you'll use:**
1. On GitHub: Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token.
   - Repository access: **Only select repositories** → this repo
   - Permissions: **Contents → Read and write**
   - Expiration: up to you (a year is fine; you'll redo setup when it expires)
2. On the admin page, enter the repo (`owner/name`), paste the token, and choose a PIN.

The token is saved only on that device, encrypted with your PIN. After that, just enter your PIN to add, edit or delete songs. Changes go live in about a minute.

## Add a song from a computer

1. Download the MP3 (and the MP4 for YouTube) from Suno. Both formats count as one download.
2. Run:

   ```
   python tools/add_song.py "Downloads/My Song.mp3" --title "My Song" --youtube "https://youtu.be/..." --tags Family
   ```

3. Commit and push. The site updates in a minute or two.

Or edit `songs.json` by hand and drop the MP3 into `music/`.

## songs.json

- `songs`: each has `title`, `file` (MP3 path), `youtube` (lyric video link), and optional `description`, `cover` image and `tags` (categories like Family, Friends — these become the filter buttons). Order in the file = order added (used for Newest/Oldest sort).
- `playlists`: in-app playlists. `"songs": "all"` or a list of song ids, e.g. `["good-dog-titus", "the-right-craig"]`.
- `youtubePlaylists`: links to unlisted YouTube playlists.

## Install on a phone

Open the site, then:
- **iPhone (Safari):** Share → Add to Home Screen
- **Android (Chrome):** ⋮ menu → Add to Home screen / Install app
