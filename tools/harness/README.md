# Test harness

Every real bug in this project was found by measuring, not by reading code:
the mix clipping, GC stalls freezing the fader, `requestAnimationFrame` adding
latency, full-track decoding blowing iOS memory, the decks never starting in
phase. Reach for these before theorising.

Works on macOS and Linux. Needs Chrome or Chromium; `browser_test.py` finds it.

```sh
# parse-check everything (uses node, falls back to macOS JavaScriptCore)
tools/harness/check.sh

# fader drag behaviour and per-move cost, against the real app
python3 tools/harness/browser_test.py . tools/harness/tests/fader.html

# does the mix clip? needs two audio files + files.json in the served dir
python3 tools/harness/make_test_audio.py /tmp/bmt 124 128
cp tools/harness/tests/audio_chain.html /tmp/bmt/
python3 -c "import json,os;json.dump(sorted(f for f in os.listdir('/tmp/bmt') if f.endswith('.wav')),open('/tmp/bmt/files.json','w'))"
python3 tools/harness/browser_test.py /tmp/bmt audio_chain.html
```

`make_test_audio.py` generates tracks with an exactly known BPM and a downbeat
at t=0, so no test depends on the owner's crate — that lives in iCloud on the
Mac and can't follow the project to a Linux box.

On-device numbers beat harness numbers. The app has a touch profiler in its
menu (Touch diagnostics) that reports what really happened during the last drag
on the real phone: touch Hz, fps, median and worst gap, stalls over 40 ms, and
our own handler cost. A desktop harness is not the input pipeline a phone uses.
