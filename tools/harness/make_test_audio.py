"""
make_test_audio.py — synthetic tracks with an exactly known BPM and downbeat.

The harness must not depend on the owner's crate: that lives in iCloud on the
Mac and can't follow the project to a Linux box. These files give every test a
known-good ground truth: kick on each beat, hat on the offbeat, and a downbeat
whose position is known to the sample.

Usage:
    python3 tools/harness/make_test_audio.py <out-dir> [bpm ...]
        one track per BPM, downbeat at t=0 (the original form; audio_chain.html)

    python3 tools/harness/make_test_audio.py <out-dir> --crate N [--seed S] [--seconds T]
        N tracks spread over the hip-hop (84–98) and house (120–136) clusters
        with decimal BPMs, a beatless intro of 0–12 s so the grid anchor is not
        trivially zero, a snare on 2 and 4 on some, and a crate.json in the
        exact shape tools/rekordbox_export.py writes. Also writes files.json
        (the list audio_chain.html reads) and truth.json, which the harness
        uses to check where every beat should land.
"""

import array
import json
import math
import os
import random
import sys
import wave

SR = 44100
DRONE_AMP = 0.04


def envelope_tone(freq, seconds, decay, amp, sr=SR, pitch_drop=0.0):
    n = int(seconds * sr)
    out = [0.0] * n
    for k in range(n):
        t = k / sr
        f = freq * (1.0 + pitch_drop * math.exp(-t * 60))   # kick pitch sweep
        out[k] = amp * math.sin(2 * math.pi * f * t) * math.exp(-t * decay)
    return out


def noise_burst(seconds, decay, amp, rng, sr=SR):
    n = int(seconds * sr)
    return [amp * (rng.random() * 2 - 1) * math.exp(-(k / sr) * decay) for k in range(n)]


def add(buf, at, sample):
    n = len(buf)
    end = min(n, at + len(sample))
    if at >= n:
        return
    for k in range(end - at):
        buf[at + k] += sample[k]


def render(bpm, seconds, intro, snare, hat_amp, rng, sr=SR):
    """One track. Returns (samples as floats, list of beat times in seconds)."""
    n = int(seconds * sr)
    buf = [0.0] * n
    kick = envelope_tone(55, 0.16, 22, 0.9, sr, pitch_drop=1.2)
    hat = envelope_tone(9000, 0.03, 180, hat_amp, sr)
    snr = noise_burst(0.12, 40, 0.5, rng, sr) if snare else None
    # Beatless intro: a soft pad, so the "start at 25% in" fallback is audibly
    # wrong and only the grid puts playback on a downbeat.
    if intro > 0:
        for k in range(int(intro * sr)):
            t = k / sr
            buf[k] += 0.12 * math.sin(2 * math.pi * 110 * t) * (0.5 + 0.5 * math.sin(2 * math.pi * 0.25 * t))
    # A quiet bass drone under everything: real music is never silent between
    # hits, and a continuous floor is what lets the harness measure how fast a
    # deck STOPS, not only how fast it starts.
    for k in range(n):
        buf[k] += DRONE_AMP * math.sin(2 * math.pi * 82.4 * k / sr)
    step = 60.0 / bpm
    beats = []
    i = 0
    while True:
        t = intro + i * step
        at = int(round(t * sr))
        if at >= n:
            break
        beats.append(t)
        add(buf, at, kick)
        add(buf, int(round((t + step / 2) * sr)), hat)
        if snr and i % 2 == 1:
            add(buf, at, snr)
        i += 1
    return buf, beats


def write_wav(path, buf, sr=SR):
    # Normalise so the file itself never clips: kick + snare + drone can sum past
    # full scale on beats 2 and 4, and a clipped source would make the chain's
    # clipping measurement meaningless.
    peak = max(abs(v) for v in buf) or 1.0
    scale = 30000 * min(1.0, 0.95 / peak)
    a = array.array("h", (max(-32767, min(32767, int(v * scale))) for v in buf))
    w = wave.open(path, "w")
    w.setnchannels(1); w.setsampwidth(2); w.setframerate(sr)
    w.writeframes(a.tobytes())
    w.close()
    return os.path.getsize(path)


def make(path, bpm, seconds=120, sr=SR):
    """Original form: downbeat at t=0, hat offbeat, no intro."""
    buf, _ = render(bpm, seconds, 0.0, False, 0.18, random.Random(0), sr)
    return write_wav(path, buf, sr)


def make_crate(out, n, seed, seconds):
    rng = random.Random(seed)
    manifest, truth, files = [], [], []
    for i in range(n):
        cluster = "house" if i % 3 else "hiphop"       # 2:1 house to hip-hop
        lo, hi = (120.0, 136.0) if cluster == "house" else (84.0, 98.0)
        bpm = round(rng.uniform(lo, hi), 2)
        intro = round(rng.choice([0.0, 0.0, 2.5, 4.0, 7.75, 12.0]) + rng.random() * 0.3, 3)
        snare = rng.random() < 0.5
        hat_amp = rng.choice([0.12, 0.18, 0.25])
        name = f"Synth {cluster.title()} {i + 1:02d} {bpm:g}bpm.wav"
        buf, beats = render(bpm, seconds, intro, snare, hat_amp, rng)
        size = write_wav(os.path.join(out, name), buf)
        # A loop, so tests/loop.html can run WITHOUT the downloaded demo crate —
        # until now the loop gate only existed against archive.org audio, which
        # means the whole-number-of-beats rule was unguarded on a clean checkout.
        # The beat runs from the anchor to the end here, so the loop is simply
        # the longest whole number of 4-bar phrases that fits.
        phrase = 16 * 60.0 / bpm
        phrases = max(8, int((seconds - intro - 1) / phrase))
        manifest.append({"file": name, "bpm": bpm, "anchor": intro, "cues": [],
                         "loopStart": round(intro, 3),
                         "loopEnd": round(intro + phrases * phrase, 3),
                         "loopS": round(phrases * phrase, 3)})
        truth.append({"file": name, "bpm": bpm, "anchor": intro, "seconds": seconds,
                      "snare": snare, "beats": len(beats)})
        files.append(name)
        print(f"  {name}  {size/1e6:.1f} MB  intro {intro:.3f}s  {'snare' if snare else 'kick+hat'}")
    with open(os.path.join(out, "crate.json"), "w") as f:
        json.dump({"version": 1, "playlist": "Synthetic", "tracks": manifest}, f, indent=1)
    with open(os.path.join(out, "files.json"), "w") as f:
        json.dump(files, f)
    with open(os.path.join(out, "truth.json"), "w") as f:
        json.dump(truth, f, indent=1)
    print(f"\n  = crate.json: {n} tracks, all gridded; files.json + truth.json alongside")


def main():
    args = sys.argv[1:]
    if not args:
        print(__doc__)
        sys.exit(1)
    out = args[0]
    os.makedirs(out, exist_ok=True)
    if "--crate" in args:
        n = int(args[args.index("--crate") + 1])
        seed = int(args[args.index("--seed") + 1]) if "--seed" in args else 1
        seconds = float(args[args.index("--seconds") + 1]) if "--seconds" in args else 120.0
        make_crate(out, n, seed, seconds)
        return
    bpms = [float(x) for x in args[1:]] or [124.0, 128.0]
    for bpm in bpms:
        name = f"Test Track {bpm:g}bpm.wav"
        size = make(os.path.join(out, name), bpm)
        print(f"  {name}  {size/1e6:.1f} MB  (downbeat at t=0)")


if __name__ == "__main__":
    main()
