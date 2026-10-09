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
- The app must stay honest ear training BY DEFAULT: no visual tempo cues during
  play (no waveforms, no BPM readouts of deck B's effective tempo, no drift
  meters). Visual feedback belongs only on the reveal screen. Two bouncing
  meters let you watch the kicks line up and match by eye.
- Since 2026-09-20 there is a "Visual aids" setting (Beatmatch PRO parity,
  owner's decision, default OFF, persisted as 'aids'): level meters, scrolling
  waveforms with the beat grid. There is NO %/★ score: it was removed on
  2026-09-23 because its bands contradicted the reveal's own colour bands (a
  0.40 BPM miss showed a red headline above five gold stars) and because the
  real Beatmatch PRO formula is not public, so any number here is invented.
  The reveal reports BPM off, which the app can stand behind. NO BPM IS SHOWN
  DURING PLAY, not even the tagged one — the owner had it removed on 2026-09-22:
  deck 1's BPM plus the two pitch readouts lets you calculate the answer rather
  than hear it. Don't reintroduce a tempo number on the mixer screen.
  Off means off: setAids(false) detaches the analysers and stops
  the rAF loop — verified by tools/harness/tests/aids.html. The aids loop is
  separate from fader painting, which stays synchronous.

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
  sensitivity, with a 36 px DEAD ZONE first (1/(1+max(0,|dx|−36)/30)): on the
  phone a thumb moving straight down drifts 20-40 px sideways and fine mode was
  engaging uninvited ("the knob moves less than my thumb", v19 phone pass).
  Beyond the dead zone: half speed at 66 px out, a quarter at ~126 px. Movement
  is integrated incrementally, never recomputed from the press point, or
  changing scale mid-drag makes the knob jump.
- Knobs move via transform: translate3d, written SYNCHRONOUSLY in the pointermove
  handler. Do NOT batch fader paints to requestAnimationFrame: measured, it added
  a median 4.9 ms / max 15 ms of latency and collapsed 150 move events into 82
  paints, throwing away half the finger movement. There is nothing to batch — the
  handler only writes transform and textContent and never reads geometry, so it
  cannot force layout. Writing .top instead WOULD re-run layout on every move.
- Playback starts at phraseStart(): a whole number of 4-bar phrases from the
  Rekordbox downbeat anchor, past the intro. The anchor comes from crate.json,
  which the file picker accepts alongside audio. No grid → old 25%-in fallback.
  Since 2026-09-20 the first CUE at or after the 30 s target wins (snapped to
  the phrase grid): measured on the demo crate, a 9-minute track is often still
  beatless 30 s in, and Rekordbox memory cues / the analyser's "kick in" mark
  where the beat actually is. Cues before the target are ignored, and so are
  cues past 60% of the track or with under 90 s left — Rekordbox exports every
  position mark, mix-out cues included.
  For the demo crate, analyse_crate.html emits a cue for EVERY 4-bar phrase
  boundary from which the beat runs 8 bars (≥80% of beats carry an onset in
  either the kick band or broadband — a sidechained kick is invisible to the
  low band alone). "First kick" was not enough: v21 still started some decks in
  an intro, because a track can open with one hit and then a pad, and a phrase
  can be the last one before a breakdown. tools/harness/tests/startpoint.html
  is the check — it counts kicks over 8 s against the beats the tempo predicts,
  for every track in the crate.

## Transport: start on the press, at the downbeat (decided 2026-09-20)
The owner's priority is CDJ-class response on the per-deck Play and Cue: the
finger lands, the downbeat leaves the speaker. Decks are started one at a time,
by ear, as on CDJs/1210s — "Drop both" is a fallback in the settings sheet, not
the mechanic. Measured in the harness (tools/harness/tests/latency.html):
- Play was bound to `click`, which fires on RELEASE: press→sound was 108 ms,
  90 ms of it the tap itself. It's on `pointerdown` now: 6 ms, two render
  quanta, which is the Web Audio floor. Don't bind transport to click again.
- The audio graph is built when a deck loads and the context is resumed on the
  first touch anywhere (unlockAudioOnFirstTouch), so the first press of a
  session pays nothing extra. The unlock listens on pointerdown AND pointerup/
  touchend/click/keydown until the context is 'running': for touch, pointerdown
  is not an activation-triggering event in the HTML spec, so on iOS the very
  first press may only sound on its release. Every later press is on the press. latencyHint 'interactive'; iOS audioSession type
  'playback' (otherwise the silent switch mutes Web Audio).
- What the app can't shorten: AudioContext.baseLatency + outputLatency. The
  Diagnostics panel in the sheet shows both, plus the app's own press→start,
  so the phone's floor is readable on the device.

## Why it sounds right or wrong (researched + measured, Sept 2026)
The app was "harder to hear the match on" than Beatmatch PRO for three concrete
reasons, all fixed. Don't undo any of them.

1. PHASE MATTERS. A tempo error is only audible as a flam, and two transients
   stop reading as one drum once they're ~20-50 ms apart. Both windows begin on
   a downbeat (offset 0 IS beat 1, verified to the sample), so a deck dropped
   on the other's downbeat starts in unison and any drift you hear is the
   tempo error. dropBoth() (settings sheet) starts both on one audio-clock
   tick as a fallback.
2. THE MIX WAS CLIPPING — and the limiter that was added for it is now GONE
   (2026-09-22). Measured, its fixed 6 ms look-ahead was 6.0 of the 6.1 ms
   press-to-sound, and with the equal-power crossfader, the split panner and
   the 0.5 bus, two coherent full-scale peaks bound the master near 0.5 — some
   5 dB under its own threshold, so it could never engage. Without it: peak
   0.458 (0.648 at worst-case deck gain), 0% clipped, press to sound 0.11 ms.
   The headroom that prevents clipping is the 0.5 bus; keep that.
   The original finding, for the record: Two modern masters at deck gain summed to peak 1.64 and
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
- Transport is on pointerdown (see "Transport" above). Cue: pointerdown/up.
- Two-track pairing is restricted to tracks whose r0 sits inside the fader range
  (|bpmA/bpmB − 1| ≤ pitchRange%), so every pair is one you could actually mix on
  the 1210s. Without it a mixed house/hip-hop crate deals 126-vs-90 pairs and
  plays deck B 40% sharp. This is what keeps genres apart — no tagging needed.
- Result metric: BPM error = deck A's tagged BPM × tempo error %. The reveal
  headline is "N.NN BPM off" (owner's preferred metric — no score out of 100).
  Falls back to percent only if deck A has no BPM. Color bands: good ≤ 0.05 BPM,
  mid ≤ 0.3 BPM, bad above. Rounds store saves {err, errBpm, mode, difficulty,
  pitchRange, faderA, faderB, aName, bName, at} — db.saveRound used to drop the
  faders; fixed 2026-09-20.
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

## Practice beats (js/beats.js, 2026-09-30)
The netlabel demo crate is mostly sparse and minimal, which is the wrong
material for hearing a flam. js/beats.js synthesises 11 patterns (house, funky
house, tech house, techno, breaks; 122-140 BPM) ON THE DEVICE:
- A beat track is a RECIPE, not a file: {pattern, seed, root} on the record,
  no blob at all, a few hundred bytes in IndexedDB. loadDeck branches on
  track.synth and renders straight into the pooled window buffer.
- Tempo is exact and offset 0 IS beat 1 by construction, so there is no grid to
  analyse and no cue to verify. Decimal BPMs, per the no-rounding rule.
- THE KICK OWNS THE LOW END. A bassline on the offbeats at 55 Hz dropped the
  on-beat/off-beat kick-band ratio to 1.3 (techno) and 0.97 (breaks) — the kick
  stopped being the loudest thing in the band you match on. Patterns that lean
  on offbeat bass set bassOct/bassGain to move it up and out of the way.
- Swing SHIFTS an odd 16th by a fraction of a step. Multiplying the position by
  (1+swing) scales it, so step 15 landed nearly two steps late.
- VOICES ARE CACHED TABLES. Rendering each hit sample-by-sample took 13 SECONDS
  per deck at a 6× CPU throttle — the Play button sat dead that whole time,
  which is what "the practice beats don't play" was. A kick is the same 20 000
  samples every time it lands. With tables it is 12-53 ms. tools/harness/
  pw_slow_phone.mjs is the regression test: real touch, 6× throttle, and a
  RELOAD before playing, because the in-page tests add and play in one fast
  session and never saw it.
- tools/harness/tests/beats.html plays every pattern through the app and
  requires the kick on the grid (ratio > 1.8, ≥90% of beats) and the first hit
  within 20 ms. Breakbeat is exempt: its kick is deliberately not on every beat.

## Decks LOOP a beat-solid section (2026-10-09)
Reported as "the demo tracks are really bad for beatmatching", and measured:
the median track carried a running beat for only 80% of a three-minute window
and 15 of 24 had a dead stretch of 16 s or more. Matching against a breakdown
teaches nothing. Each track now declares loopStart/loopEnd — the longest run
where the kick band dominates the offbeat, both ends on a 4-bar boundary —
and loadDeck windows exactly that while startSource sets src.loop.
- THE LOOP MUST BE A WHOLE NUMBER OF BEATS, computed in loadDeck from the
  track's own tempo and rounded to samples. The manifest rounds to the
  millisecond, which left one loop 0.1 beat long: every wrap shifted the grid
  and the beat audibly jumped.
- d.loopSeconds drives both playback and the visual-aids playhead, which must
  wrap with it. src.start takes no duration when looping — that would stop the
  source at the end of the first pass.
- applyGrid carries loopStart/loopEnd out of crate.json, so a crate added
  through the file picker gets loops too, not just the demo one.
- tools/harness/tests/loop.html is the gate: it plays PAST the seam and
  requires the beat to still be on the same grid afterwards, with no silence
  that the material does not already have. 15 of 20 passed; the rest were
  dropped rather than shipped with an audible hole every two minutes.

## Measure ON THE BEAT GRID (2026-10-09)
Three separate false results in one session came from probing between beats:
an 8 s block is not a whole number of beats (16.27 at 122 BPM), so marching
k·period from each block drifts a quarter-beat per block; starting playback
"6 seconds" before a loop seam does not land on a beat; and a grid scan that
starts at sample 0 ignores the track's anchor. Every probe must be snapped to
anchor + n·beat. The first of these produced a headline figure — "the median
track has a beat only 39% of the time" — that was simply wrong; the real
number was 80%.

## Built (was roadmap 1–2, 6)
- Headphone split toggle: StereoPannerNode per deck, A hard left / B hard right,
  off by default, persisted in the settings store.
- BPM detection uses vendored web-audio-beat-detector.
- Progress panel (2026-09-20, roadmap 5) in the sheet: KPI tiles (rounds, best,
  median of last 20, % locked ≤0.05), an SVG chart of BPM off per round with a
  rolling median of 10, difficulty filter, tap-for-pair tooltip, table view.
  Plain SVG, no library; one series so no legend; dot colour = reveal band.
  Rounds without errBpm (pre-BPM-metric records) are skipped.
- Demo crate (2026-10-09): 15 CC tracks, 115-140 BPM, each looping a verified beat-solid section, every one fetched with a
  RANGE request for ~220 s around its drop-in point — the player only ever uses
  180 s, so a nine-minute file is bandwidth and phone storage spent on audio
  that is never heard (141 MB for 18 tracks, where 10 uncut were 158 MB).
  byteStart/byteEnd come from tools/mp3_window.py, which walks real MP3 frame
  headers so the cut is a valid file; the grid and cues in the manifest are
  measured ON THE SLICE, so they must be regenerated if a range changes. The
  loader refuses a 200 response to a ranged request — a server ignoring Range
  would return the whole file, whose timeline the rebased grid does not match.
- Demo crate (2026-09-20): demo/crate.json lists CC BY tracks on archive.org
  (CORS open) with BPM, anchor, kick-in cue and credit; loadDemoCrate() fetches
  them one at a time into IndexedDB with `credit` on the record, and the crate
  panel shows credits (CC BY requires attribution + licence link). The service
  worker does NOT runtime-cache cross-origin requests, so the audio isn't stored
  twice. Analysed with tools/harness/analyse_crate.html; downbeat-within-bar is
  best-effort, beat phase and BPM are exact (integer tempos, DAW-produced).
- Crossfader (2026-09-20) replaced the two channel faders: equal-power curve,
  centre = both decks at cos(π/4), position persisted as setting 'xfade'. The
  pitch faders got the width back. bindFader takes axis 'x'|'y'; the grab-the-
  knob and no-rAF rules apply to it exactly as to the pitch faders.

## Open threads (as of 2026-09-20)
- Overnight branch `overnight-2026-09-20` (Linux box): latency-first transport,
  Drop Both moved to the sheet, harness extended. Owner merges after the phone
  pass; nothing is pushed to main from the branch.
- UNVERIFIED ON THE PHONE: the pointerdown transport and the audio-session
  change. Read the Diagnostics panel after a few presses for the device floor.
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
- NOT worth building yet: beat-phase scoring (roadmap 3). With a phase-locked
  start, drift at reveal is just tempo error x elapsed time — it would mostly
  restate the score already shown.

## Roadmap (owner-approved directions, build when asked)
3. Beat-phase scoring: score not just tempo but beat alignment (onset offset at reveal).
4. Daily challenge: seeded pair-of-the-day from own crate (date-seeded PRNG), streak counter.
7. Crate manager: tag tracks, filter pairs by tag (mirrors Rekordbox playlists).
8. Export/import crate metadata as JSON (not audio) for device migration.

## Working from the Linux box as well as the Mac
- tools/harness/ is the measurement kit that found every real bug here. Run
  tools/harness/check.sh to parse-check (node on Linux, JavaScriptCore on the
  Mac) and tools/harness/browser_test.py to drive the real app in headless
  Chrome. make_test_audio.py --crate synthesises a whole gridded crate with
  known BPMs and downbeats, so no test depends on the owner's crate. The app
  exposes read-only handles on window.__bmt for the harness only.
- MAC-ONLY, and can't move: the crate itself lives in iCloud Drive and
  rekordbox.xml is exported there, so crate_sync.py / rekordbox_export.py only
  make sense on the Mac. They also shell out to afconvert, which is macOS-only —
  if that ever needs to run on Linux it wants an ffmpeg branch.
- Harness numbers are not phone numbers. A desktop browser is not the input
  pipeline iOS uses; the in-app Touch diagnostics panel is the ground truth.

## Harness measurement bugs, twice the same one (2026-09-30)
An envelope hop of round(sr/1000) samples is 0.9977 ms, NOT 1 ms. Treating the
index as milliseconds drifts 0.23% — 18 ms over an 8 s window, past the ±15 ms
tolerance, so late beats fell outside their own windows. It biased every BPM in
analyse_crate.html (fixed then) and made startpoint.html far stricter than
intended (fixed now). lib.js's lowEnvelope returns hopS; use it.
Phase is measured from the kick's ATTACK, not its envelope peak: a kick whose
sub blooms 30 ms in peaks late while its transient is on time, which failed two
perfectly gridded tracks. Threshold is 35 ms — the bug it guards against is a
quarter-second error, and two transients read as one drum up to ~20-50 ms apart.

## The harness can fail now (2026-09-22)
browser_test.py used to exit 0 whenever a page posted anything — a test could
report verdict FAIL and the run looked green. It exits 1 on fatal, failures,
jsErrors, or a page with no failures list that has not declared itself
`measurementOnly`. fader/latency/audio_chain carry thresholds instead of prose
verdicts. Don't add a test that only prints numbers.
Drop-in cues in demo/crate.json are verified by PLAYING them
(tools/harness/verify_cues.html) — static analysis of the file disagreed with
what the app actually plays, because a grid can shift within a track.

## Testing checklist before deploy
- iPhone Safari: fader drag, nudge hold, audio plays after first tap (autoplay policy).
- Kill network → app still loads and plays stored tracks.
- Add track → close tab → reopen → track still in crate.
- Bump sw.js CACHE version if any shell file changed.
