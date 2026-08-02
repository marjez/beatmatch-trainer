"""
crate_bpm_stats.py — print the BPM spread of a Rekordbox playlist.

Reads only AverageBpm values. No filenames, paths or artists are printed, so the
output is safe to share. Used to confirm the in-app detection range (88-175)
covers the crate: it must stay under one octave or tempos fold half/double.

Usage:
    python tools/crate_bpm_stats.py rekordbox.xml "Practice Crate"
"""

import sys
import xml.etree.ElementTree as ET
from collections import Counter
from pathlib import Path

from rekordbox_export import load_collection, playlist_track_ids, list_playlists


def main():
    if len(sys.argv) < 3:
        print(__doc__)
        if len(sys.argv) >= 2:
            print("Playlists in this XML:")
            for p in list_playlists(Path(sys.argv[1])):
                print(f"  - {p}")
        sys.exit(1)

    xml_path, playlist = Path(sys.argv[1]), sys.argv[2]
    collection = load_collection(xml_path)
    ids = playlist_track_ids(xml_path, playlist)
    if not ids:
        print(f'Playlist "{playlist}" not found.')
        sys.exit(1)

    bpms = []
    untagged = 0
    for tid in ids:
        t = collection.get(tid)
        try:
            bpms.append(float(t["bpm"]))
        except (TypeError, ValueError, KeyError):
            untagged += 1

    if not bpms:
        print("No BPMs in this playlist.")
        sys.exit(1)

    bpms.sort()
    print(f"{len(bpms)} tracks with BPM ({untagged} without)")
    print(f"min {bpms[0]:.2f}   median {bpms[len(bpms)//2]:.2f}   max {bpms[-1]:.2f}")
    decimals = sum(1 for b in bpms if abs(b - round(b)) > 0.004)
    print(f"{decimals} of {len(bpms)} have a meaningful fraction")
    print("\nhistogram (5 BPM buckets):")
    hist = Counter(int(b // 5) * 5 for b in bpms)
    for bucket in sorted(hist):
        print(f"  {bucket:3d}-{bucket + 4:3d}  {'#' * hist[bucket]} {hist[bucket]}")
    lo, hi = 88, 175
    out = [b for b in bpms if b < lo or b > hi]
    print(f"\ndetection range {lo}-{hi}: "
          + (f"{len(out)} track(s) outside — would fold half/double" if out else "covers everything"))


if __name__ == "__main__":
    main()
