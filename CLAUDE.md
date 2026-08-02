# Beatmatch Trainer — project context for Claude Code

## What this is
A personal PWA for practising DJ beatmatching by ear, inspired by Beatmatch PRO
but using the owner's own music library, with unlimited practice rounds and full
offline support. Deployed on GitHub Pages, installed to iPhone home screen.

## Owner context
- DJ setup: 2× Technics SL-1210 MK2, Allen & Heath Xone:PX5, Rekordbox library.
- The ±8% pitch fader range and pitch-changes-key behaviour are deliberate:
  they mirror the SL-1210. Do NOT add timestretch/key-lock unless asked.
- The app must stay honest ear training: no visual tempo cues during play
  (no waveforms, no BPM readouts of deck B's effective tempo, no drift meters).
  Visual feedback belongs only on the reveal screen.

## Architecture principles
- Vanilla JS ES modules, no build step, no framework, no backend. Keep it that way.
- All persistence is IndexedDB (js/db.js). Audio blobs stored locally; nothing uploads.
- Service worker (sw.js) precaches the shell. Bump the CACHE version string on
  every deploy that changes shell files, or users get stale code.
- Design tokens live in css/app.css :root — palette named after turntable parts
  (plinth, platter, alloy, strobe, lock, amber). Reuse them; don't invent colors.
- Fonts: Chakra Petch (display), IBM Plex Mono (data), IBM Plex Sans (body).

## Key mechanics (don't break these)
- Round: deck B rate = r0 × (1 + hidden/100) × (1 + (fader+nudge)/100),
  where r0 = bpmA/bpmB (1 in same-track mode). hidden ∈ ±(2–6)% easy, ±(0.5–2.5)% hard,
  constrained so the correct fader position is within ±7.5.
- Result metric: BPM error = deck A's tagged BPM × tempo error %. The reveal
  headline is "N.NN BPM off" (owner's preferred metric — no score out of 100).
  Falls back to percent only if deck A has no BPM. Color bands: good ≤ 0.05 BPM,
  mid ≤ 0.3 BPM, bad above. Rounds store saves {err, errBpm}.
- Nudge is temporary (±1% while held), snaps back on release — like platter touch.
- BPM priority: filename "NNNbpm" > manual entry > auto-detection (lowpass peak
  histogram, clamped 85–175, weakest link — Rekordbox-exported names are preferred).

## Roadmap (owner-approved directions, build when asked)
1. Headphone split toggle: pan deck A hard left, deck B hard right (StereoPannerNode)
   to mimic one-ear-on-the-monitor mixing. Off by default. (Idea from codebox's
   MIT beatmatching game.)
2. Swap homegrown BPM detection for web-audio-beat-detector (npm, works well for
   electronic music, supports tempo range constraints). Only as fallback — filename
   BPM from Rekordbox export remains the primary source. Keep the no-build-step
   rule: vendor the ESM bundle into js/vendor/ rather than adding npm/bundler.
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
