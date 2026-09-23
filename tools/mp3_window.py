"""
mp3_window.py — cut an MP3 to a time window on exact frame boundaries.

The app only ever plays a 180 s window from the drop-in point, so shipping a
nine-minute file costs the phone storage and the user a download for audio
that is never heard. This finds the byte offsets of real MP3 frames, so the
cut needs no re-encoding and no decoder: the slice is a valid MP3 whose first
byte is the start of a frame.

Frames are parsed properly (MPEG 1/2/2.5, all layers, CBR and VBR), because a
size/duration estimate drifts on VBR and lands mid-frame.

    python3 tools/mp3_window.py in.mp3 out.mp3 --start 41.0 --length 220
    python3 tools/mp3_window.py in.mp3 --probe          # duration + frame count

The byte offsets it reports are what demo/crate.json carries as
byteStart/byteEnd, so the app can fetch exactly that window with a Range
request instead of the whole file.
"""

import argparse
import sys

BITRATES = {
    # (version_bits, layer_bits): [bitrate table in kbps]
    (3, 3): [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],   # MPEG1 L1
    (3, 2): [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],      # MPEG1 L2
    (3, 1): [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],       # MPEG1 L3
    (2, 3): [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],      # MPEG2/2.5 L1
    (2, 2): [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],           # MPEG2/2.5 L2
    (2, 1): [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],           # MPEG2/2.5 L3
}
SAMPLE_RATES = {3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000]}
SAMPLES_PER_FRAME = {(3, 3): 384, (3, 2): 1152, (3, 1): 1152, (2, 3): 384, (2, 2): 1152, (2, 1): 576}


def skip_id3(data):
    """Byte offset of the audio, past an ID3v2 tag if there is one."""
    if data[:3] == b"ID3" and len(data) > 10:
        size = 0
        for b in data[6:10]:
            size = (size << 7) | (b & 0x7F)      # syncsafe integer
        return 10 + size
    return 0


def parse_frame(data, i):
    """(frame_length, duration_seconds) for the frame at i, or None."""
    if i + 4 > len(data) or data[i] != 0xFF or (data[i + 1] & 0xE0) != 0xE0:
        return None
    ver_bits = (data[i + 1] >> 3) & 0x03         # 3 = MPEG1, 2 = MPEG2, 0 = MPEG2.5
    layer_bits = (data[i + 1] >> 1) & 0x03       # 1 = LayerIII
    if ver_bits == 1 or layer_bits == 0:
        return None
    bitrate_idx = (data[i + 2] >> 4) & 0x0F
    rate_idx = (data[i + 2] >> 2) & 0x03
    if bitrate_idx in (0, 15) or rate_idx == 3:
        return None
    key = (3 if ver_bits == 3 else 2, layer_bits)
    bitrate = BITRATES[key][bitrate_idx] * 1000
    rate = SAMPLE_RATES[ver_bits][rate_idx]
    padding = (data[i + 2] >> 1) & 0x01
    samples = SAMPLES_PER_FRAME[key]
    if layer_bits == 3:                           # Layer I counts padding in slots of 4
        length = (12 * bitrate // rate + padding) * 4
    else:
        length = 144 * bitrate // rate + padding
        if key[0] == 2 and layer_bits == 1:       # MPEG2/2.5 Layer III: half a frame
            length = 72 * bitrate // rate + padding
    if length < 24:
        return None
    return length, samples / rate


def frame_index(data):
    """[(byte_offset, start_time)] for every frame, plus the total duration."""
    i = skip_id3(data)
    frames, t = [], 0.0
    while i < len(data) - 4:
        f = parse_frame(data, i)
        if f is None:
            i += 1                                # resync: junk or a stray tag
            continue
        frames.append((i, t))
        t += f[1]
        i += f[0]
    return frames, t


def window(data, start_s, length_s):
    frames, dur = frame_index(data)
    if not frames:
        raise SystemExit("no MP3 frames found")
    a = next((off for off, t in frames if t >= start_s), frames[0][0])
    end_t = start_s + length_s
    b = next((off for off, t in frames if t >= end_t), len(data))
    # The exact start time of the chosen frame: the caller needs it to rebase
    # a beat grid onto the cut file.
    a_time = next(t for off, t in frames if off == a)
    return data[a:b], a, b, a_time, dur


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("src")
    ap.add_argument("dst", nargs="?")
    ap.add_argument("--start", type=float, default=0.0)
    ap.add_argument("--length", type=float, default=220.0)
    ap.add_argument("--probe", action="store_true")
    args = ap.parse_args()

    data = open(args.src, "rb").read()
    if args.probe:
        frames, dur = frame_index(data)
        print(f"{args.src}: {len(frames)} frames, {dur:.3f}s, {len(data)/1e6:.1f}MB")
        return
    if not args.dst:
        ap.error("need an output path (or --probe)")
    cut, a, b, a_time, dur = window(data, args.start, args.length)
    open(args.dst, "wb").write(cut)
    print(f"{args.dst}: bytes {a}-{b} ({len(cut)/1e6:.1f}MB of {len(data)/1e6:.1f}MB), "
          f"starts at {a_time:.3f}s of {dur:.1f}s")


if __name__ == "__main__":
    main()
