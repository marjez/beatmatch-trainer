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
- You GRAB THE KNOB and it stays under your thumb. Press within the knob plus
  GRAB_SLOP and it tracks 1:1 from where you took hold; press the bare track and
  nothing happens, like the plinth of a 1210. Two earlier models both failed:
  jump-to-finger threw the value wherever you touched, and relative-from-anywhere
  let the knob drift away from the finger until you were dragging at the top of
  the fader while the knob sat at the bottom. Don't go back to either.
- Pitch faders have fine-drag: horizontal distance from the fader scales vertical
  sensitivity (1/(1+dx/30)) — 0.038 BPM/px straight down, 0.008 BPM/px at 120px
  out. Movement is integrated incrementally, never recomputed from the press
  point, or changing scale mid-drag makes the knob jump.
- Knobs move via transform: translate3d, written SYNCHRONOUSLY in the pointermove
  handler. Do NOT batch fader paints to requestAnimationFrame: measured, it added
  a median 4.9 ms / max 15 ms of latency and collapsed 150 move events into 82
  paints, throwing away half the finger movement. There is nothing to batch — the
  handler only writes transform and textContent and never reads geometry, so it
  cannot force layout. Writing .top instead WOULD re-run layout on every move.
- Playback starts at phraseStart(): a whole number of 4-bar phrases from the
  Rekordbox downbeat anchor, past the intro. The anchor comes from crate.json,
  which the file picker accepts alongside audio. No grid → old 25%-in fallback.

## Why it sounds right or wrong (researched + measured, Sept 2026)
The app was "harder to hear the match on" than Beatmatch PRO for three concrete
reasons, all fixed. Don't undo any of them.

1. PHASE LOCK IS THE WHOLE MECHANIC. A tempo error is only audible as a flam,
   and two transients stop reading as one drum once they're ~20-50 ms apart.
   Starting decks with two separate play taps leaves them up to half a beat
   (240 ms at 125 BPM) out — far outside that window, so you hear two unrelated
   rhythms and the tempo error is effectively inaudible. Nudge can't rescue it:
   closing 240 ms at 2% takes 12 seconds of holding. dropBoth() schedules both
   sources on one audio-clock tick from offset 0, and since both windows begin on
   a downbeat that puts them in unison. Individual play buttons remain for
   listening to one deck alone.
2. THE MIX WAS CLIPPING. Two modern masters at deck gain summed to peak 1.64 and
   hard-clipped 0.64-1.3% of samples at the destination — and clipping lands on
   the kick transients, flattening the very attacks you listen for. The master
   bus is 0.5 with a DynamicsCompressor as a safety limiter: measured peak 0.909,
   0% clipped. Keep the headroom; don't "fix" the app being quieter by raising it.
3. NATIVE SAMPLE RATE ONLY. We used to force 32 kHz. Forcing a non-native rate is
   a documented cause of crackle/distortion on iOS, and it threw away the top end
   that carries transient detail. A 180 s mono window at 48 kHz is 34.6 MB/deck.

Beat focus (low-pass to ~220 Hz on the master) strips the mix down to kick and
low end so the flam is unmistakable. It's the EQ-kill move you'd make on the PX5,
not a visual cue, so it doesn't violate the honest-ear-training rule.

## Audio architecture (both naive options are wrong — measured)
Playback is an AudioBufferSourceNode fed from a WINDOWED MONO buffer. Both
obvious alternatives were tried on real tracks and both failed:
- Full-track decodeAudioData: 22 MB / 9 min MP3 -> 216 MB of float32 PCM, two
  decks 425 MB. iOS Safari kills the page — presented as "can't decode this
  file" plus silence on the phone while fine on a desktop.
- <audio> + MediaElementAudioSourceNode: memory fine, but writing playbackRate
  reconfigures the element's resampler. Riding the fader for 2s with 120 writes
  fired a pause event and lost 0.44s of audio. Coalescing helped but never got
  to zero, and seeking to the phrase start was only frame-accurate.

What works, and why each part is load-bearing:
- AudioContext runs at the DEVICE'S NATIVE RATE (see the section above — forcing
  32 kHz risked iOS crackle and cost transient detail).
- Immediately copy a WINDOW_S (180 s) MONO window out of the decoded buffer and
  drop the full one: ~34.6 MB per deck at 48 kHz, ~69 MB for both. Mono is free —
  the split panner puts each deck hard L/R anyway.
- The window STARTS at phraseStart(), so buffer offset 0 IS the downbeat. That
  is what makes playback start on beat 1 rather than near it, and it makes the
  cue point exactly 0.
- playbackRate on a source node is an AudioParam: writing it on every pointermove
  is glitch-free (measured 120 writes, 0 silent frames). Do NOT reintroduce rate
  coalescing — that was a workaround for the media element and only adds lag.
- Decodes are sequenced through loadChain so two full-size buffers never coexist,
  and a per-deck token discards results from a superseded round.
- Window buffers are POOLED (windowPool) — allocated once per deck and overwritten
  in place, with d.validSeconds tracking the usable part and src.start(when, at,
  duration) avoiding the zeroed tail. Allocating a fresh ~35 MB Float32Array per
  deck per round, on top of dropping the ~150 MB decoded original, is the churn
  that makes the collector pause the main thread — and on-device profiling showed
  those pauses landing as 40-135 ms freezes mid-drag while touch delivery and fps
  were otherwise healthy (59 Hz, 60 fps, 17 ms median gap).
- decodeForAnalysis() still full-decodes for BPM detection of untagged tracks.
  Nothing caches it — one held full buffer can kill the tab.
- Fader pixel sizes are measured into faderPx on layout change, never per move.
  Reading clientHeight/getBoundingClientRect mid-drag forces a synchronous
  layout every frame; a 120-move drag went from 120+ reads to 1.

## Cue behaviour (matches CDJ/turntable convention)
- Playing + tap Cue -> back-cue: jump to the cue point and stop.
- Stopped + hold Cue -> preview from the cue point; release snaps back and stops.
- Cue point is buffer offset 0, i.e. the phrase start. Play resumes from wherever
  the deck was stopped.

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
- Fonts: Chakra Petch (display), IBM Plex Mono (data), system stack for body.
  IBM Plex Sans was dropped — 194 KB to style one rule. Don't add a third family.

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
- Cue behaviour is described under "Cue behaviour" above. Playhead position is
  tracked in decks[id].offset via markPosition() — always mark BEFORE changing
  rate or the position drifts.
- Two-track pairing is restricted to tracks whose r0 sits inside the fader range
  (|bpmA/bpmB − 1| ≤ pitchRange%), so every pair is one you could actually mix on
  the 1210s. Without it a mixed house/hip-hop crate deals 126-vs-90 pairs and
  plays deck B 40% sharp. This is what keeps genres apart — no tagging needed.
- Result metric: BPM error = deck A's tagged BPM × tempo error %. The reveal
  headline is "N.NN BPM off" (owner's preferred metric — no score out of 100).
  Falls back to percent only if deck A has no BPM. Color bands: good ≤ 0.05 BPM,
  mid ≤ 0.3 BPM, bad above. Rounds store saves {err, errBpm}.
- Nudge is temporary (±2% while held), snaps back on release — like platter touch.
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

## Open threads (as of 2026-09-20)
- UNVERIFIED: v15's phase-locked "Drop both" + Beat focus are the fix for "hard
  to hear the match", but the owner hasn't tried them on the phone yet. Don't
  build on top of that mechanic until it's confirmed working.
- 6 of 41 crate tracks have no beat grid, so they still start off-phrase and gain
  nothing from the phase lock: 02 Blaze - Most Precious Love 1, michael_moog -
  that_sound, CHRIS STASSY x2, EserEx - Oversimplify, G-TONIN - After All. They
  postdate the Aug 2 rekordbox.xml — re-export it and re-run tools/crate_sync.py.
- "02 Blaze - Most Precious Love 1" fuzzy-matches the Freemasons Club Mix at 0.50,
  which is a DIFFERENT mix. crate_sync deliberately leaves it unmatched rather
  than stamp it with the wrong BPM and downbeat.
- Two duplicate recordings sit in the crate under both old and new names (Michael
  Bibi - Lil Freaky, Dennis Cruz - El Sueño). Harmless but they can be dealt
  against each other; the owner should delete one copy of each.
- "Prodigy - breathe 130.02bpm.mp3" vanished from the crate folder between Aug 2
  and Sept 20. crate_sync provably didn't remove it (it only renames untagged
  files and only deletes a lossless original after converting it).
- Next feature if the mechanic checks out: the stats page (roadmap 5). Rounds
  already persist err/errBpm/difficulty/pitchRange/faderA/faderB and nothing
  reads them back except a count, so there's no way to see improvement.
- NOT worth building yet: beat-phase scoring (roadmap 3). With a phase-locked
  start, drift at reveal is just tempo error x elapsed time — it would mostly
  restate the score already shown.

## Roadmap (owner-approved directions, build when asked)
3. Beat-phase scoring: score not just tempo but beat alignment (onset offset at reveal).
4. Daily challenge: seeded pair-of-the-day from own crate (date-seeded PRNG), streak counter.
5. Stats page: all-time chart from the rounds store (score over time, by mode/difficulty).
6. Crossfader instead of two level sliders.
7. Crate manager: tag tracks, filter pairs by tag (mirrors Rekordbox playlists).
8. Export/import crate metadata as JSON (not audio) for device migration.

## Working from the Linux box as well as the Mac
- tools/harness/ is the measurement kit that found every real bug here. Run
  tools/harness/check.sh to parse-check (node on Linux, JavaScriptCore on the
  Mac) and tools/harness/browser_test.py to drive the real app in headless
  Chrome. make_test_audio.py synthesises tracks with a known BPM and a downbeat
  at t=0, so no test depends on the owner's crate.
- MAC-ONLY, and can't move: the crate itself lives in iCloud Drive and
  rekordbox.xml is exported there, so crate_sync.py / rekordbox_export.py only
  make sense on the Mac. They also shell out to afconvert, which is macOS-only —
  if that ever needs to run on Linux it wants an ffmpeg branch.
- Harness numbers are not phone numbers. A desktop browser is not the input
  pipeline iOS uses; the in-app Touch diagnostics panel is the ground truth.

## Testing checklist before deploy
- iPhone Safari: fader drag, nudge hold, audio plays after first tap (autoplay policy).
- Kill network → app still loads and plays stored tracks.
- Add track → close tab → reopen → track still in crate.
- Bump sw.js CACHE version if any shell file changed.
