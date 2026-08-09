# Beatmatch Trainer — project context for Claude Code

## What this is
A personal PWA for practising DJ beatmatching by ear, inspired by Beatmatch PRO
but using the owner's own music library, with unlimited practice rounds and full
offline support. Deployed on GitHub Pages, installed to iPhone home screen.

## Owner context
- DJ setup: 2× Technics SL-1210 MK2, Allen & Heath Xone:PX5, Rekordbox library.
- The ±8% pitch fader range and pitch-changes-key behaviour are deliberate:
  they mirror the SL-1210. Do NOT add timestretch/key-lock unless asked.
  The ×2 button opens the fader to ±16% for pairs that need headroom; ±8% is
  the default and the honest one. ×2 does not touch the hidden offset, so a
  wide round is no easier — it only adds travel.
- The app must stay honest ear training: no visual tempo cues during play
  (no waveforms, no BPM readouts of deck B's effective tempo, no drift meters).
  Visual feedback belongs only on the reveal screen. This is why the mixer has
  NO level meters even though Beatmatch PRO does — two bouncing meters let you
  watch the kicks line up and match by eye. Don't add them.

## Layout rules
- The mixer is a fixed, non-scrolling surface (body is position:fixed, the .app
  is a flex column at 100% height). On a touchscreen any page scroll steals the
  drag meant for the pitch fader. Faders flex to fill leftover height, so their
  pixel height is only known after layout — a ResizeObserver re-renders the knobs.
- Crate, mode, settings and session history live in the slide-up sheet (#sheet),
  which is the only thing allowed to scroll. Don't move controls back onto the
  main screen; the vertical room belongs to the faders.
- There is NO zero snap. A detent you can feel is one you can't be precise
  inside, and 0.1 BPM is ~2px of raw fader travel. The green lamp reports being
  within DETENT_BPM of zero instead of snapping there. Don't reintroduce a snap.
- Pitch faders have fine-drag: horizontal distance from the fader scales vertical
  sensitivity (1/(1+dx/30)). Movement is integrated incrementally, never
  recomputed from the press point, or changing scale mid-drag makes the knob jump.
- Playback starts at phraseStart(): a whole number of 4-bar phrases from the
  Rekordbox downbeat anchor, past the intro. The anchor comes from crate.json,
  which the file picker accepts alongside audio. No grid → old 25%-in fallback.

## Audio architecture (do not "optimise" back)
- Decks STREAM through an <audio> element into a MediaElementAudioSourceNode.
  Never go back to decodeAudioData + AudioBufferSourceNode for playback:
  decoding expands compressed audio to float32 PCM, so a 22 MB / 9 min MP3
  becomes 216 MB in RAM and two decks 425 MB. iOS Safari kills the page well
  before that — it presented as "can't decode this file" plus silence on the
  phone while working fine on a desktop. Streaming holds a few MB per deck.
- Media elements time-stretch by default. preservesPitch = false (plus the
  webkit/moz prefixes) is REQUIRED on every element and must be re-applied when
  the rate changes, or pitch stops following tempo and the app stops being a
  1210 simulator.
- decodeAudioData survives only in decodeForAnalysis(), for BPM detection of
  untagged tracks. Nothing caches the result — one held buffer can kill the tab.

## Architecture principles
- Vanilla JS ES modules, no build step, no framework, no backend. Keep it that way.
- All persistence is IndexedDB (js/db.js): tracks, rounds, settings. Audio blobs
  stored locally; nothing uploads. No localStorage.
- Third-party code is vendored into js/vendor/ as self-contained ESM bundles
  (no imports, no runtime CDN fetches) and added to the sw SHELL list.
- Service worker (sw.js) precaches the shell. Bump the CACHE version string on
  every deploy that changes shell files, or users get stale code.
- Design tokens live in css/app.css :root — palette named after turntable parts
  (plinth, platter, alloy, strobe, lock, amber). Reuse them; don't invent colors.
- Fonts: Chakra Petch (display), IBM Plex Mono (data), IBM Plex Sans (body).

## Key mechanics (don't break these)
- Both decks are live. Deck 1 rate = 1 + (fader+nudge)/100. Deck 2 rate =
  r0 × (1 + hidden/100) × (1 + (fader+nudge)/100), r0 = bpmA/bpmB. hidden ∈
  ±(2–6)% easy, ±(0.5–2.5)% hard, constrained so the correct position is within
  ±(pitchRange − 0.5). Rounds are always two different tracks — the owner
  removed same-track mode, so every round needs a BPM on both decks.
- Score is the RELATIVE tempo error: ((1+hidden/100)(1+faderB/100) / (1+faderA/100) − 1)×100.
  Nudge is excluded — it's a momentary bend, not part of the answer. So there is
  no single "correct fader position" any more; deck 2 has to sit wherever cancels
  the hidden offset relative to wherever deck 1 is.
- Cue returns a deck to its cuePoint (the round's start offset, ~25% in). Play
  resumes from where it stopped, so playhead position is tracked in decks[id].offset
  via markPosition() — always mark BEFORE changing rate or the position drifts.
- Two-track pairing is restricted to tracks whose r0 sits inside the fader range
  (|bpmA/bpmB − 1| ≤ pitchRange%), so every pair is one you could actually mix on
  the 1210s. Without it a mixed house/hip-hop crate deals 126-vs-90 pairs and
  plays deck B 40% sharp. This is what keeps genres apart — no tagging needed.
- Result metric: BPM error = deck A's tagged BPM × tempo error %. The reveal
  headline is "N.NN BPM off" (owner's preferred metric — no score out of 100).
  Falls back to percent only if deck A has no BPM. Color bands: good ≤ 0.05 BPM,
  mid ≤ 0.3 BPM, bad above. Rounds store saves {err, errBpm}.
- Nudge is temporary (±1% while held), snaps back on release — like platter touch.
- BPM priority: filename "NNNbpm" > manual entry > auto-detection
  (web-audio-beat-detector, vendored, constrained 80–159; the old lowpass peak
  histogram survives as detectBPMFallback only). Rekordbox-exported names preferred.
- The detection range must stay under one octave (80×2 = 160 > 159). A range
  spanning more than an octave lets a tempo fold two ways and the detector picks
  half- or double-time — measured: at 85–175 a 174 BPM track came back as 87.
  80–159 is sized to hold hip-hop (80–100) and house/techno (120–159) at once;
  160+ material folds to half-time. Don't widen it — that trades a known,
  bounded limitation for silent half/double errors across the whole crate.
- BPM values are decimals, never rounded. In two-track mode r0 = bpmA/bpmB, so a
  whole-number BPM leaves the mix up to ~0.5 BPM out while the reveal reports a
  perfect match. Both the filename parser and tools/rekordbox_export.py keep the
  fraction — don't "tidy" either back to integers.

## Built (was roadmap 1–2)
- Headphone split toggle: StereoPannerNode per deck, A hard left / B hard right,
  off by default, persisted in the settings store.
- BPM detection uses vendored web-audio-beat-detector.

## Roadmap (owner-approved directions, build when asked)
3. Beat-phase scoring: score not just tempo but beat alignment (onset offset at reveal).
4. Daily challenge: seeded pair-of-the-day from own crate (date-seeded PRNG), streak counter.
5. Stats page: all-time chart from the rounds store (score over time, by mode/difficulty).
6. Crossfader instead of two level sliders.
7. Crate manager: tag tracks, filter pairs by tag (mirrors Rekordbox playlists).
8. Export/import crate metadata as JSON (not audio) for device migration.

## Testing checklist before deploy
- iPhone Safari: fader drag, nudge hold, audio plays after first tap (autoplay policy).
- Kill network → app still loads and plays stored tracks.
- Add track → close tab → reopen → track still in crate.
- Bump sw.js CACHE version if any shell file changed.
