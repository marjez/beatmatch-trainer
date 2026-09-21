// app.js — Beatmatch Trainer core.
// Two decks, hidden tempo offset on deck B, ±8% pitch fader, hold-to-nudge,
// score on reveal. Crate and stats persist via IndexedDB (db.js).

import * as db from './db.js?v=bmt-v20';   // versioned like index.html's script tag

'use strict';

// ---------- State ----------
let tracks = [];            // {id, name, bpm, bpmSource, blob}
let ctx = null;
const mode = 'pair';        // always two different tracks; recorded on saved rounds
let difficulty = 'easy';
let round = null;           // {aIdx, bIdx, hidden, r0}
let split = false;          // headphone split: A hard left, B hard right
let beatFocus = false;      // low-pass the master so only the kicks remain
let pitchRange = 8;         // fader range %, 8 (SL-1210) or 16 via ×2
let aids = false;           // Beatmatch PRO-style visual aids: meters, waveforms, BPMs, %/stars
// Both decks are fully live: each has its own pitch fader, nudge and level, and
// the score is the tempo difference BETWEEN them. offset/mark track the playhead
// so Cue can return to the start point and Play can resume where it stopped.
const decks = {
  A: { buffer: null, pool: null, validSeconds: 0, source: null, gain: null, panner: null, playing: false, ready: false,
       fader: 0, nudge: 0, rate: 1, offset: 0, mark: 0, previewing: false, token: 0 },
  B: { buffer: null, pool: null, validSeconds: 0, source: null, gain: null, panner: null, playing: false, ready: false,
       fader: 0, nudge: 0, rate: 1, offset: 0, mark: 0, previewing: false, token: 0 },
};
// Crossfader position, 0 = deck 1 only, 1 = deck 2 only. Equal-power curve:
// centre puts both decks at -3 dB, the blend you actually beatmatch on.
let xfade = 0.5;
function deckGain(id) {
  const x = Math.max(0, Math.min(1, xfade));
  return id === 'A' ? Math.cos(x * Math.PI / 2) : Math.sin(x * Math.PI / 2);
}
function applyXfade() {
  for (const id of DECKS) if (decks[id].gain) decks[id].gain.gain.value = deckGain(id);
}
const DECKS = ['A', 'B'];
let sessionHistory = [];

// ---------- DOM ----------
const $ = id => document.getElementById(id);
const fileInput = $('fileInput'), trackList = $('trackList'), libMeta = $('libMeta');
const revealBtn = $('revealBtn'), newPairBtn = $('newPairBtn');
const overlay = $('overlay');

function toast(msg, ms = 2800) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(t._h);
  t._h = setTimeout(() => t.classList.remove('show'), ms);
}
// Run at the device's native rate. Forcing a non-native rate (we used to ask for
// 32 kHz) is a known cause of crackle and distortion on iOS, and it threw away
// the top end — hats and transient detail are exactly what you beatmatch against.
// A 180 s mono window at 48 kHz is 34.6 MB per deck, which is affordable.
function ensureCtx() {
  if (!ctx) {
    ctx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' });
    // iOS 17+: without this Safari treats Web Audio as "ambient" — the ring/
    // silent switch mutes it and the session runs with a larger output buffer.
    // 'playback' is what a music app asks for.
    try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch {}
  }
  if (ctx.state === 'suspended' || ctx.state === 'interrupted') ctx.resume();
  return ctx;
}
// The first touch anywhere resumes the context, so Play and Cue never pay for
// resume() on the press that matters. Registered at init, not on the buttons.
// For touch, pointerdown is NOT an activation-triggering event in the HTML
// spec (only pointerup / touchend / click are), and iOS has historically only
// unlocked audio from those. So the unlock listens on all of them and keeps
// listening until the context reports 'running'. A first Play press while
// still suspended schedules its source, which then starts on the release that
// resumes the context; every later press starts on the press.
//
// And the iOS trap on top of that, hit on the phone with v19: a context created
// at page load (so the graph is ready before the first press) can report
// 'running' after resume() and still output NOTHING until a sound is started
// from inside an activating gesture. v18 never saw it because its context was
// born on the Play click. So the unlock also starts a one-frame silent buffer
// on each activating event — the classic iOS unlock — and only stands down
// once that has happened with the context running.
function kickAudio(c) {
  try {
    const b = c.createBuffer(1, 1, c.sampleRate);
    const s = c.createBufferSource();
    s.buffer = b; s.connect(c.destination); s.start(0);
  } catch {}
}
function unlockAudioOnFirstTouch() {
  const EVENTS = ['pointerdown', 'pointerup', 'touchend', 'click', 'keydown'];
  const ACTIVATING = new Set(['pointerup', 'touchend', 'click', 'keydown']);
  let kicked = false;
  const unlock = e => {
    ensureMaster();
    for (const id of DECKS) ensureChain(id);
    if (ctx && ACTIVATING.has(e.type)) { kickAudio(ctx); kicked = true; }
    if (ctx && ctx.state === 'running' && kicked) for (const ev of EVENTS) document.removeEventListener(ev, unlock, true);
  };
  for (const ev of EVENTS) document.addEventListener(ev, unlock, true);
  // A phone call, Siri or a trip to the switcher leaves the context suspended
  // or (Safari) interrupted; coming back should not cost the next press a
  // resume. Also refresh the transport, since sources may have been dropped.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden || !ctx) return;
    if (ctx.state !== 'running') ctx.resume().catch(() => {});
    updateTransport();
  });
}

// ---------- Master bus ----------
// Two modern masters both peak near full scale. Summing them at deck gain hit
// 1.64 and hard-clipped 0.64% of samples at the destination — and clipping lands
// on the kick transients, flattening the very attacks you listen to. Halve the
// bus so the sum has headroom, and keep a limiter purely as a safety net.
let master = null;
const BEAT_FOCUS_HZ = 220;
function ensureMaster() {
  if (master) return master;
  const c = ensureCtx();
  const input = c.createGain();
  input.gain.value = 0.5;
  // Low-pass "beat focus": kills the mids and highs so only the kick and low end
  // remain. Two kicks a few ms apart flam unmistakably once the mix is out of the
  // way. This is what you'd do with the EQ kills on the PX5 — not a visual cue.
  const focus = c.createBiquadFilter();
  focus.type = 'lowpass';
  focus.frequency.value = 20000;
  focus.Q.value = 0.7;
  const limiter = c.createDynamicsCompressor();
  limiter.threshold.value = -1.5;
  limiter.knee.value = 0;
  limiter.ratio.value = 20;
  limiter.attack.value = 0.002;
  limiter.release.value = 0.12;
  input.connect(focus); focus.connect(limiter); limiter.connect(c.destination);
  master = { input, focus, limiter };
  return master;
}
function setBeatFocus(on) {
  beatFocus = on;
  const btn = $('focusBtn');
  btn.classList.toggle('on', on);
  btn.setAttribute('aria-pressed', String(on));
  if (!master) return;
  const c = ensureCtx();
  master.focus.frequency.setTargetAtTime(on ? BEAT_FOCUS_HZ : 20000, c.currentTime, 0.02);
}
function bpmFromName(name) {
  // Capture the decimals too — Rekordbox analyses to ~126.02, and dropping the
  // fraction skews r0 in two-track mode by enough to hear.
  const m = name.match(/(\d{2,3}(?:\.\d+)?)\s*bpm/i);
  if (m) { const v = parseFloat(m[1]); if (v >= 60 && v <= 200) return v; }
  return null;
}

// ---------- BPM detection ----------
// Filename BPM (Rekordbox export) is always preferred; this only runs when a
// track arrives untagged. web-audio-beat-detector does the real work — the
// homegrown lowpass histogram below is kept purely as a last resort, since it
// gives up on anything with a soft or sidechained kick.
// The range must span LESS than one octave, or a tempo has two valid
// representations inside it and the detector is free to pick the wrong one
// (measured: at 85–175 a 174 BPM track came back as 87). 80×2 = 160 > 159, so
// every tempo folds to exactly one value.
// 80–159 is chosen to hold both crates the owner trains on: hip-hop from 80 and
// house/techno to 159. The cost is that anything at 160+ (drum & bass, hard
// techno) folds to half-time — if that ever matters, it needs a per-crate range,
// not a wider one.
const MIN_BPM = 80, MAX_BPM = 159;

async function detectBPM(buffer) {
  // Analyse a window from inside the track: intros are often beatless.
  const offset = buffer.duration > 90 ? Math.min(30, buffer.duration * 0.25) : 0;
  const span = Math.min(60, buffer.duration - offset);
  try {
    const { guess } = await import('./vendor/web-audio-beat-detector.mjs');
    const res = await guess(buffer, offset, span, { minTempo: MIN_BPM, maxTempo: MAX_BPM });
    const bpm = typeof res === 'number' ? res : (res?.bpm ?? res?.tempo);
    if (bpm && bpm >= MIN_BPM && bpm <= MAX_BPM) return Math.round(bpm * 100) / 100;
  } catch {
    // fall through to the homegrown detector
  }
  return detectBPMFallback(buffer);
}

async function detectBPMFallback(buffer) {
  const seconds = Math.min(buffer.duration, 60);
  const offline = new OfflineAudioContext(1, Math.floor(seconds * buffer.sampleRate), buffer.sampleRate);
  const src = offline.createBufferSource();
  src.buffer = buffer;
  const lp = offline.createBiquadFilter();
  lp.type = 'lowpass'; lp.frequency.value = 150; lp.Q.value = 1;
  src.connect(lp); lp.connect(offline.destination);
  src.start(0);
  const rendered = await offline.startRendering();
  const data = rendered.getChannelData(0);
  let max = 0;
  for (let i = 0; i < data.length; i++) { const a = Math.abs(data[i]); if (a > max) max = a; }
  const threshold = max * 0.7;
  const minGap = Math.floor(rendered.sampleRate * 0.3);
  const peaks = [];
  for (let i = 0; i < data.length; i++) {
    if (Math.abs(data[i]) > threshold) { peaks.push(i); i += minGap; }
  }
  if (peaks.length < 8) return null;
  const counts = {};
  for (let i = 0; i < peaks.length - 1; i++) {
    let bpm = 60 * rendered.sampleRate / (peaks[i + 1] - peaks[i]);
    while (bpm < MIN_BPM) bpm *= 2;
    while (bpm > MAX_BPM) bpm /= 2;
    const key = Math.round(bpm);
    counts[key] = (counts[key] || 0) + 1;
  }
  let best = null, bestC = 0;
  for (const k in counts) {
    const c = (counts[k] || 0) + (counts[k - 1] || 0) * 0.5 + (counts[+k + 1] || 0) * 0.5;
    if (c > bestC) { bestC = c; best = +k; }
  }
  return best;
}

// ---------- Buffers ----------
// Only BPM detection needs a decoded buffer, and only for tracks that arrived
// without a BPM. Nothing is cached: a decoded track is ~200 MB, so holding
// even one is enough to get the page killed on iOS. Caller must let it go.
async function decodeForAnalysis(trackId) {
  ensureCtx();
  const t = tracks.find(x => x.id === trackId);
  const arr = await t.blob.arrayBuffer();
  return ctx.decodeAudioData(arr);
}

// ---------- Library ----------
// crate.json carries Rekordbox's beat grid, which a filename can't. Parsed
// before the audio so tracks arriving in the same selection pick it up.
async function readCrateJson(file) {
  try {
    const data = JSON.parse(await file.text());
    if (!data || !Array.isArray(data.tracks)) return null;
    const byStem = new Map();
    for (const t of data.tracks) {
      if (!t.file) continue;
      byStem.set(String(t.file).replace(/\.[^.]+$/, ''), t);
    }
    return byStem;
  } catch { return null; }
}
function applyGrid(rec, meta) {
  if (!meta) return false;
  let changed = false;
  if (typeof meta.anchor === 'number' && rec.anchor !== meta.anchor) { rec.anchor = meta.anchor; changed = true; }
  if (Array.isArray(meta.cues) && meta.cues.length) { rec.cues = meta.cues; changed = true; }
  if (typeof meta.bpm === 'number' && !rec.bpm) { rec.bpm = meta.bpm; rec.bpmSource = 'name'; changed = true; }
  return changed;
}

const isJson = f => /\.json$/i.test(f.name) || f.type === 'application/json';
const isAudio = f =>
  (f.type && f.type.startsWith('audio/')) ||
  /\.(mp3|m4a|mp4|aac|wav|aif|aiff|flac|ogg|oga|opus|caf|wma)$/i.test(f.name);

fileInput.addEventListener('change', async (e) => {
  const files = [...e.target.files];
  if (!files.length) return;
  const ignored = files.filter(f => !isJson(f) && !isAudio(f));

  let grid = null, gridApplied = 0;
  for (const f of files.filter(isJson)) {
    const parsed = await readCrateJson(f);
    if (parsed) grid = grid ? new Map([...grid, ...parsed]) : parsed;
  }
  if (grid) {
    for (const t of tracks) {
      if (applyGrid(t, grid.get(t.name))) { gridApplied++; await db.updateTrack(t); }
    }
  }

  let added = 0;
  for (const f of files) {
    if (!isAudio(f)) continue;
    const name = f.name.replace(/\.[^.]+$/, '');
    if (tracks.some(t => t.name === name && t.blob.size === f.size)) continue;
    const bpm = bpmFromName(f.name);
    const rec = { name, bpm, bpmSource: bpm ? 'name' : null, blob: f, anchor: null, cues: null };
    if (grid && applyGrid(rec, grid.get(name))) gridApplied++;
    rec.id = await db.addTrack(rec);
    tracks.push(rec);
    added++;
  }
  fileInput.value = '';
  const skipped = ignored.length ? ` (${ignored.length} non-audio file${ignored.length > 1 ? 's' : ''} skipped)` : '';
  if (added) toast(`${added} track${added > 1 ? 's' : ''} added to your crate — they'll be here next time too.${skipped}`);
  else if (gridApplied) toast(`Beat grid applied to ${gridApplied} track${gridApplied > 1 ? 's' : ''}.`);
  else if (ignored.length) toast(`Nothing added — those files aren't audio or crate.json.`);
  renderLibrary();
  detectMissingBPMs();
  updateButtons();
  if (!round && canStart()) startRound();
});

// ---------- Demo crate ----------
// demo/crate.json lists Creative Commons BY tracks on archive.org with their
// analysed BPM and beat grid. Nothing is bundled: each file is fetched once on
// request and stored like any other track, with its credit kept on the record
// so attribution can be shown. Fetched one at a time so a phone never holds
// more than one download in memory on top of the crate.
let demoLoading = false;
async function loadDemoCrate() {
  if (demoLoading) return;
  const btn = $('demoBtn');
  demoLoading = true; btn.disabled = true;
  let added = 0, failed = 0;
  try {
    const manifest = await (await fetch('demo/crate.json', { cache: 'no-cache' })).json();
    const list = manifest.tracks || [];
    for (let i = 0; i < list.length; i++) {
      const t = list[i];
      btn.textContent = `Downloading ${i + 1} of ${list.length}…`;
      try {
        if (!t || typeof t.file !== 'string' || typeof t.url !== 'string') throw new Error('bad entry');
        const name = t.file.replace(/\.[^.]+$/, '');
        if (tracks.some(x => x.name === name)) continue;
        const res = await fetch(t.url);
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const blob = new Blob([await res.arrayBuffer()], { type: res.headers.get('content-type') || 'audio/mpeg' });
        const rec = { name, bpm: t.bpm, bpmSource: 'name', blob, anchor: typeof t.anchor === 'number' ? t.anchor : null, cues: t.cues || null,
                      credit: { artist: t.artist, title: t.title, release: t.release, label: t.label, license: t.license, licenseUrl: t.licenseUrl, page: t.page } };
        rec.id = await db.addTrack(rec);
        tracks.push(rec);
        added++;
        renderLibrary();
      } catch { failed++; }
    }
    // Only now: a round decodes a full track (~200 MB of PCM for a 9-minute
    // MP3), which must not overlap with a download still being copied.
    updateButtons();
    if (!round && canStart()) startRound();
  } catch {
    toast('Could not fetch the demo crate list — are you online?');
  }
  demoLoading = false; btn.disabled = false;
  btn.textContent = 'Load the demo crate';
  if (added) toast(`${added} demo track${added > 1 ? 's' : ''} added${failed ? `, ${failed} failed` : ''}.`);
  else if (failed) toast(`Could not download the demo tracks (${failed} failed) — check the connection and try again.`);
  else toast('The demo crate is already loaded.');
  renderLibrary();
  updateButtons();
}
$('demoBtn').addEventListener('click', loadDemoCrate);

function renderCredits() {
  const box = $('creditsBox'), list = $('creditsList');
  const credited = tracks.filter(t => t.credit);
  box.hidden = credited.length === 0;
  list.innerHTML = '';
  for (const t of credited) {
    const c = t.credit;
    const row = document.createElement('div');
    row.className = 'credit-row';
    const a = document.createElement('a'); a.href = c.page || '#'; a.target = '_blank'; a.rel = 'noopener'; a.textContent = c.release || 'source';
    const l = document.createElement('a'); l.href = c.licenseUrl || '#'; l.target = '_blank'; l.rel = 'noopener'; l.textContent = c.license || 'CC';
    row.append(Object.assign(document.createElement('b'), { textContent: `${c.artist} – ${c.title}` }), ' · ', a, c.label ? ` (${c.label})` : '', ' · ', l);
    list.appendChild(row);
  }
}

function renderLibrary() {
  renderCredits();
  // Detection is opt-in: it full-decodes a track (~144 MB) to analyse it, so it
  // must never run unprompted at startup on a phone.
  const untagged = tracks.filter(t => !t.bpm).length;
  const btn = $('detectBtn');
  btn.style.display = untagged ? 'block' : 'none';
  btn.textContent = `Detect BPM for ${untagged} untagged track${untagged > 1 ? 's' : ''}`;
  trackList.classList.toggle('hidden', tracks.length === 0);
  $('emptyLib').style.display = tracks.length ? 'none' : 'block';
  const gridded = tracks.filter(t => typeof t.anchor === 'number').length;
  libMeta.textContent = tracks.length
    ? `${tracks.length} track${tracks.length > 1 ? 's' : ''} in your crate · ${gridded} with a beat grid`
      + (gridded < tracks.length ? ' — add crate.json for downbeat starts' : '')
    : '';
  trackList.innerHTML = '';
  tracks.forEach((t) => {
    const row = document.createElement('div');
    row.className = 'track-row';
    const name = document.createElement('div');
    name.className = 'track-name'; name.textContent = t.name;
    if (typeof t.anchor !== 'number') {
      name.textContent = '⚠ ' + t.name;
      name.title = 'No beat grid — playback starts by guesswork, not on a downbeat';
    }
    const bpm = document.createElement('input');
    bpm.className = 'track-bpm' + (t.bpmSource === 'auto' ? ' detected' : '');
    bpm.type = 'text'; bpm.inputMode = 'decimal';
    bpm.placeholder = t.bpmSource === 'pending' ? '…' : 'BPM';
    bpm.value = t.bpm ? t.bpm : '';
    bpm.addEventListener('change', async () => {
      const v = parseFloat(bpm.value);
      if (v >= 60 && v <= 220) {
        t.bpm = v; t.bpmSource = 'manual';
        bpm.classList.remove('detected');
        await db.updateTrack(t);
      } else { bpm.value = t.bpm || ''; }
      updateButtons();
    });
    const del = document.createElement('button');
    del.className = 'track-del'; del.textContent = '×';
    del.setAttribute('aria-label', `Remove ${t.name}`);
    del.addEventListener('click', async () => {
      await db.deleteTrack(t.id);
      tracks = tracks.filter(x => x.id !== t.id);
      if (round && (round.aId === t.id || round.bId === t.id)) { round = null; stopDeck('A'); stopDeck('B'); }
      renderLibrary(); updateButtons();
    });
    row.appendChild(name); row.appendChild(bpm); row.appendChild(del);
    trackList.appendChild(row);
  });
}

async function detectMissingBPMs() {
  for (const t of tracks) {
    if (t.bpm || t.bpmSource === 'pending') continue;
    t.bpmSource = 'pending';
    try {
      let buf = await decodeForAnalysis(t.id);
      const bpm = t.bpmSource === 'pending' ? await detectBPM(buf) : null;
      buf = null;                       // drop the ~200 MB buffer immediately
      if (t.bpmSource !== 'pending') continue;
      if (bpm) { t.bpm = bpm; t.bpmSource = 'auto'; await db.updateTrack(t); }
      else { t.bpmSource = null; }
    } catch { t.bpmSource = null; }
    renderLibrary();
    updateButtons();
  }
}

// ---------- Round logic ----------
// Deck B is the one that gets pitched, so its base rate r0 = bpmA/bpmB has to
// land inside the fader's range — otherwise it's a mix you could not perform on
// the 1210s. Without this a mixed house/hip-hop crate happily deals a 126 vs 90
// pair and plays deck B 40% sharp. Widening the range with ×2 widens this too.
function pairablePairs() {
  const eligible = tracks.filter(t => t.bpm);
  const pairs = [];
  for (const a of eligible) {
    for (const b of eligible) {
      if (a === b) continue;
      if (Math.abs(a.bpm / b.bpm - 1) * 100 <= pitchRange) pairs.push([a, b]);
    }
  }
  return pairs;
}

function canStart() {
  return pairablePairs().length > 0;
}

// Where a deck drops in. With Rekordbox's grid we land on beat 1 of a bar, a
// whole number of 4-bar phrases from the downbeat, past the intro — so you
// never sit through a beatless build. Without a grid, fall back to the old
// "quarter of the way in" guess.
const BEATS_PER_PHRASE = 16;   // 4 bars of 4/4
function phraseStart(track, duration) {
  const target = duration > 90 ? Math.min(30, duration * 0.25) : 0;
  if (typeof track?.anchor !== 'number' || !track?.bpm) return target;
  const phrase = BEATS_PER_PHRASE * (60 / track.bpm);
  const snap = t => track.anchor + Math.round((t - track.anchor) / phrase) * phrase;
  // Cue points (Rekordbox memory cues, or the analyser's "kick in" for the demo
  // crate) mark where the track is worth dropping in. A 9-minute track is often
  // still beatless 30 s in — measured on the demo crate — so the first cue at
  // or after the target wins, snapped to the phrase grid.
  // Rekordbox exports EVERY position mark, mix-out cues included, so a cue only
  // counts if it leaves at least a minute and a half to play and sits in the
  // first 60% of the track.
  const latest = Math.min(duration - 90, duration * 0.6);
  const cues = Array.isArray(track.cues) ? track.cues.filter(c => typeof c === 'number' && c >= target - phrase / 2 && c <= latest) : [];
  if (cues.length) {
    const at = snap(Math.min(...cues));
    if (at >= 0 && at <= latest) return at;
  }
  const n = Math.max(0, Math.ceil((target - track.anchor) / phrase));
  const at = track.anchor + n * phrase;
  // Never drop so late there's nothing left to listen to.
  return at < duration - 20 ? at : target;
}

function pickHidden() {
  const [lo, hi] = difficulty === 'easy' ? [2, 6] : [0.5, 2.5];
  const mag = lo + Math.random() * (hi - lo);
  return (Math.random() < 0.5 ? -1 : 1) * mag;
}

function startRound(keepPair = false) {
  stopDeck('A'); stopDeck('B');
  let a, b;
  if (keepPair && round) {
    a = tracks.find(t => t.id === round.aId);
    b = tracks.find(t => t.id === round.bId);
  }
  if (!a || !b) {
    const pairs = pairablePairs();
    if (!pairs.length) {
      toast(`No two tracks are within ±${pitchRange}% of each other — add closer BPMs, or tap ×2 to widen the range.`);
      return;
    }
    [a, b] = pairs[Math.floor(Math.random() * pairs.length)];
  }
  const r0 = a.bpm / b.bpm;
  let hidden, needed;
  do {
    hidden = pickHidden();
    needed = (1 / (1 + hidden / 100) - 1) * 100;
  } while (Math.abs(needed) > pitchRange - 0.5);
  round = { aId: a.id, bId: b.id, hidden, r0 };
  for (const id of DECKS) {
    const d = decks[id];
    d.fader = 0; d.nudge = 0; d.rate = 1; d.cuePoint = 0; d.previewing = false;
  }
  renderAllFaders();
  updateButtons();
  loadDeck('A', a);
  loadDeck('B', b);
}

// Deck A is the tempo anchor at rate 1 when its fader sits at 0; r0 pre-matches
// deck B so the fader travel represents the same job it does on the decks.
function rateFor(id) {
  const d = decks[id];
  const own = 1 + (d.fader + d.nudge) / 100;
  if (id === 'A') return own;
  return round.r0 * (1 + round.hidden / 100) * own;
}
// Score is the RELATIVE tempo error between the decks, so moving either fader
// counts. Nudge is excluded: it is a momentary bend, not part of your answer.
function currentErrorPct() {
  const a = 1 + decks.A.fader / 100;
  const b = (1 + round.hidden / 100) * (1 + decks.B.fader / 100);
  return (b / a - 1) * 100;
}
// The BPM the pair is actually running at, which is what the error is measured
// against — deck A's tag scaled by wherever its own fader is sitting.
function effectiveBpmA(track) {
  return track?.bpm ? track.bpm * (1 + decks.A.fader / 100) : null;
}

// ---------- Playback ----------
// AudioBufferSourceNode, not a media element. playbackRate here is an AudioParam:
// riding the fader writes it on every move with zero glitching (measured: 120
// writes, 0 silent frames), where the media element stalled and dropped a pause
// event. It also starts sample-accurately, so no lag between tapping play and
// hearing the track.
//
// The memory that forced the media-element detour is handled by only keeping
// what a round uses: a mono window starting exactly at the phrase start.
//   full track, native rate  216 MB
//   full track, 32 kHz       144 MB   (transient, during decode)
//   180 s mono window         23 MB   (what we hold, per deck)
// Mono costs nothing here — the headphone split pans each deck hard L/R anyway.
const WINDOW_S = 180;

function ensureChain(id) {
  const c = ensureCtx();
  const d = decks[id];
  if (!d.gain) {
    d.gain = c.createGain();
    const bus = ensureMaster().input;
    if (c.createStereoPanner) {
      d.panner = c.createStereoPanner();
      d.gain.connect(d.panner);
      d.panner.connect(bus);
    } else {
      d.gain.connect(bus);            // pre-14.1 Safari: split silently unavailable
    }
    applySplit();
  }
  d.gain.gain.value = deckGain(id);
  if (aids && !d.analyser) attachAnalyser(id);
  return d;
}
function applySplit() {
  for (const id of DECKS) {
    const p = decks[id].panner;
    if (p) p.pan.value = split ? (id === 'A' ? -1 : 1) : 0;
  }
}

// Decode, then immediately keep only a mono window from the phrase start and let
// the full buffer go. Because the window BEGINS on the downbeat, offset 0 is the
// downbeat — playback can't start slightly off it the way a media-element seek
// did. Decodes are sequenced so two full-size buffers never exist at once.
let loadChain = Promise.resolve();
function loadDeck(id, track) {
  const d = decks[id];
  const token = ++d.token;
  d.ready = false;
  d.buffer = null;
  d.offset = 0;
  updateTransport();
  loadChain = loadChain.then(async () => {
    if (d.token !== token) return;                      // a newer round won
    try {
      const c = ensureCtx();
      ensureChain(id);                                  // graph ready before the first press
      const full = await ctx.decodeAudioData(await track.blob.arrayBuffer());
      if (d.token !== token) return;
      const start = Math.floor(phraseStart(track, full.duration) * c.sampleRate);
      // Reuse a pooled buffer. Allocating a fresh ~35 MB Float32Array per deck
      // per round, then dropping it along with the ~150 MB decoded original, is
      // exactly the churn that makes the collector pause the main thread — and a
      // GC pause lands as a 40-135 ms freeze mid-drag. The pool is allocated once.
      const win = windowPool(id, c);
      const out = win.getChannelData(0);
      const L = full.getChannelData(0);
      const R = full.numberOfChannels > 1 ? full.getChannelData(1) : L;
      const avail = Math.max(1, Math.min(win.length, full.length - start));
      for (let i = 0; i < avail; i++) out[i] = (L[start + i] + R[start + i]) * 0.5;
      if (avail < win.length) out.fill(0, avail);       // silence the unused tail
      d.buffer = win;                                   // full buffer drops here
      d.validSeconds = avail / c.sampleRate;
      d.peaks = wavePeaks(out, avail, c.sampleRate);    // for the visual-aids waveform
      d.ready = true;
      updateTransport();
      if (aids) drawWave(id);
    } catch {
      d.ready = false;
      toast(`Deck ${id === 'A' ? 1 : 2}: could not read this track.`);
      updateTransport();
    }
  });
  return loadChain;
}

// One window buffer per deck, allocated once and overwritten in place. Sources
// are always stopped before a reload, so nothing is reading it as we rewrite.
function windowPool(id, c) {
  const d = decks[id];
  const len = Math.floor(WINDOW_S * c.sampleRate);
  if (!d.pool || d.pool.length !== len || d.pool.sampleRate !== c.sampleRate) {
    d.pool = c.createBuffer(1, len, c.sampleRate);
  }
  return d.pool;
}

// Position is tracked against the audio clock. Always mark BEFORE changing rate
// or elapsed audio gets counted at the wrong speed.
function markPosition(id) {
  const d = decks[id];
  if (!d.playing || !ctx) return;
  const now = ctx.currentTime;
  if (now <= d.mark) return;      // scheduled for the future, hasn't started yet
  d.offset += (now - d.mark) * d.rate;
  d.mark = now;
}
function applyRate(id) {
  const d = decks[id];
  if (!round) return;
  markPosition(id);
  d.rate = rateFor(id);
  if (d.source) d.source.playbackRate.value = d.rate;
}

// Press -> start timing for the diagnostics panel: the time from the pointer
// event's timestamp to the audio engine being handed the source. What the
// engine and the hardware add on top is reported next to it from the context.
const audioProfile = { pressToStartMs: null, samples: [] };
let pendingPress = null;                  // event timeStamp of the press in flight
function notePress(e) { pendingPress = e && typeof e.timeStamp === 'number' ? e.timeStamp : performance.now(); }
function noteStarted() {
  if (pendingPress === null) return;
  const ms = performance.now() - pendingPress;
  pendingPress = null;
  audioProfile.samples.push(ms);
  if (audioProfile.samples.length > 20) audioProfile.samples.shift();
  audioProfile.pressToStartMs = ms;
}
function renderAudioProfile() {
  const el = $('audioProfile');
  if (!el) return;
  if (!ctx) { el.textContent = 'Press Play or Cue, then reopen this menu.'; return; }
  const base = ctx.baseLatency != null ? `${(ctx.baseLatency * 1000).toFixed(1)} ms` : '—';
  const out = ctx.outputLatency != null && ctx.outputLatency > 0 ? `${(ctx.outputLatency * 1000).toFixed(1)} ms` : '—';
  const s = audioProfile.samples;
  const worst = s.length ? Math.max(...s) : null;
  el.textContent = `${(ctx.sampleRate / 1000).toFixed(1)} kHz · ${ctx.state}`
    + ` · press → start ${audioProfile.pressToStartMs !== null ? audioProfile.pressToStartMs.toFixed(1) + ' ms' : '—'}`
    + (worst !== null && s.length > 1 ? ` (worst ${worst.toFixed(1)})` : '')
    + ` · engine base ${base} · output ${out}`;
}

function startSource(id, from, when) {
  const c = ensureCtx();
  const d = ensureChain(id);
  if (!d.buffer) return false;
  stopSource(id);
  const src = c.createBufferSource();
  src.buffer = d.buffer;
  src.connect(d.gain);
  d.rate = rateFor(id);
  src.playbackRate.value = d.rate;
  const valid = d.validSeconds || d.buffer.duration;
  const at = Math.max(0, Math.min(from, valid - 0.05));
  const startAt = when || 0;
  src.start(startAt, at, Math.max(0.05, valid - at));   // don't play the zeroed tail
  noteStarted();
  d.source = src;
  d.offset = at;
  d.mark = Math.max(startAt, c.currentTime);
  d.playing = true;
  src.onended = () => {
    if (d.source === src) { d.source = null; d.playing = false; updateTransport(); }
  };
  return true;
}
function stopSource(id) {
  const d = decks[id];
  markPosition(id);
  if (d.source) { d.source.onended = null; try { d.source.stop(); } catch {} d.source = null; }
  d.playing = false;
}

// Drop both decks phase-locked — a FALLBACK, kept in the settings sheet.
//
// Both windows begin exactly on a downbeat, so starting them on the same audio
// clock tick puts the beats in unison and any drift you then hear is the tempo
// error. It is not how decks are started in practice: on CDJs or 1210s you
// start one, then drop the other on its downbeat by ear — which is what the
// per-deck Play and Cue are for, and why their press-to-sound is what's
// optimised (measured 6 ms, two render quanta, on the press itself).
function dropBoth() {
  if (!round) return;
  const c = ensureCtx();
  if (!decks.A.ready || !decks.B.ready) { toast('Still loading the pair…'); return; }
  const when = c.currentTime + 0.12;      // a beat of lead-in so both get scheduled
  for (const id of DECKS) startSource(id, 0, when);
  updateTransport();
}

function playDeck(id) {
  if (!round) return;
  const d = decks[id];
  if (!d.ready) { toast(`Deck ${id === 'A' ? 1 : 2} still loading…`); return; }
  startSource(id, d.offset);
  updateTransport();
}
function stopDeck(id) {
  stopSource(id);
  updateTransport();
}

// Cue, the way it works on a CDJ:
//   playing        -> tap Cue: back-cue, jump to the cue point and stop
//   stopped        -> hold Cue: preview from the cue point
//                     release: snap back to the cue point and stop
// The cue point is offset 0 — the phrase start the window begins on.
function cuePress(id) {
  const d = decks[id];
  if (!round || !d.ready) return;
  if (d.playing && !d.previewing) {
    stopSource(id);
    d.offset = 0;
    updateTransport();
    return;
  }
  d.previewing = true;
  startSource(id, 0);
  updateTransport();
}
function cueRelease(id) {
  const d = decks[id];
  if (!d.previewing) return;
  d.previewing = false;
  stopSource(id);
  d.offset = 0;
  updateTransport();
}

function updateTransport() {
  kickAids();
  for (const id of DECKS) {
    const d = decks[id];
    const btn = $('play' + id);
    btn.classList.toggle('playing', d.playing);
    btn.classList.toggle('loading', !d.ready);
    btn.innerHTML = d.playing ? '&#9632;' : '&#9654;';
    $('cue' + id).classList.toggle('held', d.previewing);
  }
}
// Transport acts on the PRESS. A click event fires on release, so a play button
// bound to click starts the deck a whole tap later — measured 90 ms of the
// 108 ms press-to-sound, with the audio stack accounting for the rest.
// A CDJ starts on the down-stroke; so does this.
for (const id of DECKS) {
  const play = $('play' + id);
  play.addEventListener('pointerdown', e => {
    if (e.button !== 0) return;                   // a mouse's other buttons are not presses
    e.preventDefault();
    notePress(e);
    decks[id].playing ? stopDeck(id) : playDeck(id);
    pendingPress = null;
  });
  play.addEventListener('keydown', e => {
    if (e.repeat) return;
    if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); decks[id].playing ? stopDeck(id) : playDeck(id); }
  });
  const cue = $('cue' + id);
  cue.addEventListener('pointerdown', e => { if (e.button !== 0) return; e.preventDefault(); notePress(e); cuePress(id); pendingPress = null; });
  cue.addEventListener('pointerup', () => cueRelease(id));
  cue.addEventListener('pointercancel', () => cueRelease(id));
  cue.addEventListener('pointerleave', () => cueRelease(id));
}

// ---------- Visual aids (Beatmatch PRO parity) ----------
// Off by default and off means OFF: no analyser in the graph, no animation
// loop, the elements hidden. On, each channel gets a level meter, a scrolling
// waveform around the playhead and its track's tagged BPM, and the reveal adds
// a score out of 100 with stars. Beatmatch PRO shows meters, waveforms and
// track BPM data; its exact score formula isn't public, so the percentage here
// is an approximation: 100 minus 20 per BPM of error, five stars under 0.5.
const WAVE_BIN_S = 0.005;          // peak per 5 ms
const WAVE_SPAN_S = 4;             // seconds of waveform visible
function wavePeaks(data, n, sr) {
  const bin = Math.max(1, Math.round(WAVE_BIN_S * sr));
  const out = new Float32Array(Math.ceil(n / bin));
  for (let b = 0; b < out.length; b++) {
    let p = 0;
    const end = Math.min(n, (b + 1) * bin);
    for (let i = b * bin; i < end; i++) { const a = data[i] < 0 ? -data[i] : data[i]; if (a > p) p = a; }
    out[b] = p;
  }
  return out;
}
function attachAnalyser(id) {
  const d = decks[id];
  if (d.analyser || !d.gain) return;
  d.analyser = ctx.createAnalyser();
  d.analyser.fftSize = 512;
  d.analyser.smoothingTimeConstant = 0;
  d.gain.connect(d.analyser);
  d.analyserBuf = new Float32Array(d.analyser.fftSize);
}
function detachAnalyser(id) {
  const d = decks[id];
  if (!d.analyser) return;
  try { d.gain.disconnect(d.analyser); } catch {}
  d.analyser = null; d.analyserBuf = null;
}
const meterLevel = { A: 0, B: 0 };
let aidsRaf = null;
function playheadSeconds(id) {
  const d = decks[id];
  if (!d.playing || !ctx) return d.offset;
  const now = ctx.currentTime;
  return d.offset + Math.max(0, now - d.mark) * d.rate;
}
function drawWave(id) {
  const cv = $('wave' + id), d = decks[id];
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const m = wavePx[id];
  const cw = m ? m.w : 0, ch = m ? m.h : 0;
  if (!cw || !ch) return;
  if (cv.width !== Math.round(cw * dpr) || cv.height !== Math.round(ch * dpr)) { cv.width = Math.round(cw * dpr); cv.height = Math.round(ch * dpr); }
  const g = cv.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, cw, ch);
  const track = round && tracks.find(t => t.id === (id === 'A' ? round.aId : round.bId));
  if (d.peaks && d.buffer) {
    const pos = playheadSeconds(id);
    const binsPerPx = (WAVE_SPAN_S / WAVE_BIN_S) / cw;
    const firstBin = (pos - WAVE_SPAN_S / 2) / WAVE_BIN_S;
    const mid = ch / 2;
    g.fillStyle = '#4a5160';
    for (let x = 0; x < cw; x++) {
      let p = 0;
      const b0 = Math.floor(firstBin + x * binsPerPx), b1 = Math.floor(firstBin + (x + 1) * binsPerPx);
      for (let b = b0; b <= b1; b++) if (b >= 0 && b < d.peaks.length && d.peaks[b] > p) p = d.peaks[b];
      if (p > 0) { const h = Math.max(1, p * (ch - 6)); g.fillRect(x, mid - h / 2, 1, h); }
    }
    // Beat grid ticks: every beat from offset 0 (the downbeat), bar lines brighter.
    if (track?.bpm) {
      const beat = 60 / track.bpm;
      const t0 = pos - WAVE_SPAN_S / 2, t1 = pos + WAVE_SPAN_S / 2;
      for (let i = Math.max(0, Math.ceil(t0 / beat)); i * beat <= t1; i++) {
        const x = ((i * beat - t0) / WAVE_SPAN_S) * cw;
        g.fillStyle = i % 4 === 0 ? '#8a919e' : '#3a3f4a';
        g.fillRect(Math.round(x), 0, 1, i % 4 === 0 ? ch : 6);
      }
    }
    g.fillStyle = '#ff4a3c';
    g.fillRect(Math.round(cw / 2) - 1, 0, 2, ch);
  }
  g.font = '600 10px "IBM Plex Mono", monospace';
  g.fillStyle = '#f0b429';
  g.textBaseline = 'top';
  g.fillText(track?.bpm ? `${track.bpm.toFixed(2)} BPM` : '— BPM', 4, 3);
}
function drawMeters() {
  for (const id of DECKS) {
    const d = decks[id];
    let peak = 0;
    if (d.analyser && d.playing) {
      d.analyser.getFloatTimeDomainData(d.analyserBuf);
      for (let i = 0; i < d.analyserBuf.length; i++) { const a = Math.abs(d.analyserBuf[i]); if (a > peak) peak = a; }
    }
    // Fast attack, slow release — the ballistics of a bouncing meter.
    meterLevel[id] = peak > meterLevel[id] ? peak : meterLevel[id] * 0.9;
    const db = 20 * Math.log10(Math.max(1e-4, meterLevel[id]));
    const frac = Math.max(0, Math.min(1, (db + 40) / 40));       // -40 dB..0 dB
    $('meterMask' + id).style.transform = `scaleY(${(1 - frac).toFixed(3)})`;
  }
}
function aidsFrame() {
  aidsRaf = null;
  if (!aids) return;
  drawMeters();
  for (const id of DECKS) drawWave(id);
  if (DECKS.some(id => decks[id].playing) || DECKS.some(id => meterLevel[id] > 0.001)) aidsRaf = requestAnimationFrame(aidsFrame);
}
function kickAids() {
  if (!aids || aidsRaf !== null) return;
  aidsRaf = requestAnimationFrame(aidsFrame);
}
function setAids(on) {
  aids = on;
  [...$('aidsSeg').children].forEach(b => b.classList.toggle('on', (b.dataset.aids === 'on') === on));
  for (const id of DECKS) {
    $('wave' + id).hidden = !on;
    $('meter' + id).hidden = !on;
    if (on) { if (decks[id].gain) attachAnalyser(id); } else detachAnalyser(id);
  }
  if (on) { measureFaders(); renderAllFaders(); kickAids(); }
  else { if (aidsRaf !== null) { cancelAnimationFrame(aidsRaf); aidsRaf = null; } measureFaders(); renderAllFaders(); }
}
// Score out of 100 and stars for the reveal, Beatmatch PRO style (approximation).
function parityScore(absBpm) {
  const pct = Math.max(0, 100 - 20 * absBpm);
  const stars = absBpm < 0.5 ? 5 : absBpm < 1 ? 4 : absBpm < 2 ? 3 : absBpm < 4 ? 2 : 1;
  return { pct, stars };
}

// ---------- Fader ----------
// ±8% is the SL-1210 range and stays the default. ×2 opens it to ±16% for the
// times a pair genuinely needs more room; it does not change the hidden offset,
// so rounds are no easier — it only buys headroom.
const BASE_RANGE = 8;
// Zero detent, like the 1210's centre click. Sized in BPM, not percent: snapping
// home must never introduce more than DETENT_BPM of tempo error, and 0.1 BPM is
// the accuracy being trained for. A fixed percentage can't promise that — 0.12%
// is 0.15 BPM at 126 and 0.21 BPM at 174.
const DETENT_BPM = 0.09;
const FALLBACK_BPM = 128;
function detentPct() {
  const a = round && tracks.find(t => t.id === round.aId);
  return (DETENT_BPM / (a?.bpm || FALLBACK_BPM)) * 100;
}

function buildScale(id) {
  const scale = $('faderScale' + id);
  scale.innerHTML = '';
  const step = pitchRange / 4;
  for (let v = -pitchRange; v <= pitchRange; v += step) {
    const tick = document.createElement('div');
    tick.className = 'fader-tick' + (v === 0 ? ' zero' : '');
    // Technics orientation: minus at the top, plus at the bottom. Pulling the
    // fader toward you speeds the deck up — opposite to a CDJ. See PITCH_FLIP.
    tick.style.top = `${((v + pitchRange) / (pitchRange * 2)) * 100}%`;
    if (v % (step * 2) === 0) {
      const n = document.createElement('span');
      n.className = 'tick-num';
      n.textContent = v > 0 ? `+${v}` : `${v}`;
      tick.appendChild(n);
    }
    scale.appendChild(tick);
  }
}
function setPitchRange(range) {
  pitchRange = range;
  const btn = $('rangeBtn');
  btn.textContent = `±${pitchRange}%`;
  btn.classList.toggle('wide', pitchRange > BASE_RANGE);
  btn.setAttribute('aria-pressed', String(pitchRange > BASE_RANGE));
  for (const id of DECKS) {
    decks[id].fader = Math.max(-pitchRange, Math.min(pitchRange, decks[id].fader));
    buildScale(id);
    renderPitch(id);
    applyRate(id);
  }
  updateButtons();
}

// Fader pixel sizes are measured once per layout change, not per pointermove:
// reading clientHeight/offsetHeight mid-drag forces a synchronous layout on
// every frame, which is most of what "lags terribly" was.
const faderPx = { A: null, B: null, xf: null };
const wavePx = { A: null, B: null };
function measureFaders() {
  for (const id of DECKS) {
    faderPx[id] = {
      pitchH: $('faderTrack' + id).clientHeight,
      pitchKnob: $('faderKnob' + id).offsetHeight,
    };
    // The waveform canvas is measured here too, never in the frame loop: a
    // clientWidth read per frame would force layout during every fader drag.
    const cv = $('wave' + id);
    wavePx[id] = { w: cv.clientWidth, h: cv.clientHeight };
  }
  faderPx.xf = { w: $('xfTrack').clientWidth, knob: $('xfKnob').offsetWidth };
}

function renderPitch(id) {
  const d = decks[id];
  const knob = $('faderKnob' + id);
  if (!faderPx[id]) measureFaders();
  const m = faderPx[id];
  const h = m.pitchH - m.pitchKnob;
  knob.style.transform = `translate3d(0, ${((d.fader + pitchRange) / (pitchRange * 2)) * h}px, 0)`;
  const shown = d.fader + d.nudge;
  const readout = $('pitchReadout' + id);
  readout.textContent = `${shown >= 0 ? '+' : ''}${shown.toFixed(2)}%`;
  // Lamp means "at zero to within the accuracy you're training for" — it reports
  // rather than snaps, so it never fights fine positioning.
  const atZero = Math.abs(d.fader) <= detentPct();
  readout.classList.toggle('detent', atZero);
  $('zeroLed' + id).classList.toggle('lit', atZero);
}
function renderXfade() {
  if (!faderPx.xf) measureFaders();
  const m = faderPx.xf;
  $('xfKnob').style.transform = `translate3d(${xfade * (m.w - m.knob)}px, 0, 0)`;
}
function renderAllFaders() {
  measureFaders();
  for (const id of DECKS) renderPitch(id);
  renderXfade();
}

// One drag handler for every vertical fader.
//
// Pitch faders support fine-drag: slide sideways away from the fader while
// dragging and vertical movement is scaled down, the way a DAW fader behaves.
// Needed because 0.1 BPM is ~2px of raw travel — too fine for a fingertip.
// Movement is integrated incrementally rather than recomputed from the anchor,
// so changing the scale mid-drag doesn't make the knob jump.
// A thumb moving "straight" down wanders 20-40 px sideways on its own, and on
// the phone that read as "the knob moves less than my thumb" — fine mode was
// engaging uninvited. The first FINE_DEADZONE px of sideways travel do nothing;
// the falloff starts beyond it, so deliberate fine control is unchanged.
const FINE_DEADZONE = 36;     // px of sideways drift ignored
const FINE_FALLOFF = 30;      // px beyond the dead zone to halve sensitivity
function fineFactor(dx) {
  const d = Math.max(0, Math.abs(dx) - FINE_DEADZONE);
  return 1 / (1 + d / FINE_FALLOFF);
}

// Faders drag RELATIVELY: pressing anywhere anchors, and only movement changes
// the value. The old code jumped the value to wherever you touched, which made
// small corrections impossible — you could never rest a thumb without throwing
// the setting. The whole track stays grabbable, so there's no fiddly knob-sized
// target to hit, but nothing moves until you move.
// ---------- Touch profiler ----------
// Every latency number so far came from a desktop harness, which is not the
// input pipeline a phone uses. This records what actually happens during a real
// drag on the real device so the next fix is aimed at measured behaviour.
const dragProfiler = {
  times: [], self: [], frames: 0, rafId: null, last: null,
  fingerPx: 0, knobPx: 0, maxDx: 0, minFine: 1,
  // Finger travel vs knob travel for the last drag, so "the knob moves less
  // than my thumb" can be read as a ratio on the device instead of guessed at.
  travel(fingerDelta, knobDelta, dx, fine) {
    this.fingerPx += Math.abs(fingerDelta); this.knobPx += Math.abs(knobDelta);
    if (Math.abs(dx) > this.maxDx) this.maxDx = Math.abs(dx);
    if (fine < this.minFine) this.minFine = fine;
  },
  sample(selfMs) {
    const t = performance.now();
    if (this.last !== null) this.times.push(t - this.last);
    if (selfMs !== undefined) this.self.push(selfMs);
    this.last = t;
    if (this.rafId === null) {
      this.frames = 0;
      const tick = () => { this.frames++; this.rafId = requestAnimationFrame(tick); };
      this.rafId = requestAnimationFrame(tick);
    }
  },
  finish() {
    if (this.rafId !== null) { cancelAnimationFrame(this.rafId); this.rafId = null; }
    const g = this.times.slice(), sf = this.self.slice();
    const travel = { fingerPx: Math.round(this.fingerPx), knobPx: Math.round(this.knobPx), maxDx: Math.round(this.maxDx), minFine: +this.minFine.toFixed(2) };
    this.times = []; this.self = []; this.last = null;
    this.fingerPx = 0; this.knobPx = 0; this.maxDx = 0; this.minFine = 1;
    if (g.length < 5) return;
    const sorted = [...g].sort((a, b) => a - b);
    const med = sorted[Math.floor(sorted.length / 2)];
    const worst = sorted[sorted.length - 1];
    const span = g.reduce((a, b) => a + b, 0);
    this.lastReport = {
      moves: g.length + 1,
      hz: med > 0 ? Math.round(1000 / med) : null,
      medianGapMs: +med.toFixed(1),
      worstGapMs: +worst.toFixed(1),
      stalls: g.filter(x => x > 40).length,
      fps: span > 0 ? Math.round(this.frames / (span / 1000)) : 0,
      handlerMaxMs: sf.length ? +Math.max(...sf).toFixed(2) : null,
      ...travel,
    };
    renderProfile();
  },
  lastReport: null,
};
function renderProfile() {
  const el = $('touchProfile');
  if (!el) return;
  const r = dragProfiler.lastReport;
  el.textContent = r
    ? `${r.moves} moves · ${r.hz ? r.hz + ' Hz' : '—'} touch · ${r.fps} fps · `
      + `median gap ${r.medianGapMs} ms · worst ${r.worstGapMs} ms · ${r.stalls} stalls >40 ms`
      + (r.handlerMaxMs !== null ? ` · our handler max ${r.handlerMaxMs} ms` : '')
      + ` · finger ${r.fingerPx} px → knob ${r.knobPx} px · sideways max ${r.maxDx} px · fine min ×${r.minFine}`
    : 'Drag a pitch fader, then reopen this menu.';
}

// Grab the KNOB, and it stays under your thumb.
//
// Two earlier models were both wrong. Jump-to-finger threw the value wherever
// you touched, so small corrections were impossible. Relative-from-anywhere
// fixed that but broke the physical illusion: the knob drifted away from the
// finger until you were dragging at the top of the fader while the knob sat at
// the bottom, which is what "the behaviour is terrible" meant.
//
// A real fader has one grab point. Press within the knob (plus generous slop for
// a thumb) and it tracks 1:1 from wherever you took hold; press the bare track
// and nothing happens, exactly like the plinth of a 1210.
const GRAB_SLOP = 28;          // px of extra hit area around the knob
// axis 'y' for the vertical pitch faders, 'x' for the crossfader. Fine-drag
// only makes sense on a vertical fader (sideways distance scales it).
function bindFader(track, knob, { get, set, fine = false, onFine = null, axis = 'y' }) {
  let dragging = false, grabOffset = 0, virtual = 0, last = 0, box = null, pendingFine = 1;
  const vertical = axis === 'y';
  const along = e => vertical ? e.clientY : e.clientX;
  const across = e => vertical ? e.clientX : e.clientY;

  track.addEventListener('pointerdown', e => {
    // Geometry read once per drag; reading per move forces a layout a frame.
    const rect = track.getBoundingClientRect();
    const kh = vertical ? knob.offsetHeight : knob.offsetWidth;
    const usable = (vertical ? rect.height : rect.width) - kh;
    const knobStart = get() * usable;
    const p = along(e) - (vertical ? rect.top : rect.left);
    if (p < knobStart - GRAB_SLOP || p > knobStart + kh + GRAB_SLOP) return;   // missed it
    dragging = true;
    try { track.setPointerCapture(e.pointerId); } catch {}
    box = { usable, startAcross: across(e) };
    grabOffset = p - knobStart;    // keeps the knob where you took hold of it
    virtual = p;
    last = along(e);
    pendingFine = 1;
    knob.classList.add('grabbed');
  });

  track.addEventListener('pointermove', e => {
    if (!dragging || !box) return;
    const t0 = performance.now();
    pendingFine = fine ? fineFactor(across(e) - box.startAcross) : 1;
    // At full sensitivity the virtual position tracks the finger exactly, so
    // the knob sits under it. Fine mode lets it lag deliberately — standard
    // DAW behaviour.
    const fingerDelta = along(e) - last;
    virtual += fingerDelta * pendingFine;
    last = along(e);
    const prevKnob = get() * box.usable;
    const knobStart = Math.max(0, Math.min(box.usable, virtual - grabOffset));
    virtual = knobStart + grabOffset;                // clamp without wind-up
    set(box.usable ? knobStart / box.usable : 0);
    dragProfiler.travel(fingerDelta, knobStart - prevKnob, across(e) - box.startAcross, pendingFine);
    if (onFine) onFine(pendingFine);
    dragProfiler.sample(performance.now() - t0);
  });

  const end = () => {
    if (!dragging) return;
    dragging = false; box = null;
    knob.classList.remove('grabbed');
    if (onFine) onFine(1);
    dragProfiler.finish();
  };
  track.addEventListener('pointerup', end);
  track.addEventListener('pointercancel', end);
}

for (const id of DECKS) {
  bindFader($('faderTrack' + id), $('faderKnob' + id), {
    get: () => (decks[id].fader + pitchRange) / (pitchRange * 2),
    set: frac => {
      decks[id].fader = +(frac * pitchRange * 2 - pitchRange).toFixed(3);
      renderPitch(id);
      applyRate(id);      // AudioParam write — safe on every move, no glitch
    },
    fine: true,
    onFine: f => $('pitchReadout' + id).classList.toggle('fine', f < 0.9),
  });
}
let xfadeSaveTimer = null;
bindFader($('xfTrack'), $('xfKnob'), {
  axis: 'x',
  get: () => xfade,
  set: frac => {
    xfade = frac;
    renderXfade();
    applyXfade();
    clearTimeout(xfadeSaveTimer);
    xfadeSaveTimer = setTimeout(() => db.setSetting('xfade', xfade).catch(() => {}), 400);
  },
});

// ---------- Nudge ----------
// Momentary tempo bend, like a thumb on the platter. 1% was too weak to pull a
// drifting deck back; the buttons are labelled with the value so it's explicit.
const NUDGE_PCT = 2.0;
function bindNudge(btn, id, amount) {
  const start = e => {
    e.preventDefault();
    decks[id].nudge = amount;
    btn.classList.add('held');
    renderPitch(id); applyRate(id);
  };
  const end = () => {
    decks[id].nudge = 0;
    btn.classList.remove('held');
    renderPitch(id); applyRate(id);
  };
  btn.addEventListener('pointerdown', start);
  btn.addEventListener('pointerup', end);
  btn.addEventListener('pointercancel', end);
  btn.addEventListener('pointerleave', end);
}
for (const id of DECKS) {
  bindNudge($('nudgeUp' + id), id, NUDGE_PCT);
  bindNudge($('nudgeDown' + id), id, -NUDGE_PCT);
}

// ---------- Reveal ----------
let revealing = false;
revealBtn.addEventListener('click', async () => {
  if (!round || revealing) return;
  revealing = true;                 // the IDB write below is awaited; a double tap must not save twice
  stopDeck('A'); stopDeck('B');
  const err = currentErrorPct();
  const absErr = Math.abs(err);
  const a = tracks.find(t => t.id === round.aId), b = tracks.find(t => t.id === round.bId);
  // Measured against the tempo the pair was actually running at: deck 1's tag
  // scaled by its own fader, since that fader is live now too.
  const bpmA = effectiveBpmA(a);
  const errBpm = bpmA ? bpmA * err / 100 : null;
  const absBpm = errBpm !== null ? Math.abs(errBpm) : null;
  sessionHistory.push({ err, errBpm });
  await db.saveRound({ err, errBpm, mode, difficulty, pitchRange,
                       faderA: decks.A.fader, faderB: decks.B.fader,
                       aName: a?.name, bName: b?.name }).catch(() => {});
  const sEl = $('revealScore');
  if (absBpm !== null) {
    sEl.textContent = absBpm.toFixed(2);
    $('revealSub').textContent = 'BPM off';
    sEl.className = 'reveal-score ' + (absBpm <= 0.05 ? 'good' : absBpm <= 0.3 ? 'mid' : 'bad');
  } else {
    sEl.textContent = absErr.toFixed(2) + '%';
    $('revealSub').textContent = 'tempo off (no BPM tagged for deck 1)';
    sEl.className = 'reveal-score ' + (absErr <= 0.05 ? 'good' : absErr <= 0.25 ? 'mid' : 'bad');
  }
  const parity = $('revealParity');
  if (aids && absBpm !== null) {
    const { pct, stars } = parityScore(absBpm);
    parity.innerHTML = `Score ${pct.toFixed(0)}% · <span class="stars">${'★'.repeat(stars)}${'☆'.repeat(5 - stars)}</span>`;
    parity.hidden = false;
  } else parity.hidden = true;
  const dir = err > 0 ? 'fast' : 'slow';
  const sign = v => `${v >= 0 ? '+' : ''}${v.toFixed(2)}`;
  // With both faders live the answer is a relationship, not a single position:
  // deck 2 has to sit wherever cancels the hidden offset relative to deck 1.
  const correctB = ((1 + decks.A.fader / 100) / (1 + round.hidden / 100) - 1) * 100;
  const lockNote = (absBpm !== null ? absBpm <= 0.05 : absErr <= 0.05);
  $('revealDetail').innerHTML =
    `<span>Deck 2 was</span> ${lockNote ? '<span>locked in</span>' : `running ${dir}`} ` +
    (absBpm !== null ? `<span>(${absErr.toFixed(2)}% at ${bpmA.toFixed(2)} BPM)</span>` : '') + ` ·
     <span>hidden offset</span> ${sign(round.hidden)}% ·
     <span>your faders</span> 1: ${sign(decks.A.fader)}% / 2: ${sign(decks.B.fader)}% ·
     <span>deck 2 needed</span> ${sign(correctB)}%`;
  const row = $('strobeRow');
  row.innerHTML = '';
  for (let i = 0; i < 30; i++) { const dot = document.createElement('div'); dot.className = 'strobe-dot'; row.appendChild(dot); }
  row.classList.toggle('locked', absErr <= 0.1);
  const driftDur = absErr <= 0.02 ? 0 : Math.max(0.4, 3 / absErr);
  row.style.animation = driftDur ? `strobeDrift ${driftDur}s linear infinite ${err > 0 ? '' : 'reverse'}` : 'none';
  $('strobeCaption').textContent = absErr <= 0.1 ? 'Strobe dots frozen — beat locked' : `Dots drifting ${dir} at your error rate`;
  overlay.classList.add('show');
  revealing = false;
  renderHistory();
  renderStats();
});

$('retryBtn').addEventListener('click', () => { overlay.classList.remove('show'); startRound(true); });
$('nextBtn').addEventListener('click', () => { overlay.classList.remove('show'); startRound(false); });
newPairBtn.addEventListener('click', () => startRound(false));

async function renderHistory() {
  const panel = $('historyPanel');
  panel.style.display = 'block';
  const list = $('historyList');
  list.innerHTML = '';
  const fmt = h => h.errBpm !== null && h.errBpm !== undefined
    ? `${Math.abs(h.errBpm).toFixed(2)} BPM`
    : `${Math.abs(h.err).toFixed(2)}%`;
  [...sessionHistory].reverse().slice(0, 12).forEach((h, i) => {
    const row = document.createElement('div');
    row.className = 'history-row';
    row.innerHTML = `<span>Round ${sessionHistory.length - i}</span><span>${(h.err > 0 ? 'fast' : 'slow')}</span><b>${fmt(h)} off</b>`;
    list.appendChild(row);
  });
  const withBpm = sessionHistory.filter(h => h.errBpm !== null && h.errBpm !== undefined);
  let statTail = '';
  if (withBpm.length) {
    const avg = withBpm.reduce((s, h) => s + Math.abs(h.errBpm), 0) / withBpm.length;
    const best = Math.min(...withBpm.map(h => Math.abs(h.errBpm)));
    statTail = ` · Avg <b>${avg.toFixed(2)}</b> · Best <b>${best.toFixed(2)}</b> BPM off`;
  }
  const all = await db.getRounds().catch(() => []);
  const allTime = all.length > sessionHistory.length ? ` · All-time <b>${all.length}</b> rounds` : '';
  $('sessionStat').innerHTML = `Rounds <b>${sessionHistory.length}</b>${statTail}${allTime}`;
}

// ---------- Progress (stats page, roadmap 5) ----------
// Reads the rounds store every time the sheet opens. One series — BPM off per
// round, oldest to newest — so no legend; dots carry the reveal's status colour
// (position on the axis is the real encoding) and a rolling median in neutral
// ink is the trend. Difficulty is a filter, not a second series. Everything
// is plain SVG built here; no chart library, in keeping with no dependencies.
let statsFilter = 'all';
let statsAsTable = false;
let statsRows = [];
const bandOf = abs => abs <= 0.05 ? 'good' : abs <= 0.3 ? 'mid' : 'bad';
function rollingMedian(xs, win) {
  const out = [];
  for (let i = 0; i < xs.length; i++) {
    const w = xs.slice(Math.max(0, i - win + 1), i + 1).sort((a, b) => a - b);
    out.push(w[w.length >> 1]);
  }
  return out;
}
async function renderStats() {
  const panel = $('statsPanel');
  const all = (await db.getRounds(5000).catch(() => [])).filter(r => typeof r.errBpm === 'number' && isFinite(r.errBpm));
  panel.style.display = all.length ? 'block' : 'none';
  if (!all.length) return;
  statsRows = all;
  const rows = statsFilter === 'all' ? all : all.filter(r => r.difficulty === statsFilter);
  const abs = rows.map(r => Math.abs(r.errBpm));
  $('kpiRounds').textContent = String(rows.length);
  $('kpiBest').textContent = abs.length ? Math.min(...abs).toFixed(2) : '—';
  const last20 = abs.slice(-20).sort((a, b) => a - b);
  $('kpiMedian').textContent = last20.length ? last20[last20.length >> 1].toFixed(2) : '—';
  $('kpiLocked').textContent = abs.length ? `${Math.round(100 * abs.filter(a => a <= 0.05).length / abs.length)}%` : '—';
  renderStatsTable(rows);
  renderStatsChart(rows, abs);
}
function renderStatsTable(rows) {
  const t = $('statsTable');
  t.hidden = !statsAsTable;
  $('statsChart').style.display = statsAsTable ? 'none' : 'block';
  if (!statsAsTable) return;
  t.innerHTML = '';
  [...rows].reverse().slice(0, 100).forEach(r => {
    const row = document.createElement('div');
    row.className = 'history-row';
    const d = new Date(r.at);
    // textContent, not innerHTML: names are filenames the user picked.
    const who = document.createElement('span');
    who.textContent = `${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} · ${r.aName || '?'} / ${r.bName || '?'}`;
    const how = document.createElement('span');
    how.textContent = `${r.difficulty === 'hard' ? 'fine' : 'wide'} ±${r.pitchRange || 8}`;
    const val = document.createElement('b');
    val.textContent = Math.abs(r.errBpm).toFixed(2);
    row.append(who, how, val);
    t.appendChild(row);
  });
}
function renderStatsChart(rows, abs) {
  const wrap = $('statsChart');
  wrap.innerHTML = '';
  $('statsTip').hidden = true;
  if (rows.length < 2) { wrap.innerHTML = '<div class="chart-empty">Reveal a couple of rounds and the trend appears here.</div>'; return; }
  const W = 320, H = 150, padL = 30, padR = 8, padT = 8, padB = 18;
  const sorted = [...abs].sort((a, b) => a - b);
  const p90 = sorted[Math.floor(sorted.length * 0.9)];
  const cap = Math.min(2, Math.max(0.3, Math.ceil(p90 * 10) / 10));     // y-axis top; outliers pinned there, hollow
  const x = i => padL + (rows.length === 1 ? 0 : (i / (rows.length - 1)) * (W - padL - padR));
  const y = v => padT + (1 - Math.min(v, cap) / cap) * (H - padT - padB);
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', `BPM off per round, ${rows.length} rounds`);
  const el = (tag, attrs, parent = svg) => { const e = document.createElementNS(ns, tag); for (const k in attrs) e.setAttribute(k, attrs[k]); parent.appendChild(e); return e; };
  // Grid: the two reveal thresholds and the cap, labelled on the left.
  for (const v of [0.05, 0.3, cap].filter(v => v <= cap)) {
    el('line', { class: 'grid', x1: padL, x2: W - padR, y1: y(v), y2: y(v) });
    const t = el('text', { class: 'axis-t', x: padL - 4, y: y(v) + 3, 'text-anchor': 'end' }); t.textContent = v.toFixed(2);
  }
  el('line', { class: 'grid', x1: padL, x2: W - padR, y1: y(0), y2: y(0) });
  // Date ticks: first, last, and month boundaries in between (at most ~4).
  const fmt = ts => new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  const ticks = [0, rows.length - 1];
  const tFirst = el('text', { class: 'axis-t', x: x(0), y: H - 5, 'text-anchor': 'start' }); tFirst.textContent = fmt(rows[0].at);
  if (rows.length > 1 && fmt(rows[rows.length - 1].at) !== fmt(rows[0].at)) {
    const tLast = el('text', { class: 'axis-t', x: x(rows.length - 1), y: H - 5, 'text-anchor': 'end' }); tLast.textContent = fmt(rows[rows.length - 1].at);
  }
  // Rolling median line.
  const med = rollingMedian(abs, 10);
  el('path', { class: 'median', d: med.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ') });
  // Dots with generous hit targets; tap/hover shows the pair.
  const tip = $('statsTip');
  const show = (i, cx, cy) => {
    const r = rows[i];
    tip.textContent = '';
    const head = document.createElement('b'); head.textContent = `${Math.abs(r.errBpm).toFixed(2)} BPM off`;
    tip.append(head, ` · ${r.errBpm > 0 ? 'fast' : 'slow'}`, document.createElement('br'),
               `${fmt(r.at)} · ${r.difficulty === 'hard' ? 'fine' : 'wide'} offset ±${r.pitchRange || 8}`, document.createElement('br'),
               r.aName || '?', document.createElement('br'), r.bName || '?');
    tip.hidden = false;
    // Positioned within #statsPanel (position: relative), above and near the dot.
    const wr = wrap.getBoundingClientRect(), sx = wr.width / W;
    const left = Math.max(0, Math.min(wrap.offsetLeft + wr.width - 224, wrap.offsetLeft + cx * sx - 60));
    tip.style.left = `${left}px`;
    tip.style.top = `${Math.max(0, wrap.offsetTop + cy * sx - 70)}px`;
    svg.querySelectorAll('.dot.active').forEach(d => d.classList.remove('active'));
    svg.querySelector(`.dot[data-i="${i}"]`)?.classList.add('active');
  };
  rows.forEach((r, i) => {
    const a = Math.abs(r.errBpm), capped = a > cap;
    const cx = x(i), cy = y(a);
    el('circle', { class: `dot ${capped ? 'capped' : bandOf(a)}`, cx: cx.toFixed(1), cy: cy.toFixed(1), r: 3.5, 'data-i': i });
    const hit = el('circle', { class: 'hit', cx: cx.toFixed(1), cy: cy.toFixed(1), r: 10 });
    hit.addEventListener('pointerenter', () => show(i, cx, cy));
    hit.addEventListener('pointerdown', e => { e.stopPropagation(); show(i, cx, cy); });
  });
  svg.addEventListener('pointerleave', () => { tip.hidden = true; svg.querySelectorAll('.dot.active').forEach(d => d.classList.remove('active')); });
  wrap.appendChild(svg);
}
$('statsSeg').addEventListener('click', e => {
  const btn = e.target.closest('button'); if (!btn) return;
  statsFilter = btn.dataset.stats;
  [...$('statsSeg').children].forEach(b => b.classList.toggle('on', b === btn));
  renderStats();
});
$('statsTableBtn').addEventListener('click', () => {
  statsAsTable = !statsAsTable;
  $('statsTableBtn').setAttribute('aria-pressed', String(statsAsTable));
  renderStats();
});

// ---------- Settings ----------
$('diffSeg').addEventListener('click', e => {
  const btn = e.target.closest('button'); if (!btn) return;
  difficulty = btn.dataset.diff;
  [...$('diffSeg').children].forEach(b => b.classList.toggle('on', b === btn));
});
$('aidsSeg').addEventListener('click', e => {
  const btn = e.target.closest('button'); if (!btn) return;
  setAids(btn.dataset.aids === 'on');
  db.setSetting('aids', aids).catch(() => {});
});
$('splitSeg').addEventListener('click', e => {
  const btn = e.target.closest('button'); if (!btn) return;
  setSplit(btn.dataset.split === 'on');
  db.setSetting('split', split).catch(() => {});
  if (split && ctx && !ctx.createStereoPanner) toast('This browser has no stereo panner — split unavailable.');
});
$('rangeBtn').addEventListener('click', () => {
  setPitchRange(pitchRange > BASE_RANGE ? BASE_RANGE : BASE_RANGE * 2);
  db.setSetting('pitchRange', pitchRange).catch(() => {});
});
function setSplit(on) {
  split = on;
  [...$('splitSeg').children].forEach(b => b.classList.toggle('on', (b.dataset.split === 'on') === on));
  applySplit();
}

function updateButtons() {
  newPairBtn.disabled = !canStart();
  revealBtn.disabled = !round;
  $('dropBtn').disabled = !round;
}

// ---------- Crate & settings sheet ----------
function openSheet(on) {
  $('sheet').classList.toggle('show', on);
  $('menuBtn').setAttribute('aria-expanded', String(on));
}
$('detectBtn').addEventListener('click', async () => {
  const btn = $('detectBtn');
  btn.disabled = true;
  const before = tracks.filter(t => !t.bpm).length;
  await detectMissingBPMs();
  const after = tracks.filter(t => !t.bpm).length;
  btn.disabled = false;
  toast(before - after > 0
    ? `Detected BPM for ${before - after} track${before - after > 1 ? 's' : ''}.`
    : 'Could not detect a tempo — type it in instead.');
});
$('dropBtn').addEventListener('click', () => { if (!round) return; openSheet(false); dropBoth(); });
$('focusBtn').addEventListener('click', () => {
  setBeatFocus(!beatFocus);
  db.setSetting('beatFocus', beatFocus).catch(() => {});
});
$('menuBtn').addEventListener('click', () => { renderProfile(); renderAudioProfile(); renderStats(); openSheet(true); });
$('sheetClose').addEventListener('click', () => openSheet(false));
document.addEventListener('keydown', e => { if (e.key === 'Escape') openSheet(false); });

// ---------- Service worker ----------
// Bump alongside sw.js CACHE. Shown in the sheet so "which build am I running?"
// is answerable from the phone instead of guessed at.
const APP_BUILD = 'bmt-v20';

function registerSW() {
  if (!('serviceWorker' in navigator)) return;
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloading) return;
    reloading = true;
    location.reload();
  });
  navigator.serviceWorker.register('./sw.js', { updateViaCache: 'none' })
    .then(reg => {
      reg.update().catch(() => {});
      // Resuming an iOS home-screen app doesn't navigate, so nothing would
      // otherwise check for a new build.
      document.addEventListener('visibilitychange', () => {
        if (!document.hidden) reg.update().catch(() => {});
      });
      $('forceUpdate').addEventListener('click', async () => {
        try {
          await reg.update();
          const waiting = reg.waiting || reg.installing;
          if (waiting) { toast('New build found — reloading…'); waiting.postMessage('skipWaiting'); }
          else toast(`You're on the latest build (${APP_BUILD}).`);
        } catch { toast('Could not reach the network to check.'); }
      });
    })
    .catch(() => {});
}

// ---------- Harness hook ----------
// Read-only handles for tools/harness: the browser tests tap the master bus to
// measure press-to-sound and beat alignment against the audio clock. Nothing in
// the app reads this.
window.__bmt = {
  get ctx() { return ctx; }, get master() { return master; }, get round() { return round; },
  get tracks() { return tracks; }, get xfade() { return xfade; }, get aids() { return aids; },
  decks, rateFor, phraseStart, deckGain, parityScore,
};

// ---------- Init ----------
async function init() {
  db.requestPersistence();
  try { setSplit(await db.getSetting('split', false)); } catch {}
  try { setBeatFocus(await db.getSetting('beatFocus', false)); } catch {}
  try { setAids(await db.getSetting('aids', false) === true); } catch {}
  try { setPitchRange(await db.getSetting('pitchRange', BASE_RANGE) === BASE_RANGE * 2 ? BASE_RANGE * 2 : BASE_RANGE); }
  catch { setPitchRange(BASE_RANGE); }
  try { const x = await db.getSetting('xfade', 0.5); if (typeof x === 'number' && x >= 0 && x <= 1) xfade = x; } catch {}
  renderAllFaders();
  unlockAudioOnFirstTouch();
  window.addEventListener('resize', renderAllFaders);
  // The faders now flex to fill the viewport, so their pixel height isn't known
  // until layout settles — and changes on rotate or when the URL bar hides.
  if (window.ResizeObserver) {
    const ro = new ResizeObserver(() => renderAllFaders());
    for (const id of DECKS) { ro.observe($('faderTrack' + id)); ro.observe($('wave' + id)); }
    ro.observe($('xfTrack'));
  }
  try {
    tracks = await db.getAllTracks();
  } catch { tracks = []; }
  renderLibrary();
  updateButtons();
  if (canStart()) startRound();
  // An empty mixer has no visible way in, so show the crate on first run.
  if (!tracks.length) openSheet(true);
  $('buildStamp').textContent = `build ${APP_BUILD}`;
  registerSW();
}
init();
