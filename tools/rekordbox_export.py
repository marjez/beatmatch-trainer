"""
rekordbox_export.py — export a Rekordbox playlist as a practice crate.

Copies each track in the chosen playlist to an output folder, renaming it to
"Artist - Title 126bpm.mp3" so Beatmatch Trainer picks up the BPM instantly
(no detection needed, and Rekordbox's analysed BPM is more accurate anyway).

Setup (one-off, in Rekordbox on the laptop):
    File > Export Collection in xml format  ->  save as rekordbox.xml

Usage:
    python rekordbox_export.py rekordbox.xml "Practice Crate" ~/BeatmatchCrate

Options:
    --convert-lossless   transcode AIFF/WAV/FLAC to 256k AAC via afconvert
                         (macOS built-in). MP3/M4A are always copied untouched.
                         Cuts a crate of uncompressed files by roughly 5x so it
                         fits through iCloud onto a phone.
    --metadata-only      write crate.json only, copying no audio. Use this to
                         refresh the beat grid for a crate you already exported.

Always writes crate.json alongside the audio: Rekordbox's beat grid (the
downbeat anchor) and cue points per track, so the app can start playback on
beat 1 of a bar instead of dropping you into a beatless intro.

Then let OneDrive sync, and on the iPhone: Files app > long-press the folder
> Download Now, so the crate is available offline.
"""

import json
import subprocess
import sys
import shutil
import urllib.parse
import xml.etree.ElementTree as ET
from pathlib import Path

# Uncompressed formats are 5-10x the size of an AAC that sounds identical on
# headphones, and the crate has to fit through iCloud onto a phone. Lossy
# sources are never re-encoded — that would stack artefacts for no gain.
LOSSLESS = {".aiff", ".aif", ".wav", ".flac", ".alac"}


def convert_to_aac(src: Path, dest: Path, bitrate: int = 256000) -> bool:
    """Transcode via afconvert (built into macOS). Returns True on success."""
    try:
        subprocess.run(
            ["afconvert", "-f", "m4af", "-d", "aac", "-b", str(bitrate), str(src), str(dest)],
            check=True, capture_output=True,
        )
        return True
    except (subprocess.CalledProcessError, FileNotFoundError):
        return False


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
        # Rekordbox's own analysed beat grid. TEMPO/@Inizio is the position in
        # seconds of a beat and @Battito says which beat of the bar it is, so
        # Battito=1 marks a true downbeat. This is authoritative — far better
        # than anything we could detect in the browser.
        # Only 55% of tracks have their first grid marker on beat 1, so rather
        # than discard the rest, walk back from whatever beat it does land on:
        # Battito is which beat of the bar Inizio sits on.
        anchor = None
        tempos = t.findall("TEMPO")
        if tempos:
            first = tempos[0]
            try:
                inizio = float(first.get("Inizio"))
                grid_bpm = float(first.get("Bpm"))
                battito = int(first.get("Battito") or 1)
                beats_per_bar = int((first.get("Metro") or "4/4").split("/")[0])
                beat = 60.0 / grid_bpm
                anchor = inizio - (battito - 1) * beat
                while anchor < 0:
                    anchor += beats_per_bar * beat
                anchor = round(anchor, 4)
            except (TypeError, ValueError, ZeroDivisionError):
                anchor = None
        cues = []
        for mark in t.findall("POSITION_MARK"):
            try:
                cues.append(round(float(mark.get("Start")), 3))
            except (TypeError, ValueError):
                pass
        tracks[tid] = {
            "name": t.get("Name", "Unknown"),
            "artist": t.get("Artist", ""),
            "bpm": t.get("AverageBpm"),
            "path": Path(path),
            "anchor": anchor,
            "cues": sorted(set(cues)),
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
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    flags = {a for a in sys.argv[1:] if a.startswith("--")}
    convert = "--convert-lossless" in flags
    metadata_only = "--metadata-only" in flags

    if len(args) < 3:
        print(__doc__)
        if len(args) >= 1:
            print("Playlists found in this XML:")
            for p in list_playlists(Path(args[0])):
                print(f"  - {p}")
        sys.exit(1)

    xml_path = Path(args[0])
    playlist = args[1]
    out_dir = Path(args[2])
    out_dir.mkdir(parents=True, exist_ok=True)

    collection = load_collection(xml_path)
    ids = playlist_track_ids(xml_path, playlist)
    if not ids:
        print(f'Playlist "{playlist}" not found. Available playlists:')
        for p in list_playlists(xml_path):
            print(f"  - {p}")
        sys.exit(1)

    copied, missing, converted, bytes_saved = 0, 0, 0, 0
    manifest = []
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
                # Keep Rekordbox's decimals. Rounding to a whole number leaves the
                # crate up to 0.5 BPM out, and in two-track mode that error goes
                # straight into deck B's base rate — the app would call a mix
                # perfect while it audibly drifts.
                bpm = " " + f"{float(t['bpm']):.2f}".rstrip("0").rstrip(".") + "bpm"
            except ValueError:
                pass
        base = f"{t['artist']} - {t['name']}" if t["artist"] else t["name"]
        src = t["path"]
        # Build the extension by concatenation, NOT Path.with_suffix: a decimal
        # BPM ends the stem in ".02", which with_suffix would treat as the
        # extension and replace, silently rounding the BPM back to an integer.
        stem = f"{safe_filename(base)}{bpm}"

        def record(dest_path):
            manifest.append({
                "file": dest_path.name,
                "bpm": float(t["bpm"]) if t["bpm"] else None,
                "anchor": t["anchor"],
                "cues": t["cues"],
            })

        if convert and src.suffix.lower() in LOSSLESS:
            dest = out_dir / f"{stem}.m4a"
            if not metadata_only and convert_to_aac(src, dest):
                converted += 1
                saved = src.stat().st_size - dest.stat().st_size
                print(f"  ~ {dest.name}  ({src.stat().st_size/1e6:.0f} -> {dest.stat().st_size/1e6:.0f} MB)")
                bytes_saved += saved
                record(dest)
                continue
            if metadata_only:
                record(dest)
                continue
            print(f"  ! conversion failed, copying as-is: {src.name}")

        dest = out_dir / f"{stem}{src.suffix}"
        if not metadata_only:
            shutil.copy2(src, dest)
            copied += 1
            print(f"  + {dest.name}")
        record(dest)

    # Sidecar with Rekordbox's beat grid, so the app can start playback on a real
    # downbeat instead of guessing. Audio filenames alone can't carry this.
    manifest_path = out_dir / "crate.json"
    manifest_path.write_text(json.dumps(
        {"version": 1, "playlist": playlist, "tracks": manifest}, indent=1))
    gridded = sum(1 for m in manifest if m["anchor"] is not None)
    print(f"\n  = crate.json: {len(manifest)} tracks, {gridded} with a beat grid")

    if metadata_only:
        print(f"\nDone: metadata only, no audio copied. Crate folder: {out_dir}")
        return
    tail = f", {converted} converted (saved {bytes_saved/1e6:.0f} MB)" if converted else ""
    print(f"\nDone: {copied} copied{tail}, {missing} missing. Crate folder: {out_dir}")


if __name__ == "__main__":
    main()
