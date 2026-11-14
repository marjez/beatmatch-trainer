// kickgrid.js — where does the KICK start? Measured on the decoded track.
//
// A track added from the owner's library has no beat grid unless a crate.json
// came with it, and the app used to start such a track "30 seconds in" —
// wherever that fell: mid-bar, on a hat, in a breakdown. Even with a Rekordbox
// anchor, a phrase boundary is only a promise about the grid, not about what is
// playing there. This looks at the audio itself, at the moment loadDeck already
// holds the decoded buffer, so it costs one pass over the samples and needs
// nothing from the Mac.
//
// The start it prefers is the KICK-IN: the first kick from which the beat then
// runs for eight bars. That is what Beatmatch PRO cues to (its cue point is the
// first detected beat), and in dance music the bar where the kick enters is
// almost always a "one" at the top of a phrase.
//
// No thresholds tuned to a kind of material: the onset threshold comes from
// this track's own typical kick strength (see CLAUDE.md, "Thresholds must come
// from the material").

const HOP_S = 0.004;          // envelope resolution
const SCAN_S = 240;           // how far into the track to look
const TOL_S = 0.035;          // an onset this close to where the beat should be is that beat
const RUN_BEATS = 32;         // eight bars
const RUN_NEED = 26;          // ... of which at least this many carry a kick

// Kick-band envelope: two-pole low-pass at 130 Hz, rectified, peak per hop.
function kickEnvelope(buffer, seconds) {
  const sr = buffer.sampleRate;
  const n = Math.min(buffer.length, Math.floor(seconds * sr));
  const L = buffer.getChannelData(0);
  const R = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : L;
  const w = 2 * Math.PI * 130 / sr, alpha = Math.sin(w) / (2 * 0.7), cosw = Math.cos(w), a0 = 1 + alpha;
  const b0 = (1 - cosw) / 2 / a0, b1 = (1 - cosw) / a0, a1 = (-2 * cosw) / a0, a2 = (1 - alpha) / a0;
  const hop = Math.max(1, Math.round(HOP_S * sr));
  const env = new Float32Array(Math.floor(n / hop));
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0, i = 0;
  for (let h = 0; h < env.length; h++) {
    let p = 0;
    for (const end = i + hop; i < end; i++) {
      const x = (L[i] + R[i]) * 0.5;
      const y = b0 * x + b1 * x1 + b0 * x2 - a1 * y1 - a2 * y2;
      x2 = x1; x1 = x; y2 = y1; y1 = y;
      const a = y < 0 ? -y : y;
      if (a > p) p = a;
    }
    env[h] = p;
  }
  return { env, hopS: hop / sr };
}

// Kick onsets: local maxima of the envelope's rise, kept if they are at least
// a third as strong as this track's typical kick.
function kickOnsets({ env, hopS }, beatS) {
  const rise = new Float32Array(env.length);
  for (let i = 2; i < env.length; i++) { const d = env[i] - env[i - 2]; rise[i] = d > 0 ? d : 0; }
  const reach = Math.max(2, Math.round(0.06 / hopS));           // one onset per 60 ms
  const peaks = [];
  for (let i = reach; i < rise.length - reach; i++) {
    const v = rise[i];
    if (v <= 0) continue;
    let top = true;
    for (let j = i - reach; j <= i + reach; j++) if (rise[j] > v || (rise[j] === v && j < i)) { top = false; break; }
    if (top) peaks.push(i);
  }
  if (!peaks.length) return [];
  // "Typical kick": if the beat ran the whole scan there would be one kick per
  // beat, so the median of that many strongest onsets is a kick. On a track
  // that is mostly breakdown this lands lower, which only makes it lenient.
  const expected = Math.max(8, Math.floor(env.length * hopS / beatS));
  const strongest = peaks.map(i => rise[i]).sort((a, b) => b - a).slice(0, expected);
  const thr = strongest[strongest.length >> 1] * 0.33;
  // The rise peaks a couple of hops after the attack begins; report the hop
  // where the envelope leaves the floor.
  const out = [];
  for (const i of peaks) {
    if (rise[i] < thr) continue;
    let k = i;
    while (k > 0 && rise[k - 1] > rise[i] * 0.15) k--;
    out.push((k - 1) * hopS);
  }
  return out;
}

function nearest(onsets, t) {
  let lo = 0, hi = onsets.length - 1;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (onsets[mid] < t) lo = mid + 1; else hi = mid; }
  let best = onsets[lo];
  if (lo > 0 && Math.abs(onsets[lo - 1] - t) < Math.abs(best - t)) best = onsets[lo - 1];
  return Math.abs(best - t) <= TOL_S ? best : null;
}

// How many of the next `beats` beats from t carry a kick. The expected time
// re-centres on every kick found, so a BPM that is slightly out (the detector
// rounds to an integer) does not walk off the beat within eight bars.
function run(onsets, t, beatS, beats = RUN_BEATS) {
  let e = t, hits = 0, lead = 0, leading = true;
  for (let k = 0; k < beats; k++) {
    const hit = nearest(onsets, e);
    if (hit !== null) { hits++; if (leading) lead++; e = hit + beatS; }
    else { leading = false; e += beatS; }
  }
  return { hits, lead };
}
const solid = r => r.lead >= 4 && r.hits >= RUN_NEED;

// The exact sample the kick's attack begins at, near t: the hop-level estimate
// is good to ±4 ms and the cue point has to be the transient itself.
function attack(buffer, t) {
  const sr = buffer.sampleRate, L = buffer.getChannelData(0);
  const from = Math.max(0, Math.floor((t - 0.02) * sr)), to = Math.min(buffer.length, Math.floor((t + 0.05) * sr));
  // One-pole low-pass at 400 Hz: enough to ignore a hat, short enough (well
  // under a millisecond of delay) not to move the answer.
  const k = 1 - Math.exp(-2 * Math.PI * 400 / sr);
  let y = 0, peak = 0;
  const lp = new Float32Array(to - from);
  for (let i = from; i < to; i++) { y += k * (L[i] - y); lp[i - from] = y; const a = y < 0 ? -y : y; if (a > peak) peak = a; }
  if (!(peak > 0)) return t;
  let floor = 0;
  const pre = Math.min(lp.length, Math.floor(0.012 * sr));
  for (let i = 0; i < pre; i++) { const a = lp[i] < 0 ? -lp[i] : lp[i]; if (a > floor) floor = a; }
  const thr = Math.max(peak * 0.12, Math.min(floor * 1.5, peak * 0.5));
  for (let i = pre; i < lp.length; i++) {
    const a = lp[i] < 0 ? -lp[i] : lp[i];
    if (a >= thr) return Math.max(0, (from + i) / sr - 0.001);     // a millisecond of lead-in
  }
  return t;
}

// Where to cue the deck.
//   candidates: grid times to try first, in order (a Rekordbox phrase start and
//               the phrases after it). One is taken as-is if the beat runs from it.
//   snap:       {anchor, beatS} — pull a found kick-in onto the track's own grid
//               when it is within tolerance, so offset 0 stays ON the grid.
// Returns {start, how} or null when the track has no beat this can find.
export function findKickStart(buffer, bpm, { candidates = [], snap = null, latest = Infinity } = {}) {
  if (!bpm || !buffer || !buffer.length) return null;
  const beatS = 60 / bpm;
  const e = kickEnvelope(buffer, Math.min(buffer.duration, SCAN_S));
  const onsets = kickOnsets(e, beatS);
  if (onsets.length < 8) return null;
  const limit = Math.min(latest, buffer.duration - 20);
  for (const c of candidates) {
    if (c < 0 || c > limit) continue;
    if (nearest(onsets, c) !== null && solid(run(onsets, c, beatS))) return { start: c, how: 'grid' };
  }
  const onGrid = t => {
    if (!snap) return null;
    const g = snap.anchor + Math.round((t - snap.anchor) / snap.beatS) * snap.beatS;
    return g >= 0 && Math.abs(g - t) <= TOL_S ? g : null;
  };
  // Kick-in: the first kick from which the beat runs eight bars.
  for (const t of onsets) {
    if (t > limit) break;
    if (!solid(run(onsets, t, beatS))) continue;
    const g = onGrid(t);
    return g !== null ? { start: g, how: 'kick-in, on grid' } : { start: attack(buffer, t), how: 'kick-in' };
  }
  // No eight solid bars anywhere (broken beats, hip-hop): the first kick that
  // at least opens a bar's worth of them, else simply the first kick.
  for (const t of onsets) {
    if (t > limit) break;
    const r = run(onsets, t, beatS, 16);
    if (r.lead >= 2 && r.hits >= 8) return { start: onGrid(t) ?? attack(buffer, t), how: 'first run of kicks' };
  }
  return { start: attack(buffer, onsets[0]), how: 'first kick' };
}

// The longest stretch over which a beat of this period keeps landing on kicks:
// beat numbers and kick times, for the fit below.
function longestRun(onsets, beatS) {
  let best = null;
  for (let i = 0; i < onsets.length; ) {
    // Follow the beat from this kick until four in a row are missing.
    const ks = [0], ts = [onsets[i]];
    let e = onsets[i] + beatS, k = 1, missed = 0, last = onsets[i];
    while (missed < 4) {
      const hit = nearest(onsets, e);
      if (hit !== null && hit > last) { ks.push(k); ts.push(hit); last = hit; e = hit + beatS; missed = 0; }
      else { e += beatS; missed++; }
      k++;
    }
    if (!best || ts.length > best.ts.length) best = { ks, ts };
    while (i < onsets.length && onsets[i] <= last) i++;      // carry on after this run
  }
  return best;
}

// The track's tempo, measured from its kicks. `seed` is a rough BPM (the beat
// detector's whole number); the answer is a straight-line fit of kick time
// against beat number over the longest run where the beat keeps going, which
// over a minute of kicks is good to about a hundredth of a BPM — the 4 ms the
// envelope can place one kick to, divided across a hundred-odd beats.
// Returns {bpm, beats, residualMs} or null if no run is long enough to trust.
export function measureTempo(buffer, seed) {
  if (!seed || !buffer || !buffer.length) return null;
  const onsets = kickOnsets(kickEnvelope(buffer, Math.min(buffer.duration, SCAN_S)), 60 / seed);
  // The seed can be a simple ratio out: on one four-on-the-floor test track the
  // detector answered 83 for 124.62, two thirds. Try the ratios a tempo folds
  // by and keep the one the kicks themselves agree with — where nearly every
  // expected beat has a kick AND nearly every kick is an expected beat. A
  // tempo that is too slow skips kicks; one that is too fast expects kicks
  // that are not there.
  let best = null;
  for (const ratio of [1, 3 / 2, 2 / 3, 4 / 3, 3 / 4, 2, 1 / 2]) {
    const bpm = seed * ratio;
    if (bpm < 70 || bpm > 185) continue;
    const r = longestRun(onsets, 60 / bpm);
    if (!r) continue;
    const first = r.ts[0], last = r.ts[r.ts.length - 1];
    const expected = r.ks[r.ks.length - 1] + 1;
    let inside = 0;
    for (const t of onsets) if (t >= first - TOL_S && t <= last + TOL_S) inside++;
    r.score = (r.ts.length / expected) * (r.ts.length / Math.max(1, inside)) * Math.min(1, r.ts.length / 64);
    r.seed = bpm;
    // The seed's own tempo wins a near-tie: only a clearly better ratio replaces it.
    if (!best || r.score > best.score * (best.seed === seed ? 1.15 : 1)) best = r;
  }
  if (!best || best.ts.length < 48) return null;             // under twelve bars: keep the seed
  const n = best.ts.length;
  let sk = 0, st = 0, skk = 0, skt = 0;
  for (let j = 0; j < n; j++) { sk += best.ks[j]; st += best.ts[j]; skk += best.ks[j] * best.ks[j]; skt += best.ks[j] * best.ts[j]; }
  const period = (n * skt - sk * st) / (n * skk - sk * sk);
  const t0 = (st - period * sk) / n;
  let res = 0;
  for (let j = 0; j < n; j++) { const d = best.ts[j] - (t0 + period * best.ks[j]); res += d * d; }
  let bpm = 60 / period;
  // The fit must agree with the seed it started from; if it does not, the run
  // it followed was not the beat.
  if (!(Math.abs(bpm / best.seed - 1) < 0.02)) return null;
  // Produced dance music is overwhelmingly cut to a whole tempo. Inside the
  // measurement's own error, call it that.
  if (Math.abs(bpm - Math.round(bpm)) <= 0.02) bpm = Math.round(bpm);
  return { bpm: Math.round(bpm * 100) / 100, beats: n, residualMs: +(Math.sqrt(res / n) * 1000).toFixed(2) };
}
