// lib.js — shared helpers for the browser harness tests.
//
// Every test boots the REAL app in an iframe, feeds it the synthetic crate
// through the same file input a user would use, and listens to the master bus
// with a recording tap. Nothing here bypasses app code paths.
export const post = o => fetch('/result', { method: 'POST', body: JSON.stringify(o, null, 1) });
export const sleep = ms => new Promise(r => setTimeout(r, ms));
export async function get(url) {
  try { const r = await fetch(url, { cache: 'no-store' }); if (!r.ok) throw new Error('HTTP ' + r.status); return r; }
  catch (e) { throw new Error(`fetch ${url}: ${e.message}`); }
}

export async function bootApp(frameId = 'f') {
  const frame = document.getElementById(frameId);
  // The app reloads itself once when the service worker first takes control
  // (controllerchange -> location.reload), which would leave us holding a dead
  // window. Wait until the page is controlled, which is the steady state a
  // user is in on every launch after the first, then bind to THAT window.
  let w = null;
  for (let i = 0; i < 400; i++) {
    const cw = frame.contentWindow;
    if (cw && cw.__bmt && (!cw.navigator.serviceWorker || cw.navigator.serviceWorker.controller)) { w = cw; break; }
    await sleep(50);
  }
  if (!w) throw new Error('app did not boot under service worker control');
  await sleep(300);
  const errs = [];
  w.addEventListener('error', e => errs.push(String(e.message)));
  w.addEventListener('unhandledrejection', e => errs.push('rejection: ' + String(e.reason)));
  return { w, d: w.document, g: id => w.document.getElementById(id), errs, bmt: w.__bmt };
}

// Load crate.json + audio from /crate/ into the app via its file input.
export async function loadCrate(app, names = null, withGrid = true) {
  const files = await (await get('/crate/files.json')).json();
  const pick = names || files;
  const dt = new app.w.DataTransfer();
  if (withGrid) {
    const j = await (await get('/crate/crate.json')).text();
    dt.items.add(new app.w.File([j], 'crate.json', { type: 'application/json' }));
  }
  for (const n of pick) {
    // arrayBuffer, not blob(): a 10 MB blob() through the service worker fails
    // with "Failed to fetch" in headless Chromium (blob storage quirk).
    const ab = await (await get('/crate/' + encodeURIComponent(n))).arrayBuffer();
    dt.items.add(new app.w.File([ab], n, { type: 'audio/wav' }));
  }
  const input = app.g('fileInput');
  input.files = dt.files;
  input.dispatchEvent(new app.w.Event('change', { bubbles: true }));
  await waitFor(() => app.bmt.tracks.length >= pick.length, 20000, 'tracks to load');
  return pick;
}

export async function waitFor(fn, ms = 10000, what = 'condition') {
  const t0 = performance.now();
  while (performance.now() - t0 < ms) { if (fn()) return true; await sleep(20); }
  throw new Error('timeout waiting for ' + what);
}

export const waitReady = app => waitFor(
  () => app.bmt.round && app.bmt.decks.A.ready && app.bmt.decks.B.ready, 30000, 'both decks ready');

// Recording tap on the master bus. An AudioWorklet captures the post-filter
// signal with the audio-clock frame of every block, so onsets are placed to
// the sample. (A ScriptProcessorNode was tried first: its double-buffering
// added ~12 ms that looked like app latency.)
export async function tapMaster(app) {
  const ctx = app.bmt.ctx, m = app.bmt.master;
  if (!ctx || !m) throw new Error('audio graph not built yet');
  await ctx.audioWorklet.addModule('/tools/harness/tests/tap-worklet.js');
  const node = new app.w.AudioWorkletNode(ctx, 'bmt-tap', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
  const mute = ctx.createGain(); mute.gain.value = 0;
  const tapPoint = m.out || m.limiter || m.focus;      // the last node before the destination
  tapPoint.connect(node); node.connect(mute); mute.connect(ctx.destination);
  const sr = ctx.sampleRate;
  const chunks = [];
  node.port.onmessage = e => {
    chunks.push({ t: e.data.frame / sr, data: e.data.data });
    if (chunks.length > 8000) chunks.shift();     // ~23 s ring
  };
  const samples = function* (t0, t1) {
    for (const c of chunks) {
      const end = c.t + c.data.length / sr;
      if (end < t0 || c.t >= t1) continue;
      for (let i = 0; i < c.data.length; i++) {
        const t = c.t + i / sr;
        if (t >= t0 && t < t1) yield [t, c.data[i]];
      }
    }
  };
  return {
    ctx, sr,
    clear() { chunks.length = 0; },
    // Wait until the tap has captured audio up to time t.
    async settle(t) { await waitFor(() => chunks.length && chunks[chunks.length - 1].t > t, 5000, 'tap to catch up'); },
    firstSound(t0, thr = 0.005, t1 = Infinity) {
      for (const [t, v] of samples(t0, t1)) if (Math.abs(v) > thr) return t;
      return null;
    },
    lastSound(t0, t1, thr = 0.005) {
      let last = null;
      for (const [t, v] of samples(t0, t1)) if (Math.abs(v) > thr) last = t;
      return last;
    },
    // Longest run of consecutive samples below thr inside [t0, t1): a dropout
    // shows up as a run far longer than the half-cycle of the drone.
    scanRuns(t0, t1, thr = 0.006) {
      let run = 0, longest = 0, n = 0, at = null;
      for (const [t, v] of samples(t0, t1)) {
        n++;
        if (Math.abs(v) < thr) { run++; if (run > longest) { longest = run; at = t; } } else run = 0;
      }
      return { longestMs: +(longest / sr * 1000).toFixed(2), n, endsAt: at };
    },
    peak(t0, t1) { let p = 0; for (const [, v] of samples(t0, t1)) p = Math.max(p, Math.abs(v)); return p; },
    // Kick onsets: positive-going threshold crossings on a 4 ms envelope with
    // a 150 ms refractory period. The synthetic kick is 0.9 peak at 55 Hz; the
    // drone under it sits at 0.04 and the hat at <= 0.25; after deck gain, the
    // 0.5 bus the kick lands at ~0.27, the hat at ~0.1.
    onsets(t0, t1, thr = 0.15) {
      const out = [];
      let env = 0, armed = true, lastOn = -1;
      const k = Math.exp(-1 / (0.004 * sr));
      for (const [t, v] of samples(t0, t1)) {
        const a = Math.abs(v);
        env = a > env ? a : env * k;
        if (armed && env > thr && t - lastOn > 0.15) { out.push(t); lastOn = t; armed = false; }
        else if (!armed && env < thr * 0.3) armed = true;
      }
      return out;
    },
    // Kick-band envelope at 1 ms resolution: a two-pole 120 Hz low-pass
    // (biquad, computed here over the captured samples) then RMS per hop.
    // Counting broadband onsets called a kickless intro's hats "kicks".
    lowEnvelope(t0, t1) {
      const f = 120 / sr, w = 2 * Math.PI * f, q = 0.7;
      const alpha = Math.sin(w) / (2 * q), cosw = Math.cos(w);
      const a0 = 1 + alpha;
      const b = [(1 - cosw) / 2 / a0, (1 - cosw) / a0, (1 - cosw) / 2 / a0];
      const a = [(-2 * cosw) / a0, (1 - alpha) / a0];
      let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
      const hop = Math.round(sr / 1000);
      const out = [];
      let acc = 0, n = 0;
      for (const [, v] of samples(t0, t1)) {
        const y = b[0] * v + b[1] * x1 + b[2] * x2 - a[0] * y1 - a[1] * y2;
        x2 = x1; x1 = v; y2 = y1; y1 = y;
        acc += y * y; n++;
        if (n === hop) { out.push(Math.sqrt(acc / n)); acc = 0; n = 0; }
      }
      // NOT one millisecond per hop: 44/44100 s is 0.9977 ms, and treating the
      // index as milliseconds drifts 0.23% — 18 ms over an 8 s window, past the
      // ±15 ms tolerance, so late beats fell outside their own windows and the
      // check was far stricter than intended. (The same mistake was in
      // analyse_crate.html, where it biased every BPM by 0.23%.)
      out.hopS = hop / sr;
      return out;
    },
    // Is a beat RUNNING on this grid? Mean kick-band energy in a ±15 ms window
    // around each predicted beat, against the same windows placed off-beat.
    // Ratio ≫ 1 means kicks are landing where the tempo says they should —
    // no thresholds tuned to one kind of material.
    gridScore(t0, t1, periodS, tolMs = 15) {
      const env = this.lowEnvelope(t0, t1);
      const hopMs = env.hopS * 1000;
      const P = periodS * 1000 / hopMs;          // beat period, in envelope hops
      const tol = tolMs / hopMs;
      const mean = (centre) => {
        let sum = 0, k = 0;
        for (let i = Math.round(centre - tol); i <= Math.round(centre + tol); i++) {
          if (i >= 0 && i < env.length) { sum += env[i]; k++; }
        }
        return k ? sum / k : 0;
      };
      const beats = Math.floor((env.length - tol) / P);
      let on = 0, off = 0, hits = 0;
      for (let k = 0; k < beats; k++) {
        const e = mean(k * P), o = mean(k * P + P / 2);
        on += e; off += o;
        if (e > o * 1.3) hits++;
      }
      // Where the first kick ATTACKS, in ms from t0 — the rising edge, not the
      // envelope peak. A kick whose sub blooms 30 ms in peaks 30 ms late while
      // its transient is on time, and reading the peak flagged two perfectly
      // gridded tracks as out of phase.
      // Search the first BAR, not the first beat: a loop can legitimately open
      // on a bar whose first beat carries no kick, and judging phase from a
      // near-silent beat flagged a track whose every beat was on the grid.
      let firstMs = null, peak = 0, peakAt = 0;
      const span = Math.min(env.length, Math.round(P * 4));
      for (let i = 0; i < span; i++) if (env[i] > peak) { peak = env[i]; peakAt = i; }
      if (peak > 0) {
        let i = peakAt;
        while (i > 0 && env[i - 1] > peak * 0.5) i--;      // walk back down the attack
        firstMs = i * hopMs;
      }
      return { beats, onGridHits: hits, ratio: off > 0 ? +(on / off).toFixed(2) : null, firstMs };
    },
    disconnect() { try { tapPoint.disconnect(node); } catch {} node.port.onmessage = null; },
  };
}

export const pev = (w, el, type, extra = {}) =>
  el.dispatchEvent(new w.PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1, pointerType: 'touch', isPrimary: true, ...extra }));

// A realistic finger tap: down, held for `hold` ms, up, then click — the way a
// browser synthesises it. Returns the performance.now() of the press.
export async function tap(w, el, hold = 90) {
  const t = performance.now();
  pev(w, el, 'pointerdown');
  await sleep(hold);
  pev(w, el, 'pointerup');
  el.dispatchEvent(new w.MouseEvent('click', { bubbles: true, cancelable: true }));
  return t;
}

export const stats = xs => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return { n: s.length, min: +s[0].toFixed(2), median: +s[s.length >> 1].toFixed(2), max: +s[s.length - 1].toFixed(2) };
};
