// app.js — Beatmatch Trainer core.
// Two decks, hidden tempo offset on deck B, ±8% pitch fader, hold-to-nudge,
// score on reveal. Crate and stats persist via IndexedDB (db.js).

import * as db from './db.js';

'use strict';

// ---------- State ----------
let tracks = [];            // {id, name, bpm, bpmSource, blob}
const bufferCache = new Map();
const MAX_CACHED = 6;
let ctx = null;
const mode = 'pair';        // always two different tracks; recorded on saved rounds
let difficulty = 'easy';
let round = null;           // {aIdx, bIdx, hidden, r0}
let split = false;          // headphone split: A hard left, B hard right
let pitchRange = 8;         // fader range %, 8 (SL-1210) or 16 via ×2
// Both decks are fully live: each has its own pitch fader, nudge and level, and
// the score is the tempo difference BETWEEN them. offset/mark track the playhead
// so Cue can return to the start point and Play can resume where it stopped.
const decks = {
  A: { source: null, gain: null, panner: null, playing: false,
       fader: 0, nudge: 0, vol: 85, rate: 1, offset: 0, mark: 0, cuePoint: 0 },
  B: { source: null, gain: null, panner: null, playing: false,
       fader: 0, nudge: 0, vol: 85, rate: 1, offset: 0, mark: 0, cuePoint: 0 },
};
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
function ensureCtx() {
  if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
  if (ctx.state === 'suspended') ctx.resume();
  return ctx;
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
async function getBuffer(trackId) {
  if (bufferCache.has(trackId)) return bufferCache.get(trackId);
  ensureCtx();
  const t = tracks.find(x => x.id === trackId);
  const arr = await t.blob.arrayBuffer();
  const buf = await ctx.decodeAudioData(arr);
  bufferCache.set(trackId, buf);
  if (bufferCache.size > MAX_CACHED) {
    const oldest = bufferCache.keys().next().value;
    if (oldest !== trackId) bufferCache.delete(oldest);
  }
  return buf;
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

function renderLibrary() {
  trackList.classList.toggle('hidden', tracks.length === 0);
  $('emptyLib').style.display = tracks.length ? 'none' : 'block';
  libMeta.textContent = tracks.length
    ? `${tracks.length} track${tracks.length > 1 ? 's' : ''} in your crate (stored on this device)`
    : '';
  trackList.innerHTML = '';
  tracks.forEach((t) => {
    const row = document.createElement('div');
    row.className = 'track-row';
    const name = document.createElement('div');
    name.className = 'track-name'; name.textContent = t.name;
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
      bufferCache.delete(t.id);
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
      const buf = await getBuffer(t.id);
      if (t.bpmSource !== 'pending') continue;
      const bpm = await detectBPM(buf);
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
    d.fader = 0; d.nudge = 0; d.rate = 1; d.offset = 0; d.cuePoint = 0;
  }
  renderAllFaders();
  $('trackA').textContent = a.name;
  $('trackB').textContent = b.name;
  updateButtons();
  const setCue = (id, track) => getBuffer(track.id).then(buf => {
    const at = phraseStart(track, buf.duration);
    decks[id].cuePoint = at;
    if (!decks[id].playing) decks[id].offset = at;
  });
  setCue('A', a).catch(() => toast('Could not decode deck 1 track'));
  setCue('B', b).catch(() => toast('Could not decode deck 2 track'));
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
// Each deck owns a persistent gain → panner → destination chain; only the
// buffer source is recreated per play. The panner is what the headphone split
// drives (A hard left, B hard right) to mimic one ear on the monitor.
function ensureChain(id) {
  const c = ensureCtx();
  const d = decks[id];
  if (!d.gain) {
    d.gain = c.createGain();
    if (c.createStereoPanner) {
      d.panner = c.createStereoPanner();
      d.gain.connect(d.panner);
      d.panner.connect(c.destination);
    } else {
      d.gain.connect(c.destination);  // pre-14.1 Safari: split silently unavailable
    }
    applySplit();
  }
  return d;
}
function applySplit() {
  for (const id of ['A', 'B']) {
    const p = decks[id].panner;
    if (p) p.pan.value = split ? (id === 'A' ? -1 : 1) : 0;
  }
}

// Advance the stored playhead to now, at whatever rate has been in force since
// the last mark. Must be called BEFORE changing rate, or the elapsed audio gets
// accounted at the wrong speed and Cue drifts away from the real start point.
function markPosition(id) {
  const d = decks[id];
  if (!d.playing || !ctx) return;
  const now = ctx.currentTime;
  d.offset += (now - d.mark) * d.rate;
  d.mark = now;
}
function applyRate(id) {
  if (!round) return;
  markPosition(id);
  const d = decks[id];
  d.rate = rateFor(id);
  if (d.source) d.source.playbackRate.value = d.rate;
}

async function playDeck(id) {
  if (!round) return;
  const c = ensureCtx();
  const trackId = id === 'A' ? round.aId : round.bId;
  let buf;
  try { buf = await getBuffer(trackId); }
  catch { toast('Could not decode this file. Try MP3, WAV, M4A or FLAC.'); return; }
  const d = ensureChain(id);
  if (d.playing) return;
  const src = c.createBufferSource();
  src.buffer = buf;
  d.gain.gain.value = d.vol / 100;
  src.connect(d.gain);
  d.rate = rateFor(id);
  src.playbackRate.value = d.rate;
  if (d.offset >= buf.duration) d.offset = d.cuePoint;
  src.start(0, d.offset);
  d.source = src; d.playing = true;
  d.mark = c.currentTime;
  src.onended = () => {
    if (d.source === src) { markPosition(id); d.playing = false; d.source = null; updateTransport(); }
  };
  updateTransport();
}
function stopDeck(id) {
  const d = decks[id];
  markPosition(id);
  if (d.source) { d.source.onended = null; try { d.source.stop(); } catch {} d.source = null; }
  d.playing = false;
  updateTransport();
}
// Cue: stop and return the playhead to this round's start point, so you can drop
// the track again from a known spot.
function cueDeck(id) {
  const wasPlaying = decks[id].playing;
  stopDeck(id);
  decks[id].offset = decks[id].cuePoint;
  if (wasPlaying) updateTransport();
}
function updateTransport() {
  for (const id of DECKS) {
    const btn = $('play' + id);
    btn.classList.toggle('playing', decks[id].playing);
    btn.innerHTML = decks[id].playing ? '&#9632;' : '&#9654;';
  }
}
for (const id of DECKS) {
  $('play' + id).addEventListener('click', () => decks[id].playing ? stopDeck(id) : playDeck(id));
  $('cue' + id).addEventListener('click', () => cueDeck(id));
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
    tick.style.top = `${((pitchRange - v) / (pitchRange * 2)) * 100}%`;
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

function renderPitch(id) {
  const d = decks[id];
  const track = $('faderTrack' + id), knob = $('faderKnob' + id);
  const h = track.clientHeight - knob.offsetHeight;
  knob.style.top = `${((pitchRange - d.fader) / (pitchRange * 2)) * h}px`;
  const shown = d.fader + d.nudge;
  const readout = $('pitchReadout' + id);
  readout.textContent = `${shown >= 0 ? '+' : ''}${shown.toFixed(2)}%`;
  // Lamp means "at zero to within the accuracy you're training for" — it reports
  // rather than snaps, so it never fights fine positioning.
  const atZero = Math.abs(d.fader) <= detentPct();
  readout.classList.toggle('detent', atZero);
  $('zeroLed' + id).classList.toggle('lit', atZero);
}
function renderLevel(id) {
  const d = decks[id];
  const track = $('volTrack' + id), knob = $('volKnob' + id);
  const h = track.clientHeight - knob.offsetHeight;
  knob.style.top = `${((100 - d.vol) / 100) * h}px`;
  $('volReadout' + id).textContent = String(Math.round(d.vol));
}
function renderAllFaders() {
  for (const id of DECKS) { renderPitch(id); renderLevel(id); }
}

// One drag handler for every vertical fader.
//
// Pitch faders support fine-drag: slide sideways away from the fader while
// dragging and vertical movement is scaled down, the way a DAW fader behaves.
// Needed because 0.1 BPM is ~2px of raw travel — too fine for a fingertip.
// Movement is integrated incrementally rather than recomputed from the anchor,
// so changing the scale mid-drag doesn't make the knob jump.
const FINE_FALLOFF = 30;      // px sideways to halve sensitivity
function fineFactor(dx) { return 1 / (1 + Math.abs(dx) / FINE_FALLOFF); }

function bindVFader(track, knob, onValue, { fine = false, onFine = null } = {}) {
  let dragging = false, frac = 0, lastY = 0;
  const geom = () => {
    const rect = track.getBoundingClientRect();
    return { rect, usable: rect.height - knob.offsetHeight, kh: knob.offsetHeight };
  };
  const clamp = v => Math.max(0, Math.min(1, v));

  track.addEventListener('pointerdown', e => {
    dragging = true;
    try { track.setPointerCapture(e.pointerId); } catch {}
    const { rect, usable, kh } = geom();
    frac = clamp((e.clientY - rect.top - kh / 2) / usable);   // jump to finger
    lastY = e.clientY;
    onValue(frac);
    if (onFine) onFine(1);
  });
  track.addEventListener('pointermove', e => {
    if (!dragging) return;
    const { rect, usable } = geom();
    const f = fine ? fineFactor(e.clientX - (rect.left + rect.width / 2)) : 1;
    frac = clamp(frac + ((e.clientY - lastY) / usable) * f);
    lastY = e.clientY;
    onValue(frac);
    if (onFine) onFine(f);
  });
  const end = () => { dragging = false; if (onFine) onFine(1); };
  track.addEventListener('pointerup', end);
  track.addEventListener('pointercancel', end);
}

for (const id of DECKS) {
  bindVFader($('faderTrack' + id), $('faderKnob' + id), frac => {
    // No snap: a detent you can feel is one you can't be precise inside, and
    // precision is the point. The lamp still reports when you're at zero.
    decks[id].fader = +(pitchRange - frac * pitchRange * 2).toFixed(3);
    renderPitch(id);
    applyRate(id);
  }, {
    fine: true,
    onFine: f => $('pitchReadout' + id).classList.toggle('fine', f < 0.9),
  });
  bindVFader($('volTrack' + id), $('volKnob' + id), frac => {
    decks[id].vol = Math.round((1 - frac) * 100);
    renderLevel(id);
    if (decks[id].gain) decks[id].gain.gain.value = decks[id].vol / 100;
  });
}

// ---------- Nudge ----------
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
  bindNudge($('nudgeUp' + id), id, 1.0);
  bindNudge($('nudgeDown' + id), id, -1.0);
}

// ---------- Reveal ----------
revealBtn.addEventListener('click', async () => {
  if (!round) return;
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
  db.saveRound({ err, errBpm, mode, difficulty, pitchRange,
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
  renderHistory();
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

// ---------- Settings ----------
$('diffSeg').addEventListener('click', e => {
  const btn = e.target.closest('button'); if (!btn) return;
  difficulty = btn.dataset.diff;
  [...$('diffSeg').children].forEach(b => b.classList.toggle('on', b === btn));
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
}

// ---------- Crate & settings sheet ----------
function openSheet(on) {
  $('sheet').classList.toggle('show', on);
  $('menuBtn').setAttribute('aria-expanded', String(on));
}
$('menuBtn').addEventListener('click', () => openSheet(true));
$('sheetClose').addEventListener('click', () => openSheet(false));
document.addEventListener('keydown', e => { if (e.key === 'Escape') openSheet(false); });

// ---------- Service worker ----------
// Bump alongside sw.js CACHE. Shown in the sheet so "which build am I running?"
// is answerable from the phone instead of guessed at.
const APP_BUILD = 'bmt-v5';

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

// ---------- Init ----------
async function init() {
  db.requestPersistence();
  try { setSplit(await db.getSetting('split', false)); } catch {}
  try { setPitchRange(await db.getSetting('pitchRange', BASE_RANGE) === BASE_RANGE * 2 ? BASE_RANGE * 2 : BASE_RANGE); }
  catch { setPitchRange(BASE_RANGE); }
  renderAllFaders();
  window.addEventListener('resize', renderAllFaders);
  // The faders now flex to fill the viewport, so their pixel height isn't known
  // until layout settles — and changes on rotate or when the URL bar hides.
  if (window.ResizeObserver) {
    const ro = new ResizeObserver(() => renderAllFaders());
    for (const id of DECKS) { ro.observe($('faderTrack' + id)); ro.observe($('volTrack' + id)); }
  }
  try {
    tracks = await db.getAllTracks();
  } catch { tracks = []; }
  renderLibrary();
  detectMissingBPMs();
  updateButtons();
  if (canStart()) startRound();
  // An empty mixer has no visible way in, so show the crate on first run.
  if (!tracks.length) openSheet(true);
  $('buildStamp').textContent = `build ${APP_BUILD}`;
  registerSW();
}
init();
