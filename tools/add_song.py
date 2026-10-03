#!/usr/bin/env python3
"""Add a song to the app.

Usage:
  python tools/add_song.py "path/to/Song.mp3" --title "Song Title" [--youtube URL] [--cover path/to/art.jpg] [--tags Family Golf]

Copies the MP3 (and cover art) into the repo with a clean filename and adds the
entry to songs.json. If a song with the same id exists, it is updated instead.
"""
import argparse, json, re, shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

def slug(s):
    return re.sub(r'[^a-z0-9]+', '-', s.lower()).strip('-')

def main():
    p = argparse.ArgumentParser()
    p.add_argument('mp3', nargs='?', help='MP3 file to add (optional when only updating links)')
    p.add_argument('--title', required=True)
    p.add_argument('--youtube', default=None)
    p.add_argument('--cover', default=None)
    p.add_argument('--tags', nargs='*', default=None)
    a = p.parse_args()

    sid = slug(a.title)
    data = json.loads((ROOT / 'songs.json').read_text())
    song = next((s for s in data['songs'] if s['id'] == sid), None)
    if song is None:
        song = {'id': sid, 'title': a.title, 'file': f'music/{sid}.mp3', 'cover': '', 'youtube': '', 'tags': []}
        data['songs'].append(song)

    if a.mp3:
        shutil.copyfile(a.mp3, ROOT / 'music' / f'{sid}.mp3')
        song['file'] = f'music/{sid}.mp3'
    if a.cover:
        ext = Path(a.cover).suffix.lower() or '.jpg'
        shutil.copyfile(a.cover, ROOT / 'covers' / f'{sid}{ext}')
        song['cover'] = f'covers/{sid}{ext}'
    if a.youtube is not None:
        song['youtube'] = a.youtube
    if a.tags is not None:
        song['tags'] = a.tags

    (ROOT / 'songs.json').write_text(json.dumps(data, indent=2) + '\n')
    print(f"Saved '{a.title}' ({sid}). Now commit and push to publish.")

if __name__ == '__main__':
    main()
