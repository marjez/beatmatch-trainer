# Test harness

Every real bug in this project was found by measuring, not by reading code:
the mix clipping, GC stalls freezing the fader, `requestAnimationFrame` adding
latency, full-track decoding blowing iOS memory, play bound to `click` so the
deck started a whole finger-tap late. Reach for these before theorising.

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

# offline reload + persistence, and screenshots (need Playwright: npm i playwright)
node tools/harness/pw_offline.mjs /tmp/bmt-crate
node tools/harness/pw_shot.mjs /tmp/bmt-crate /tmp/shots

# beat-grid analysis for tracks without a Rekordbox grid (writes bpm/anchor/kickIn per file)
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
