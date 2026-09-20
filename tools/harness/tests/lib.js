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

// Recording tap on the master bus. An AudioWorklet captures the post-limiter
// signal with the audio-clock frame of every block, so onsets are placed to
// the sample. (A ScriptProcessorNode was tried first: its double-buffering
// added ~12 ms that looked like app latency.)
export async function tapMaster(app) {
  const ctx = app.bmt.ctx, m = app.bmt.master;
  if (!ctx || !m) throw new Error('audio graph not built yet');
  await ctx.audioWorklet.addModule('/tools/harness/tests/tap-worklet.js');
  const node = new app.w.AudioWorkletNode(ctx, 'bmt-tap', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
  const mute = ctx.createGain(); mute.gain.value = 0;
  m.limiter.connect(node); node.connect(mute); mute.connect(ctx.destination);
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
    // 0.5 bus and the limiter the kick lands at ~0.27, the hat at ~0.1.
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
    disconnect() { try { m.limiter.disconnect(node); } catch {} node.port.onmessage = null; },
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
