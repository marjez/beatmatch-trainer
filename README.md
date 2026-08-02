# Beatmatch Trainer

Practice beatmatching by ear with your own music. Unlimited rounds, no account,
no ads, no daily limit, fully offline once installed. A personal replacement for
Beatmatch PRO built around your own crate.

## How it works

- **Deck A** plays at fixed tempo. **Deck B** plays with a hidden random tempo offset.
- Match B to A by ear using the ±8% pitch fader (SL-1210 range) and hold-to-nudge buttons.
- **Reveal score** shows your accuracy out of 100 and a strobe-dot row that drifts
  at your error rate — frozen dots means you locked it.
- **Same track ×2** mode is pure ear training (no BPM needed).
  **Two tracks** mode mixes different tunes using their BPMs.
- Your crate and round history are stored on-device (IndexedDB) and persist between sessions.

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
4. Let OneDrive sync → on iPhone, Files app → long-press the folder → **Download Now**.
5. In the app: **Add tracks** → browse to the folder → select all.

Filenames like `Artist - Title 126bpm.mp3` are picked up instantly with the
exact Rekordbox-analysed BPM — no in-app detection needed.

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
js/db.js              IndexedDB: tracks (audio blobs + metadata) and round stats
sw.js                 service worker: offline shell + font caching
manifest.webmanifest  PWA install metadata
tools/rekordbox_export.py   crate export from Rekordbox XML
```

No build step, no dependencies, no framework. Vanilla ES modules.
