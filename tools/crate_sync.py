"""
crate_sync.py — fold newly-dropped tracks into an existing Beatmatch crate.

Scans the crate folder for files that don't yet carry a BPM in the name, matches
them against the Rekordbox collection by artist+title, renames them with
Rekordbox's decimal BPM, and rebuilds crate.json for the whole folder.

Rekordbox is the authority: it already knows the exact BPM and the beat grid, so
nothing here guesses. Files it can't match are left untouched and listed — the
usual cause is an XML export older than the tracks.

Usage:
    python tools/crate_sync.py rekordbox.xml ~/path/to/BeatmatchCrate [options]

Options:
    --convert-lossless   AIFF/WAV/FLAC -> 256k AAC via afconvert (macOS built-in)
    --dry-run            print what would change, touch nothing
"""

import json
import re
import sys
import unicodedata
from pathlib import Path

from rekordbox_export import (LOSSLESS, convert_to_aac, load_collection,
                              safe_filename)

BPM_IN_NAME = re.compile(r"[0-9]{2,3}(\.[0-9]+)?\s*bpm", re.I)
AUDIO_EXT = {".mp3", ".m4a", ".aac", ".wav", ".aif", ".aiff", ".flac", ".ogg"}
STOPWORDS = {"original", "mix", "extended", "version", "the", "feat", "ft",
             "club", "radio", "edit", "remix", "dub"}


def tokens(s: str) -> set:
    """Loose word-set for matching a filename against a library entry."""
    s = unicodedata.normalize("NFKD", s).encode("ascii", "ignore").decode()
    s = re.sub(r"\.[a-z0-9]+$", "", s, flags=re.I)   # extension
    s = re.sub(r"-\d{6,}$", "", s)                   # store id suffix
    s = BPM_IN_NAME.sub("", s)
    s = re.sub(r"[^a-z0-9]+", " ", s.lower())
    return {w for w in s.split() if len(w) > 2 and w not in STOPWORDS}


# A filename can look very like a DIFFERENT mix of the same song: "Most Precious
# Love 1" scored exactly 0.50 against the Freemasons Club Mix, which would have
# stamped it with the wrong BPM and the wrong downbeat. Auto-accept needs a clear
# match; the grey zone is reported for a human to settle.
AUTO_MATCH = 0.62
UNCERTAIN = 0.45


def best_match(name: str, library: list, threshold: float = AUTO_MATCH):
    """Return (entry, score) for the closest library track, or (None, score)."""
    want = tokens(name)
    best, best_score = None, 0.0
    if not want:
        return None, 0.0
    for entry, have in library:
        if not have:
            continue
        score = len(want & have) / len(want | have)
        if score > best_score:
            best, best_score = entry, score
    return (best, best_score) if best_score >= threshold else (None, best_score)


def bpm_text(bpm) -> str:
    """126.02 -> '126.02', 128.00 -> '128'. Decimals matter; see CLAUDE.md."""
    return f"{float(bpm):.2f}".rstrip("0").rstrip(".")


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    flags = {a for a in sys.argv[1:] if a.startswith("--")}
    convert = "--convert-lossless" in flags
    dry = "--dry-run" in flags

    if len(args) < 2:
        print(__doc__)
        sys.exit(1)

    xml_path, crate = Path(args[0]), Path(args[1])
    if not crate.is_dir():
        print(f"Not a folder: {crate}")
        sys.exit(1)

    collection = load_collection(xml_path)
    library = [(t, tokens(f"{t['artist']} {t['name']}")) for t in collection.values()]
    print(f"{len(library)} tracks in {xml_path.name}\n")

    audio = sorted(p for p in crate.iterdir()
                   if p.suffix.lower() in AUDIO_EXT and not p.name.startswith("."))
    untagged = [p for p in audio if not BPM_IN_NAME.search(p.name)]
    print(f"{len(audio)} audio files in the crate, {len(untagged)} without a BPM\n")

    renamed, unmatched, dupes, uncertain = 0, [], [], []
    for path in untagged:
        entry, score = best_match(path.name, library)
        if not entry or not entry["bpm"]:
            if score >= UNCERTAIN:
                uncertain.append((path, score))
                print(f"  ? uncertain ({score:.2f}) — looks like a different mix: {path.name}")
            else:
                unmatched.append((path, score))
                print(f"  ? no library match ({score:.2f})  {path.name}")
            continue

        base = f"{entry['artist']} - {entry['name']}" if entry["artist"] else entry["name"]
        stem = f"{safe_filename(base)} {bpm_text(entry['bpm'])}bpm"

        # The crate may already hold this recording under its proper name. Never
        # rename onto an existing file — that would silently destroy it.
        existing = [c for c in (crate / f"{stem}{e}" for e in (".mp3", ".m4a", ".aiff", ".wav", ".flac"))
                    if c.exists() and c != path]
        if existing:
            dupes.append((path, existing[0]))
            print(f"  = duplicate, leaving alone: {path.name}")
            print(f"      already have: {existing[0].name}")
            continue

        if convert and path.suffix.lower() in LOSSLESS:
            dest = crate / f"{stem}.m4a"
            print(f"  ~ {path.name}\n      -> {dest.name}  ({path.stat().st_size/1e6:.0f} MB -> aac)")
            if not dry:
                if convert_to_aac(path, dest):
                    path.unlink()
                else:
                    print("    ! conversion failed, renaming as-is")
                    path.rename(crate / f"{stem}{path.suffix}")
        else:
            dest = crate / f"{stem}{path.suffix}"
            print(f"  + {path.name}\n      -> {dest.name}")
            if not dry:
                path.rename(dest)
        renamed += 1

    # Rebuild crate.json across everything now sitting in the folder.
    manifest, gridless = [], 0
    files = sorted(p for p in crate.iterdir()
                   if p.suffix.lower() in AUDIO_EXT and not p.name.startswith("."))
    if dry:
        print("\n(dry run: crate.json not written)")
        files = []
    for path in files:
        entry, _ = best_match(path.name, library)
        m = BPM_IN_NAME.search(path.name)
        bpm = float(re.sub(r"\s*bpm", "", m.group(0), flags=re.I)) if m else None
        if entry and entry["bpm"]:
            bpm = float(entry["bpm"])
        if entry is None:
            gridless += 1
        manifest.append({
            "file": path.name,
            "bpm": bpm,
            "anchor": entry["anchor"] if entry else None,
            "cues": entry["cues"] if entry else [],
        })

    if not dry:
        (crate / "crate.json").write_text(json.dumps(
            {"version": 1, "playlist": "crate_sync", "tracks": manifest}, indent=1))
        gridded = sum(1 for m in manifest if m["anchor"] is not None)
        print(f"\n  = crate.json: {len(manifest)} tracks, {gridded} with a beat grid")

    print(f"\nDone: {renamed} renamed, {len(dupes)} duplicates skipped, "
          f"{len(uncertain)} uncertain, {len(unmatched)} unmatched.")
    if dupes:
        print("\nDuplicates were left in place. Delete whichever copy you don't want;")
        print("two files of the same recording can be dealt against each other.")
    if uncertain:
        print("\nUncertain matches are probably a different mix of a track you own.")
        print("Add them to Rekordbox, re-export, and they'll match exactly.")
    if unmatched or uncertain:
        print("Unmatched files usually mean the XML predates them — re-export from")
        print("Rekordbox (File > Export Collection in xml format) and run this again.")


if __name__ == "__main__":
    main()
