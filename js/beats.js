// beats.js — practice beats, synthesised on the device.
//
// Netlabel music is mostly sparse and minimal, which is the wrong material for
// learning to hear a flam: what you want is a loud, dry, unambiguous kick and a
// groove that keeps moving. These patterns are generated straight into the
// deck's window buffer, so:
//   - the tempo is exact to the sample and the downbeat IS buffer offset 0
//     (no grid analysis, no cue verification, nothing to get wrong),
//   - nothing is downloaded and nothing is stored: a beat track is a recipe
//     (pattern + bpm + seed), a few hundred bytes in IndexedDB,
//   - any BPM can exist, so pairs are never short of a mixable partner.
//
// They are deliberately DRY and PUNCHY — no reverb tail on the kick, sub and
// click in the same hit — because the whole exercise is hearing two transients
// drift apart. Musical enough to ride for three minutes, not trying to be a
// record.

const TAU = Math.PI * 2;

// Small deterministic PRNG so a named beat always renders identically.
function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}

// ---------- voices ----------
// Each writes into `out` at sample `at`, additively.
function kick(out, at, sr, { gain = 1, decay = 26, from = 160, to = 48, click = 0.5, sweep = 55 } = {}) {
  const n = Math.min(out.length - at, Math.floor(0.42 * sr));
  if (n <= 0) return;
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const env = Math.exp(-t * decay);
    // Pitch sweep: the drop from `from` to `to` is what makes a kick read as a
    // hit rather than a tone, and the fast head gives it a countable transient.
    const f = to + (from - to) * Math.exp(-t * sweep);
    phase += TAU * f / sr;
    let v = Math.sin(phase) * env;
    if (click && t < 0.006) v += click * (1 - t / 0.006) * Math.sin(TAU * 1800 * t);
    out[at + i] += v * gain;
  }
}

function snare(out, at, sr, rand, { gain = 0.5, decay = 30, tone = 190 } = {}) {
  const n = Math.min(out.length - at, Math.floor(0.22 * sr));
  if (n <= 0) return;
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const env = Math.exp(-t * decay);
    phase += TAU * tone / sr;
    const body = Math.sin(phase) * 0.5;
    const noise = (rand() * 2 - 1);
    out[at + i] += (body + noise * 0.8) * env * gain;
  }
}

function hat(out, at, sr, rand, { gain = 0.16, decay = 120, open = false } = {}) {
  const n = Math.min(out.length - at, Math.floor((open ? 0.16 : 0.035) * sr));
  if (n <= 0) return;
  const d = open ? decay * 0.22 : decay;
  let hp = 0, prev = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const x = rand() * 2 - 1;
    hp = 0.86 * (hp + x - prev);          // one-pole high-pass: metallic, not hissy
    prev = x;
    out[at + i] += hp * Math.exp(-t * d) * gain;
  }
}

function clap(out, at, sr, rand, { gain = 0.42 } = {}) {
  // Three fast repeats then a body — what makes a clap sound like hands.
  for (const [off, g] of [[0, 0.6], [0.011, 0.8], [0.022, 1]]) {
    const start = at + Math.floor(off * sr);
    const n = Math.min(out.length - start, Math.floor(0.18 * sr));
    for (let i = 0; i < n; i++) {
      const t = i / sr;
      let hp = (rand() * 2 - 1);
      out[start + i] += hp * Math.exp(-t * (off === 0.022 ? 22 : 90)) * gain * g;
    }
  }
}

function bass(out, at, sr, freq, seconds, { gain = 0.35, decay = 7 } = {}) {
  const n = Math.min(out.length - at, Math.floor(seconds * sr));
  if (n <= 0) return;
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    phase += TAU * freq / sr;
    // Slightly saturated sine: audible on a phone speaker, still low.
    const v = Math.tanh(Math.sin(phase) * 1.6) * Math.exp(-t * decay) * (1 - Math.exp(-t * 400));
    out[at + i] += v * gain;
  }
}

function stab(out, at, sr, freq, seconds, { gain = 0.14 } = {}) {
  const n = Math.min(out.length - at, Math.floor(seconds * sr));
  if (n <= 0) return;
  let p1 = 0, p2 = 0, p3 = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const env = Math.exp(-t * 9) * (1 - Math.exp(-t * 300));
    p1 += TAU * freq / sr; p2 += TAU * freq * 1.26 / sr; p3 += TAU * freq * 1.5 / sr;
    out[at + i] += (Math.sin(p1) + Math.sin(p2) * 0.7 + Math.sin(p3) * 0.5) * env * gain * 0.4;
  }
}

// ---------- patterns ----------
// A pattern fills one bar of 16 steps. `swing` shifts every odd 16th late, which
// is most of what "groove" means on a straight 4/4 pattern.
export const PATTERNS = {
  house: {
    label: 'House',
    swing: 0.04,
    notes: [0, 3, 5, 7, 10, 12],            // scale degrees the bass walks
    render(ctx) {
      const { step, bar, out, sr, rand, at } = ctx;
      for (let s = 0; s < 16; s++) {
        const t = at(s);
        if (s % 4 === 0) kick(out, t, sr, { gain: 1 });
        if (s % 8 === 4) clap(out, t, sr, rand);
        if (s % 2 === 1) hat(out, t, sr, rand, { gain: 0.14, open: s % 4 === 3 });
        if (s % 4 === 2) ctx.bassNote(s, 0.5);           // offbeat bass, the house signature
      }
      if (bar % 4 === 3) for (const s of [13, 14, 15]) snare(ctx.out, at(s), sr, rand, { gain: 0.3, decay: 40 });
    },
  },
  funky: {
    label: 'Funky house',
    swing: 0.12,
    notes: [0, 3, 5, 10, 12, 15],
    render(ctx) {
      const { out, sr, rand, at, bar } = ctx;
      for (let s = 0; s < 16; s++) {
        const t = at(s);
        if (s % 4 === 0) kick(out, t, sr, { gain: 0.95, decay: 30 });
        if (s === 4 || s === 12) clap(out, t, sr, rand, { gain: 0.5 });
        if (s % 2 === 1) hat(out, t, sr, rand, { gain: s % 4 === 3 ? 0.2 : 0.11, open: s % 8 === 7 });
        if ([2, 6, 7, 10, 14, 15].includes(s)) ctx.bassNote(s, 0.28);   // syncopated, walking
        if (bar % 2 === 1 && (s === 6 || s === 14)) stab(out, t, sr, 220 * Math.pow(2, 3 / 12), 0.35);
      }
    },
  },
  techhouse: {
    label: 'Tech house',
    swing: 0.06,
    notes: [0, 0, 7, 10],
    render(ctx) {
      const { out, sr, rand, at, bar } = ctx;
      for (let s = 0; s < 16; s++) {
        const t = at(s);
        if (s % 4 === 0) kick(out, t, sr, { gain: 1, decay: 32, from: 140, to: 45 });
        if (s === 4 || s === 12) clap(out, t, sr, rand, { gain: 0.35 });
        if (s % 2 === 1) hat(out, t, sr, rand, { gain: 0.1 });
        if (s % 4 === 2) ctx.bassNote(s, 0.42);
        if (bar % 8 === 7 && s >= 12) hat(out, t, sr, rand, { gain: 0.22, open: true });
      }
    },
  },
  techno: {
    label: 'Techno',
    swing: 0,
    // Bass an octave and a half up, short, so the kick owns everything under
    // ~120 Hz: with it at 110 Hz the on-beat/off-beat kick ratio sat at 1.5,
    // i.e. the beat was no longer the loudest thing in the band you match on.
    bassOct: 4, bassGain: 0.2,
    notes: [0, 0, 0, 5],
    render(ctx) {
      const { out, sr, rand, at, bar } = ctx;
      for (let s = 0; s < 16; s++) {
        const t = at(s);
        // Fast sweep: a slow one leaves the sub blooming, and the envelope peak
        // landed 21 ms after the beat instead of on it.
        if (s % 4 === 0) kick(out, t, sr, { gain: 1.05, decay: 24, from: 150, to: 46, click: 0.8, sweep: 110 });
        if (s % 2 === 1) hat(out, t, sr, rand, { gain: 0.12, open: s % 8 === 7 });
        if (s % 8 === 4) snare(out, t, sr, rand, { gain: 0.28, decay: 45, tone: 220 });
        if (s % 4 === 2) ctx.bassNote(s, 0.16);
        if (bar % 16 === 15 && s % 2 === 0) hat(out, t, sr, rand, { gain: 0.18 });
      }
    },
  },
  breaks: {
    label: 'Breakbeat',
    swing: 0.08,
    bassOct: 2, bassGain: 0.26,
    notes: [0, 5, 7, 10],
    render(ctx) {
      const { out, sr, rand, at } = ctx;
      // Kick on 1 and the "and" of 3, snare on 2 and 4 — the amen skeleton.
      for (const s of [0, 6, 10]) kick(out, at(s), sr, { gain: 1, decay: 28 });
      for (const s of [4, 12]) snare(out, at(s), sr, rand, { gain: 0.5, tone: 260 });
      for (let s = 1; s < 16; s += 2) hat(out, at(s), sr, rand, { gain: 0.13, open: s === 7 });
      for (const s of [2, 8, 14]) ctx.bassNote(s, 0.3);
    },
  },
};

// ---------- render ----------
// Fills `out` with `seconds` of the pattern at `bpm`, starting exactly on beat 1
// of bar 1. Returns nothing: the caller owns the buffer (the deck's pool).
export function renderBeat(out, { bpm, pattern = 'house', seed = 1, root = 55, seconds, sampleRate }) {
  const sr = sampleRate;
  const P = PATTERNS[pattern] || PATTERNS.house;
  const rand = rng(seed * 2654435761);
  const beat = 60 / bpm;
  const stepS = beat / 4;
  const total = Math.min(out.length, Math.floor((seconds || out.length / sr) * sr));
  out.fill(0, 0, total);

  const bars = Math.ceil(total / (stepS * 16 * sr));
  for (let bar = 0; bar < bars; bar++) {
    const barStart = bar * 16 * stepS;
    // 32-bar arrangement: drop the bass for 8 bars every 32 so there is
    // something to listen to over a three-minute round, and so the kick is
    // exposed now and then — which is when a flam is easiest to hear.
    const phase = bar % 32;
    const quiet = phase >= 24 && phase < 28;
    // Swing SHIFTS an odd 16th late by a fraction of a step. Multiplying the
    // position by (1+swing) instead scales it, so step 15 landed nearly two
    // steps late and the pattern smeared — measured as a collapsed on-beat
    // energy ratio before this was fixed.
    const at = s => Math.round((barStart + (s + (s % 2 ? P.swing : 0)) * stepS) * sr);
    const ctx = {
      out, sr, rand, bar, step: stepS, at,
      bassNote(s, len) {
        if (quiet) return;
        const deg = P.notes[(bar * 4 + (s >> 2)) % P.notes.length];
        // THE KICK OWNS THE LOW END. A bassline sitting at 55 Hz on the
        // offbeats competes with it: measured, techno and breaks fell to an
        // on-beat/off-beat kick-band ratio of 1.3 and 0.97, i.e. the kick was
        // no longer the loudest thing on the beat — which is precisely what
        // you listen to when matching. Patterns that lean on offbeat bass put
        // it an octave up, out of the kick's way.
        const oct = P.bassOct || 1;
        bass(out, at(s), sr, root * oct * Math.pow(2, deg / 12), len * beat, { gain: P.bassGain || 0.33 });
      },
    };
    P.render(ctx);
  }
  // Gentle ceiling: voices are additive and a kick landing with a bass note can
  // otherwise poke past full scale before the 0.5 master bus ever sees it.
  for (let i = 0; i < total; i++) out[i] = Math.tanh(out[i] * 0.8);
}

// A set worth practising on: every pattern at a few tempos, spread so that any
// two are mixable at ±8% but rarely identical.
export function defaultBeatSet() {
  const set = [];
  const plan = [
    ['house', [122, 126, 128]],
    ['funky', [124, 127]],
    ['techhouse', [126, 130]],
    ['techno', [132, 136, 140]],
    ['breaks', [128]],
  ];
  let seed = 1;
  for (const [pattern, bpms] of plan) {
    for (const bpm of bpms) {
      // Decimal tempos on purpose: whole numbers make r0 land suspiciously
      // round, and CLAUDE.md is explicit that BPMs are never rounded.
      const exact = +(bpm + (seed % 7) * 0.13).toFixed(2);
      set.push({ pattern, bpm: exact, seed: seed++, root: 55 * Math.pow(2, (seed % 4) / 12),
                 name: `${PATTERNS[pattern].label} ${exact}bpm` });
    }
  }
  return set;
}
