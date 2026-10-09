/**
 * render_beats.mjs — render every practice beat to a WAV and measure it.
 *
 * Listening is the point, but the numbers catch what ears on a laptop miss:
 * whether the kick lands on the grid, whether it dominates the band you match
 * on, and whether anything clips. Both bugs in the first version of beats.js
 * showed up here first (swing scaling the step position instead of shifting
 * it; basslines burying the kick under 120 Hz).
 *
 *   node tools/harness/render_beats.mjs <out-dir> [seconds]
 */
import { renderBeat, defaultBeatSet } from '../../js/beats.js';
import fs from 'node:fs';

const SR = 44100;
const out = process.argv[2];
const SECONDS = +(process.argv[3] || 24);
if (!out) { console.error('need an output directory'); process.exit(1); }
fs.mkdirSync(out, { recursive: true });

const wav = (data, sr) => {
  const n = data.length, buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sr, 24); buf.writeUInt32LE(sr * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(data[i] * 32767))), 44 + i * 2);
  return buf;
};

// Kick-band envelope, the same measure tools/harness/tests/lib.js uses. The hop
// is round(sr/1000) SAMPLES, which is 0.9977 ms — treating it as 1 ms drifts
// 0.23% and makes late beats look late. That mistake has been made twice.
function kickEnvelope(buf, sr) {
  const w = 2 * Math.PI * 120 / sr, q = 0.7;
  const alpha = Math.sin(w) / (2 * q), cosw = Math.cos(w), a0 = 1 + alpha;
  const b = [(1 - cosw) / 2 / a0, (1 - cosw) / a0, (1 - cosw) / 2 / a0];
  const a = [(-2 * cosw) / a0, (1 - alpha) / a0];
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  const hop = Math.round(sr / 1000), env = [];
  let acc = 0, n = 0;
  for (let i = 0; i < buf.length; i++) {
    const y = b[0] * buf[i] + b[1] * x1 + b[2] * x2 - a[0] * y1 - a[1] * y2;
    x2 = x1; x1 = buf[i]; y2 = y1; y1 = y;
    acc += y * y; n++;
    if (n === hop) { env.push(Math.sqrt(acc / n)); acc = 0; n = 0; }
  }
  env.hopMs = hop / sr * 1000;
  return env;
}

const report = [];
let worst = null;
for (const b of defaultBeatSet()) {
  const buf = new Float32Array(Math.floor(SECONDS * SR));
  const t0 = performance.now();
  renderBeat(buf, { bpm: b.bpm, pattern: b.pattern, seed: b.seed, root: b.root, seconds: SECONDS, sampleRate: SR });
  const renderMs = performance.now() - t0;
  fs.writeFileSync(`${out}/${b.name.replace(/[^\w. -]/g, '')}.wav`, wav(buf, SR));

  let peak = 0, clipped = 0;
  for (const v of buf) { const a2 = Math.abs(v); if (a2 > peak) peak = a2; if (a2 >= 0.999) clipped++; }
  const env = kickEnvelope(buf, SR), hopMs = env.hopMs;
  const beatMs = 60000 / b.bpm;
  const mean = ms => {
    let s = 0, c = 0;
    for (let i = Math.round((ms - 15) / hopMs); i <= Math.round((ms + 15) / hopMs); i++) {
      if (env[i] !== undefined) { s += env[i]; c++; }
    }
    return c ? s / c : 0;
  };
  const beats = Math.floor(SECONDS * 1000 / beatMs) - 1;
  let on = 0, off = 0, hits = 0;
  for (let k = 0; k < beats; k++) {
    const e = mean(k * beatMs), o = mean((k + 0.5) * beatMs);
    on += e; off += o;
    if (e > o * 1.3) hits++;
  }
  let firstMs = 0, p = 0;
  for (let i = 0; i < Math.round(beatMs / hopMs); i++) if (env[i] > p) { p = env[i]; firstMs = Math.round(i * hopMs); }
  const row = { name: b.name, pattern: b.pattern, bpm: b.bpm, renderMs: +renderMs.toFixed(0),
                peak: +peak.toFixed(3), clipped, onOff: +(on / off).toFixed(2),
                onGrid: `${hits}/${beats}`, hitRate: +(hits / beats).toFixed(2), firstKickMs: firstMs };
  report.push(row);
  if (!worst || row.renderMs > worst) worst = row.renderMs;
}
console.log(JSON.stringify(report, null, 1));
console.error(`\nwrote ${report.length} wavs to ${out}; slowest render ${worst} ms for ${SECONDS}s`);
