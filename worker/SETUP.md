# Playlist helper: one-time setup (about 15 minutes)

This small Cloudflare Worker lets people make playlists from the app. It keeps your GitHub key hidden and can **only** change playlists in `songs.json`. It has no database or storage of its own; every playlist is saved straight into `songs.json` on GitHub. It writes nothing to logs.

It doesn't touch your domain or your redirects. It gets its own free `workers.dev` address.

---

## 1. Make a GitHub key just for the helper

1. github.com → profile picture → **Settings** → **Developer settings** → **Personal access tokens** → **Fine-grained tokens** → **Generate new token**
2. **Token name:** `Song app playlists helper`
3. **Expiration:** the longest it offers. You'll make a new one when it expires.
4. **Repository access:** **Only select repositories** → `craigs-music-player`
5. **Permissions → Repository permissions → Contents:** **Read and write**
6. **Generate token** and copy it. It's shown only once.

Use a separate key from your admin-page key, so you can replace one without breaking the other.

## 2. Create the Worker

1. Sign in at dash.cloudflare.com. Get to Workers either way:
   - on the home page, click **Ship something new** in the **Workers** column, **or**
   - left menu: **Build → Compute → Workers & Pages**.

   Then **Create** (or **Create application**) → **Start with Hello World!** (a plain Worker; not a template or a repository import).
2. **Name:** `craigs-songs-playlists` → **Deploy**.
3. Click **Edit code**. Delete everything in the editor, paste in the whole contents of `worker/playlist-worker.js` from this repo, then click **Deploy**.

## 3. Add its settings

On the Worker's page → **Settings** → **Variables and Secrets** → **Add**, once for each:

| Type | Name | Value |
|---|---|---|
| **Secret** | `GITHUB_TOKEN` | the key from step 1 |
| Text | `REPO` | `cmwillett/craigs-music-player` |
| Text | `BRANCH` | `main` |
| Text | `ALLOWED_ORIGIN` | `https://cmwillett.github.io` |

Click **Deploy** (or **Save and deploy**) after adding them.

**Optional:** in **Settings → Observability**, make sure **Workers Logs** is **off**. The helper doesn't log anything, but this keeps Cloudflare from keeping request logs either.

## 4. Connect it to the app

1. Copy the Worker's address from its page, for example `https://craigs-songs-playlists.YOURNAME.workers.dev`.
2. Open the app's **Admin** page → **Playlists from the app** card → paste the address → **Test connection**, which should say **Connected!** → **Add to changes** → **Save all**.

About a minute later, a **+ New playlist** button appears on the Playlists tab for everyone.

---

## 5. Play counts (optional, about 5 minutes)

Adds a **Stats** section to the admin page: plays per song, plays per day, and how many different devices are listening.

**What's stored:** for each play, the song, the time, and a random device code. No names, emails or locations. **Cost:** none. On the free plan, going over a limit just pauses counting until the next day; Cloudflare never bills a free account for it.

1. In Cloudflare: **Storage & databases → D1 SQL database → Create database**. Name it `craigs-songs-stats` → **Create**. You don't need to add any tables; the helper creates its own.
2. Open your **craigs-songs-playlists** Worker → **Settings** → **Bindings** → **Add** → **D1 database**.
   - **Variable name:** `DB` (exactly that, in capitals)
   - **D1 database:** `craigs-songs-stats`
   - **Deploy** / **Save**.
3. Make sure the Worker has the latest code: **Edit code**, paste the whole current `worker/playlist-worker.js`, then **Deploy**.
4. Open the app's **Admin** page. The **Stats** section is at the top. The first time you open Admin on a device, that device is marked as you, so your own plays don't count. Open Admin once on each of your phones and computers, or tick **Don't count plays from this device** there.

A song counts as played after 30 seconds (or half of a short song). The same song on the same device within a minute counts once. Only the admin page, using your GitHub key, can read the stats.

### Managing playlists people make

- They show up in the admin page's **Playlists** list, with "by …" if the person gave a name.
- Check **Hide from the app** to hide one without deleting it, or **Delete** it.
- People can edit or delete only the playlists they made, on the device they made them on.

### Turning it off

Clear the address in the admin card (**Add to changes → Save all**), or delete the Worker in Cloudflare.
