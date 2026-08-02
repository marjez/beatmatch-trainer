"""
rekordbox_export.py — export a Rekordbox playlist as a practice crate.

Copies each track in the chosen playlist to an output folder, renaming it to
"Artist - Title 126bpm.mp3" so Beatmatch Trainer picks up the BPM instantly
(no detection needed, and Rekordbox's analysed BPM is more accurate anyway).

Setup (one-off, in Rekordbox on the laptop):
    File > Export Collection in xml format  ->  save as rekordbox.xml

Usage:
    python rekordbox_export.py rekordbox.xml "Practice Crate" C:\\Users\\you\\OneDrive\\BeatmatchCrate

Then let OneDrive sync, and on the iPhone: Files app > long-press the folder
> Download Now, so the crate is available offline.
"""

import sys
import shutil
import urllib.parse
import xml.etree.ElementTree as ET
from pathlib import Path


def load_collection(xml_path: Path) -> dict:
    """Return {TrackID: {'name', 'artist', 'bpm', 'path'}} from a Rekordbox XML export."""
    tree = ET.parse(xml_path)
    root = tree.getroot()
    tracks = {}
    for t in root.iter("TRACK"):
        tid = t.get("TrackID")
        location = t.get("Location")
        if not tid or not location:
            continue  # playlist TRACK nodes only carry a Key attribute
        # Location is a file:// URL, percent-encoded
        path = urllib.parse.unquote(location)
        for prefix in ("file://localhost", "file://"):
            if path.startswith(prefix):
                path = path[len(prefix):]
                break
        # macOS paths need their leading slash (/Users/...); Windows ones
        # arrive as /C:/... and need it removed
        if len(path) > 2 and path[0] == "/" and path[2] == ":":
            path = path[1:]
        tracks[tid] = {
            "name": t.get("Name", "Unknown"),
            "artist": t.get("Artist", ""),
            "bpm": t.get("AverageBpm"),
            "path": Path(path),
        }
    return tracks


def playlist_track_ids(xml_path: Path, playlist_name: str) -> list:
    tree = ET.parse(xml_path)
    root = tree.getroot()
    for node in root.iter("NODE"):
        if node.get("Name") == playlist_name and node.get("Type") == "1":
            return [t.get("Key") for t in node.iter("TRACK") if t.get("Key")]
    return []


def list_playlists(xml_path: Path) -> list:
    tree = ET.parse(xml_path)
    return [n.get("Name") for n in tree.getroot().iter("NODE") if n.get("Type") == "1"]


def safe_filename(s: str) -> str:
    return "".join(c for c in s if c not in '<>:"/\\|?*').strip()


def main():
    if len(sys.argv) < 4:
        print(__doc__)
        if len(sys.argv) >= 2:
            print("Playlists found in this XML:")
            for p in list_playlists(Path(sys.argv[1])):
                print(f"  - {p}")
        sys.exit(1)

    xml_path = Path(sys.argv[1])
    playlist = sys.argv[2]
    out_dir = Path(sys.argv[3])
    out_dir.mkdir(parents=True, exist_ok=True)

    collection = load_collection(xml_path)
    ids = playlist_track_ids(xml_path, playlist)
    if not ids:
        print(f'Playlist "{playlist}" not found. Available playlists:')
        for p in list_playlists(xml_path):
            print(f"  - {p}")
        sys.exit(1)

    copied, missing = 0, 0
    for tid in ids:
        t = collection.get(tid)
        if not t or not t["path"].exists():
            missing += 1
            name = t["name"] if t else tid
            print(f"  ! file not found for: {name}")
            continue
        bpm = ""
        if t["bpm"]:
            try:
                bpm = f" {round(float(t['bpm']))}bpm"
            except ValueError:
                pass
        base = f"{t['artist']} - {t['name']}" if t["artist"] else t["name"]
        dest = out_dir / f"{safe_filename(base)}{bpm}{t['path'].suffix}"
        shutil.copy2(t["path"], dest)
        copied += 1
        print(f"  + {dest.name}")

    print(f"\nDone: {copied} copied, {missing} missing. Crate folder: {out_dir}")


if __name__ == "__main__":
    main()
