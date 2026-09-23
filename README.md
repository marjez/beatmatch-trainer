# Beatmatch Trainer

Practice beatmatching by ear with your own music. Unlimited rounds, no account,
no ads, no daily limit, fully offline once installed. A personal replacement for
Beatmatch PRO built around your own crate.

## How it works

- Both decks are live, with a hidden random tempo offset on deck 2. Match them by
  ear using the ±8% pitch faders (SL-1210 range) and hold-to-nudge buttons.
- Decks are started one at a time with **Play** and **Cue**, as on CDJs or 1210s:
  press to sound is 0.11 ms in the harness, and playback begins on a downbeat, so
  you drop the second deck on the first one's beat by ear. **Drop both** — which
  starts them phase-locked on one audio-clock tick — is a fallback in the settings
  sheet.
- **Beat focus** low-passes the mix to 220 Hz, leaving just the kick and low end,
  the way you'd use the EQ kills on a mixer to check a match.
- **Reveal score** shows how many BPM you were out, plus a strobe-dot row that drifts
  at your error rate — frozen dots means you locked it.
- Every round pairs two different tracks, and only ever pairs tracks close enough
  in tempo to be mixable within the fader's range — so a mixed house/hip-hop
  crate never deals you a pair you couldn't play on the decks.
- Playback starts on **beat 1 of a bar**, a whole number of 4-bar phrases into the
  track, using Rekordbox's own beat grid from `crate.json` — no waiting through
  beatless intros. Cue returns the deck to that point.
- **Fine-drag**: slide sideways while dragging a pitch fader and it gets
  progressively finer — nothing for the first 36 px (a thumb moving "straight"
  down wanders that much on its own), then ~4× finer at 120 px out, enough to
  place it inside 0.01 BPM.
- **Visual aids** (off by default) adds level meters and scrolling waveforms with
  the beat grid. No BPM is shown while you play.
- **Progress** in the sheet charts every round you have revealed, with the rolling
  median; rounds played with visual aids are kept out of the trend.
- **±8%** under the fader is the SL-1210 range. Tap it for **±16%** when a pair
  needs more room; the hidden offset is unchanged, so it adds travel, not slack.
- **Crossfader** under the decks blends them with an equal-power curve; centre
  is both at −3 dB, which is where you beatmatch. The channel faders it replaced
  were two more things to look after that a 1210 setup doesn't ask of you.
- **Split L / R** pans deck A hard left and deck B hard right, so you can practise
  with one ear on the monitor the way you would cue on the mixer. Off by default;
  the choice persists between sessions.
- Your crate and round history are stored on-device (IndexedDB) and persist between sessions.

## Demo crate

No music of your own to hand? **Crate & settings → Load the demo crate** fetches
eighteen Creative Commons house, tech-house and techno tracks (115–140 BPM) from
netlabels on the Internet Archive — about 140 MB, downloaded once and stored on
the device like any other track. Only the window the player can use is fetched:
a Range request for ~220 s around the drop-in point, cut on real MP3 frame
boundaries by `tools/mp3_window.py`. Tempos and beat grids come from
`tools/harness/analyse_crate.html`, and every drop-in cue was verified by
playing it (`tools/harness/verify_cues.html`). Credits with licence links are
shown under the crate; nothing is bundled — `demo/crate.json` is metadata.

## Deploy to GitHub Pages

1. Create a new GitHub repo (e.g. `beatmatch-trainer`) and push this folder.
2. Repo **Settings → Pages → Source: Deploy from a branch → main / root**.
3. Wait ~1 minute; your app is live at `https://<username>.github.io/beatmatch-trainer/`.

## Install on iPhone

1. Open the URL in **Safari** (must be Safari for install).
2. Share button → **Add to Home Screen**.
3. Launch from the icon — it runs full-screen and works offline after first load.
4. Load your practice crate once via **Add tracks**; it persists.

> iOS can evict site storage after weeks of disuse. Opening the app regularly
> (which is the point) prevents this. The app also requests persistent storage.

## Getting tracks from Rekordbox

Best path: export a practice playlist with BPMs baked into filenames.

1. In Rekordbox: make a "Practice Crate" playlist (20–30 steady tracks).
2. **File → Export Collection in xml format** → save `rekordbox.xml`.
3. Run:
   ```
   python tools/rekordbox_export.py rekordbox.xml "Practice Crate" "C:\Users\<you>\OneDrive\BeatmatchCrate"
   ```
4. Let iCloud/OneDrive sync → on iPhone, Files app → long-press the folder → **Download Now**.
5. In the app: **Add tracks** → browse to the folder → select all.

Filenames like `Artist - Title 126.02bpm.mp3` are picked up instantly with the
exact Rekordbox-analysed BPM — no in-app detection needed. The decimals matter:
in two-track mode deck B's base rate is `bpmA / bpmB`, so a BPM rounded to the
nearest whole number can leave the mix drifting by up to half a beat per minute
while the app still calls it perfect.

Untagged tracks fall back to in-app detection (web-audio-beat-detector,
constrained to 80–159 BPM). It's good but not exact — prefer the filename route.

## Local development

Any static server works:

```
python -m http.server 8000
```

Then open http://localhost:8000. Note: the service worker requires HTTPS or
localhost; GitHub Pages provides HTTPS automatically.

## Architecture

```
index.html            app shell
css/app.css           design system (Technics-inspired: plinth/platter/strobe palette)
js/app.js             trainer logic: decks, fader, rounds, scoring, BPM detection
js/db.js              IndexedDB: tracks (audio blobs + metadata), round stats, settings
js/vendor/            web-audio-beat-detector, vendored as a self-contained ESM bundle
sw.js                 service worker: offline shell + font caching
manifest.webmanifest  PWA install metadata
tools/rekordbox_export.py   crate export from Rekordbox XML (+ crate.json beat grid)
tools/crate_sync.py         fold newly dropped tracks into an existing crate
tools/crate_bpm_stats.py    print a playlist's BPM spread (numbers only)
tools/harness/              measurement kit: synthetic crate, browser tests, grid analyser
demo/crate.json             the demo crate manifest (URLs + BPM + grid + credits)
```

No build step, no dependencies, no framework. Vanilla ES modules.
