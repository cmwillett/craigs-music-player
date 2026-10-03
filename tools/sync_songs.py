#!/usr/bin/env python3
"""Keep songs.json in step with the music/ folder.

- Adds any MP3 in music/ that isn't listed yet.
- Removes entries whose MP3 is no longer in music/ (deleted or renamed).

Runs automatically on GitHub (see .github/workflows/sync-songs.yml) whenever
you push new files to music/. You can also run it by hand: python tools/sync_songs.py

The title comes from the filename: "good-dog-titus.mp3" -> "Good Dog Titus".
Fix titles, descriptions, categories and YouTube links later in the admin page.
"""
import json
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SMALL = {'a', 'an', 'and', 'the', 'of', 'in', 'on', 'to', 'for', 'at', 'by', 'or', 'n'}


def title_from(stem):
    words = stem.replace('_', '-').split('-')
    words = [w for w in words if w]
    out = []
    for i, w in enumerate(words):
        out.append(w if (i and w.lower() in SMALL) else w[:1].upper() + w[1:])
    return ' '.join(out)


def main():
    path = ROOT / 'songs.json'
    data = json.loads(path.read_text(encoding='utf-8'))
    songs = data.setdefault('songs', [])
    on_disk = {f'music/{p.name}'.lower() for p in (ROOT / 'music').glob('*.mp3')}
    removed = [s for s in songs if s.get('file', '').lower() not in on_disk]
    songs[:] = [s for s in songs if s not in removed]
    playlists = data.get('playlists', [])
    gone = {s.get('id') for s in removed}
    for pl in playlists:
        if isinstance(pl.get('songs'), list):
            pl['songs'] = [i for i in pl['songs'] if i not in gone]

    known_files = {s.get('file', '').lower() for s in songs}
    known_ids = {s.get('id') for s in songs}

    added = []
    mp3s = sorted((ROOT / 'music').glob('*.mp3'), key=lambda p: p.stat().st_mtime)
    for mp3 in mp3s:
        rel = f'music/{mp3.name}'
        if rel.lower() in known_files:
            continue
        sid = mp3.stem.lower()
        while sid in known_ids:
            sid += '-2'
        songs.append({'id': sid, 'title': title_from(mp3.stem), 'file': rel,
                      'cover': '', 'youtube': '', 'tags': [], 'added': date.today().isoformat()})
        known_ids.add(sid)
        added.append(rel)

    if added or removed:
        path.write_text(json.dumps(data, indent=2, ensure_ascii=False) + '\n', encoding='utf-8')
        if added:
            print('Added:\n  ' + '\n  '.join(added))
        if removed:
            print('Removed (MP3 not found):\n  ' + '\n  '.join(s.get('title', '?') for s in removed))
    else:
        print('songs.json already lists every MP3.')


if __name__ == '__main__':
    main()
