# Test harness

Every real bug in this project was found by measuring, not by reading code:
the mix clipping, GC stalls freezing the fader, `requestAnimationFrame` adding
latency, full-track decoding blowing iOS memory, play bound to `click` so the
deck started a whole finger-tap late. Reach for these before theorising.

**The runner fails on failures.** `browser_test.py` exits 1 when a page posts
`fatal`, a non-empty `failures` list, or `jsErrors` — and also when a page
posts no `failures` list at all without setting `measurementOnly: true`. It
used to exit 0 whenever the page posted anything, so a test could report
`verdict: FAIL` and the run still looked green. Audited 2026-09-22: that is
how play-bound-to-click (90 ms late) and the first-kick-only start check both
shipped past a "passing" suite.

Works on macOS and Linux. Needs Chrome or Chromium; `browser_test.py` finds it
on PATH or in /Applications. On a Linux box without root, Playwright's Chromium
plus the missing .debs extracted under $HOME works — see "Linux without root".

```sh
# parse-check everything (uses node, falls back to macOS JavaScriptCore)
tools/harness/check.sh

# a synthetic crate: known BPMs, known downbeats, crate.json + truth.json
python3 tools/harness/make_test_audio.py /tmp/bmt-crate --crate 6 --seed 7

# fader drag behaviour and per-move cost, against the real app
python3 tools/harness/browser_test.py . tools/harness/tests/fader.html

# press-to-sound, downbeat alignment, stop/cue timing — the real app, real crate load path
python3 tools/harness/browser_test.py . tools/harness/tests/latency.html --mount=/crate=/tmp/bmt-crate

# whole rounds through the UI, fader riding, visual aids, stats, demo-crate loader
python3 tools/harness/browser_test.py . tools/harness/tests/rounds.html --mount=/crate=/tmp/bmt-crate
python3 tools/harness/browser_test.py . tools/harness/tests/ride.html   --mount=/crate=/tmp/bmt-crate
python3 tools/harness/browser_test.py . tools/harness/tests/aids.html   --mount=/crate=/tmp/bmt-crate
python3 tools/harness/browser_test.py . tools/harness/tests/stats.html
python3 tools/harness/browser_test.py . tools/harness/tests/demo.html   --mount=/crate=/tmp/bmt-crate --mount=/demo=<dir with a test crate.json>
# stale demo records on a phone are patched/pruned to the shipped crate.json; New pair rotates tracks
python3 tools/harness/browser_test.py . tools/harness/tests/demo_sync.html

# offline reload + persistence, and screenshots (need Playwright: npm i playwright)
node tools/harness/pw_offline.mjs /tmp/bmt-crate
node tools/harness/pw_shot.mjs /tmp/bmt-crate /tmp/shots

# verify candidate drop-in cues by PLAYING them (what ships in demo/crate.json)
python3 tools/harness/browser_test.py . tools/harness/verify_cues.html --mount=/crate=<dir + candidate crate.json> --timeout=1600

# beat-grid analysis for tracks without a Rekordbox grid (writes bpm/anchor/cues per file)
python3 tools/harness/browser_test.py . tools/harness/analyse_crate.html --mount=/crate=<dir of mp3s + files.json> --timeout=600

# does the mix clip? two tracks summed through the shipping chain
cp tools/harness/tests/audio_chain.html /tmp/bmt-crate/
python3 tools/harness/browser_test.py /tmp/bmt-crate audio_chain.html
```

`make_test_audio.py --crate` generates tracks with an exactly known BPM, a
beatless intro so the grid anchor is not trivially zero, and a quiet drone so
stop latency is measurable — no test depends on the owner's crate, which lives
in iCloud on the Mac and can't follow the project to a Linux box.

`tests/lib.js` boots the real app in an iframe, loads the crate through the
same file input a user uses, and taps the master bus with an AudioWorklet so
onsets are placed to the sample. The app exposes read-only handles for this on
`window.__bmt`.

On-device numbers beat harness numbers. The app has a touch profiler in its
menu (Touch diagnostics) that reports what really happened during the last drag
on the real phone: touch Hz, fps, median and worst gap, stalls over 40 ms, and
our own handler cost. A desktop harness is not the input pipeline a phone uses.

## Linux without root

Playwright's Chromium needs system libraries that `apt` can only install as
root. Without root: `npx playwright install chromium`, then `apt-get download`
the missing packages (libnss3, libnspr4, libatk*, libcups2, libxkbcommon0,
libasound2, libgbm1, libcairo2, libpango*, libX*, fonts-dejavu-core, and their
dependencies — `ldd chrome | grep "not found"` lists them), `dpkg -x` each into
`$HOME/tools/libs`, and launch through a wrapper that sets `LD_LIBRARY_PATH`
and a `FONTCONFIG_FILE` pointing at the extracted fonts. Without a working font
the renderer aborts with `SkFontMgr_FontConfigInterface: Not implemented` the
moment the page lays out text.

## What the tests actually assert

Every page posts a `failures` array; the runner fails on it. `fader.html`,
`latency.html` and `audio_chain.html` used to post a fixed prose verdict
whatever they measured — they now carry thresholds, and both historical bugs
fail them: Play on `pointerup` shows as 70 ms press-to-sound, and stubbing
`phraseStart` shows as a 230 ms gap between the scheduled start and the first
kick.

`startpoint.html` judges the drop-in point by kick-band energy ON the beats
against BETWEEN them, plus the phase of the first kick — counting onsets
called a kickless intro's hats a running beat, and five of sixteen real
tracks passed while starting in an intro. `verify_cues.html` applies the same
measurement to every candidate cue by playing it, and only verified cues ship
in `demo/crate.json`.
