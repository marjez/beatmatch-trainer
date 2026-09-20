"""
make_test_audio.py — synthetic tracks with an exactly known BPM and downbeat.

The harness must not depend on the owner's crate: that lives in iCloud on the
Mac and can't follow the project to a Linux box. These files give every test a
known-good ground truth (kick on each beat, hat offbeat, downbeat at t=0).

Usage:
    python3 tools/harness/make_test_audio.py <out-dir> [bpm ...]
"""

import math
import os
import struct
import sys
import wave


def make(path, bpm, seconds=120, sr=44100):
    n = int(seconds * sr)
    buf = [0.0] * n
    step = 60.0 / bpm * sr
    i = 0
    while int(i * step) < n:
        start = int(i * step)
        for k in range(int(0.16 * sr)):                      # kick
            if start + k >= n:
                break
            t = k / sr
            buf[start + k] += 0.9 * math.sin(2 * math.pi * 55 * t) * math.exp(-t * 22)
        hat = int(start + step / 2)                          # offbeat hat
        for k in range(int(0.03 * sr)):
            if hat + k >= n:
                break
            t = k / sr
            buf[hat + k] += 0.18 * math.sin(2 * math.pi * 9000 * t) * math.exp(-t * 180)
        i += 1
    w = wave.open(path, "w")
    w.setnchannels(1); w.setsampwidth(2); w.setframerate(sr)
    w.writeframes(b"".join(
        struct.pack("<h", max(-32767, min(32767, int(v * 30000)))) for v in buf))
    w.close()
    return os.path.getsize(path)


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)
    out = sys.argv[1]
    os.makedirs(out, exist_ok=True)
    bpms = [float(x) for x in sys.argv[2:]] or [124.0, 128.0]
    for bpm in bpms:
        name = f"Test Track {bpm:g}bpm.wav"
        size = make(os.path.join(out, name), bpm)
        print(f"  {name}  {size/1e6:.1f} MB  (downbeat at t=0)")


if __name__ == "__main__":
    main()
