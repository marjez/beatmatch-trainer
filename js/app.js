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
let mode = 'same';
let difficulty = 'easy';
let round = null;           // {aIdx, bIdx, hidden, r0}
let fader = 0;
let nudge = 0;
let split = false;          // headphone split: A hard left, B hard right
let pitchRange = 8;         // fader range %, 8 (SL-1210) or 16 via ×2
const decks = {
  A: { source: null, gain: null, panner: null, playing: false },
  B: { source: null, gain: null, panner: null, playing: false },
};
let sessionHistory = [];

// ---------- DOM ----------
const $ = id => document.getElementById(id);
const fileInput = $('fileInput'), trackList = $('trackList'), libMeta = $('libMeta');
const playABtn = $('playA'), playBBtn = $('playB');
const faderTrack = $('faderTrack'), faderKnob = $('faderKnob'), pitchReadout = $('pitchReadout');
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
fileInput.addEventListener('change', async (e) => {
  const files = [...e.target.files];
  if (!files.length) return;
  let added = 0;
  for (const f of files) {
    const name = f.name.replace(/\.[^.]+$/, '');
    if (tracks.some(t => t.name === name && t.blob.size === f.size)) continue;
    const bpm = bpmFromName(f.name);
    const rec = { name, bpm, bpmSource: bpm ? 'name' : null, blob: f };
    rec.id = await db.addTrack(rec);
    tracks.push(rec);
    added++;
  }
  fileInput.value = '';
  if (added) toast(`${added} track${added > 1 ? 's' : ''} added to your crate — they'll be here next time too.`);
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
  if (mode === 'same') return tracks.length >= 1;
  return pairablePairs().length > 0;
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
    if (mode === 'same') {
      a = tracks[Math.floor(Math.random() * tracks.length)];
      b = a;
    } else {
      const pairs = pairablePairs();
      if (!pairs.length) {
        toast(`No two tracks are within ±${pitchRange}% of each other — add closer BPMs, or tap ×2 to widen the range.`);
        return;
      }
      [a, b] = pairs[Math.floor(Math.random() * pairs.length)];
    }
  }
  const r0 = mode === 'same' ? 1 : (a.bpm / b.bpm);
  let hidden, needed;
  do {
    hidden = pickHidden();
    needed = (1 / (1 + hidden / 100) - 1) * 100;
  } while (Math.abs(needed) > pitchRange - 0.5);
  round = { aId: a.id, bId: b.id, hidden, r0 };
  fader = 0; nudge = 0;
  renderFader();
  $('trackA').textContent = a.name;
  $('trackB').textContent = b.name;
  updateButtons();
  getBuffer(a.id).catch(() => toast('Could not decode deck A track'));
  getBuffer(b.id).catch(() => toast('Could not decode deck B track'));
}

function currentRateB() {
  return round.r0 * (1 + round.hidden / 100) * (1 + (fader + nudge) / 100);
}
function currentErrorPct() {
  return ((1 + round.hidden / 100) * (1 + fader / 100) - 1) * 100;
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
  d.gain.gain.value = ($(id === 'A' ? 'volA' : 'volB').value) / 100;
  src.connect(d.gain);
  src.playbackRate.value = id === 'A' ? 1 : currentRateB();
  const startAt = buf.duration > 90 ? Math.min(30, buf.duration * 0.25) : 0;
  src.start(0, startAt);
  d.source = src; d.playing = true;
  src.onended = () => { if (d.source === src) { d.playing = false; d.source = null; updatePlayButtons(); } };
  updatePlayButtons();
}
function stopDeck(id) {
  const d = decks[id];
  if (d.source) { try { d.source.stop(); } catch {} d.source = null; }
  d.playing = false;
  updatePlayButtons();
}
function updatePlayButtons() {
  playABtn.classList.toggle('playing', decks.A.playing);
  playBBtn.classList.toggle('playing', decks.B.playing);
  playABtn.innerHTML = decks.A.playing ? '&#9632;' : '&#9654;';
  playBBtn.innerHTML = decks.B.playing ? '&#9632;' : '&#9654;';
}
playABtn.addEventListener('click', () => decks.A.playing ? stopDeck('A') : playDeck('A'));
playBBtn.addEventListener('click', () => decks.B.playing ? stopDeck('B') : playDeck('B'));
$('volA').addEventListener('input', e => { if (decks.A.gain) decks.A.gain.gain.value = e.target.value / 100; });
$('volB').addEventListener('input', e => { if (decks.B.gain) decks.B.gain.gain.value = e.target.value / 100; });

function applyRateB() {
  if (decks.B.source) decks.B.source.playbackRate.value = currentRateB();
}

// ---------- Fader ----------
// ±8% is the SL-1210 range and stays the default. ×2 opens it to ±16% for the
// times a pair genuinely needs more room; it does not change the hidden offset,
// so rounds are no easier — it only buys headroom.
const BASE_RANGE = 8;
function buildScale() {
  const scale = $('faderScale');
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
  fader = Math.max(-pitchRange, Math.min(pitchRange, fader));
  const btn = $('rangeBtn');
  btn.textContent = `±${pitchRange}%`;
  btn.classList.toggle('wide', pitchRange > BASE_RANGE);
  btn.setAttribute('aria-pressed', String(pitchRange > BASE_RANGE));
  buildScale();
  renderFader();
  applyRateB();
  updateButtons();
}
function renderFader() {
  const h = faderTrack.clientHeight - 34;
  const y = ((pitchRange - fader) / (pitchRange * 2)) * h;
  faderKnob.style.top = `${y}px`;
  const shown = fader + nudge;
  pitchReadout.textContent = `${shown >= 0 ? '+' : ''}${shown.toFixed(2)}%`;
}
let dragging = false;
function faderFromPointer(clientY) {
  const rect = faderTrack.getBoundingClientRect();
  const usable = rect.height - 34;
  let frac = (clientY - rect.top - 17) / usable;
  frac = Math.max(0, Math.min(1, frac));
  fader = +(pitchRange - frac * pitchRange * 2).toFixed(2);
  renderFader(); applyRateB();
}
faderTrack.addEventListener('pointerdown', e => {
  dragging = true;
  faderTrack.setPointerCapture(e.pointerId);
  faderFromPointer(e.clientY);
});
faderTrack.addEventListener('pointermove', e => { if (dragging) faderFromPointer(e.clientY); });
faderTrack.addEventListener('pointerup', () => dragging = false);
faderTrack.addEventListener('pointercancel', () => dragging = false);

// ---------- Nudge ----------
function bindNudge(btn, amount) {
  const start = e => { e.preventDefault(); nudge = amount; btn.classList.add('held'); renderFader(); applyRateB(); };
  const end = () => { nudge = 0; btn.classList.remove('held'); renderFader(); applyRateB(); };
  btn.addEventListener('pointerdown', start);
  btn.addEventListener('pointerup', end);
  btn.addEventListener('pointercancel', end);
  btn.addEventListener('pointerleave', end);
}
bindNudge($('nudgeUp'), 1.0);
bindNudge($('nudgeDown'), -1.0);

// ---------- Reveal ----------
revealBtn.addEventListener('click', async () => {
  if (!round) return;
  stopDeck('A'); stopDeck('B');
  const err = currentErrorPct();
  const absErr = Math.abs(err);
  const a = tracks.find(t => t.id === round.aId), b = tracks.find(t => t.id === round.bId);
  // Deck A plays at rate 1, so its BPM is its tagged BPM; error in BPM = bpmA × err%
  const bpmA = a?.bpm || null;
  const errBpm = bpmA ? bpmA * err / 100 : null;
  const absBpm = errBpm !== null ? Math.abs(errBpm) : null;
  sessionHistory.push({ err, errBpm });
  db.saveRound({ err, errBpm, mode, difficulty, pitchRange, aName: a?.name, bName: b?.name }).catch(() => {});
  const sEl = $('revealScore');
  if (absBpm !== null) {
    sEl.textContent = absBpm.toFixed(2);
    $('revealSub').textContent = 'BPM off';
    sEl.className = 'reveal-score ' + (absBpm <= 0.05 ? 'good' : absBpm <= 0.3 ? 'mid' : 'bad');
  } else {
    sEl.textContent = absErr.toFixed(2) + '%';
    $('revealSub').textContent = 'tempo off (no BPM tagged for deck A)';
    sEl.className = 'reveal-score ' + (absErr <= 0.05 ? 'good' : absErr <= 0.25 ? 'mid' : 'bad');
  }
  const dir = err > 0 ? 'fast' : 'slow';
  const correctFader = (1 / (1 + round.hidden / 100) - 1) * 100;
  const lockNote = (absBpm !== null ? absBpm <= 0.05 : absErr <= 0.05);
  $('revealDetail').innerHTML =
    `<span>Deck B was</span> ${lockNote ? '<span>locked in</span>' : `running ${dir}`} ` +
    (absBpm !== null ? `<span>(${absErr.toFixed(2)}% at ${bpmA} BPM)</span>` : '') + ` ·
     <span>hidden offset</span> ${round.hidden >= 0 ? '+' : ''}${round.hidden.toFixed(2)}% ·
     <span>correct fader</span> ${correctFader >= 0 ? '+' : ''}${correctFader.toFixed(2)}% <span>(you: ${fader >= 0 ? '+' : ''}${fader.toFixed(2)}%)</span>`;
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
$('modeSeg').addEventListener('click', e => {
  const btn = e.target.closest('button'); if (!btn) return;
  mode = btn.dataset.mode;
  [...$('modeSeg').children].forEach(b => b.classList.toggle('on', b === btn));
  if (mode === 'pair' && tracks.filter(t => t.bpm).length < 2) {
    toast('Two-track mode needs BPM on at least 2 tracks — waiting for detection, or type them in.');
  }
  updateButtons();
  if (canStart()) startRound();
});
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

// ---------- Init ----------
async function init() {
  db.requestPersistence();
  try { setSplit(await db.getSetting('split', false)); } catch {}
  try { setPitchRange(await db.getSetting('pitchRange', BASE_RANGE) === BASE_RANGE * 2 ? BASE_RANGE * 2 : BASE_RANGE); }
  catch { setPitchRange(BASE_RANGE); }
  window.addEventListener('resize', renderFader);
  try {
    tracks = await db.getAllTracks();
  } catch { tracks = []; }
  renderLibrary();
  detectMissingBPMs();
  updateButtons();
  if (canStart()) startRound();
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }
}
init();
