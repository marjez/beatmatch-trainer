/**
 * pw_slow_phone.mjs — the app on something closer to a phone.
 *
 * Real touch input, a 6× CPU throttle, and a RELOAD between setting the crate
 * up and playing it. The in-page harness adds and plays in one fast session,
 * which is why it reported the practice beats as working while on the phone
 * they took thirteen seconds to become playable and read as "not playing".
 *
 * What it measures, for each deck: how long until the deck is ready, and
 * whether audio actually leaves the master when Play is pressed.
 *
 *   node tools/harness/pw_slow_phone.mjs [beats|demo] [throttle]
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MODE = process.argv[2] || 'beats';
const THROTTLE = +(process.argv[3] || 6);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const port = 8977;

const server = spawn('python3', ['-c', `
import sys, time; sys.path.insert(0, 'tools/harness')
from pathlib import Path
import browser_test as bt
bt.serve(Path('.').resolve(), ${port}, Path('/dev/null'))
print('up', flush=True)
while True: time.sleep(1)`], { cwd: root, stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise(r => server.stdout.once('data', r));

const env = { ...process.env };
if (env.HOME && !env.LD_LIBRARY_PATH) {
  env.LD_LIBRARY_PATH = `${env.HOME}/tools/libs/usr/lib/x86_64-linux-gnu:${env.HOME}/tools/libs/lib/x86_64-linux-gnu`;
  env.FONTCONFIG_FILE = `${env.HOME}/tools/fonts.conf`;
}
const browser = await chromium.launch({ headless: true, env, args: ['--no-sandbox', '--disable-dev-shm-usage', '--autoplay-policy=no-user-gesture-required'] });
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
const page = await ctx.newPage();
const logs = [];
page.on('console', m => logs.push(m.type() + ': ' + m.text()));
page.on('pageerror', e => logs.push('pageerror: ' + e.message));

const R = { mode: MODE, throttle: THROTTLE, failures: [] };
const fail = m => R.failures.push(m);
try {
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: THROTTLE });
  await page.goto(`http://127.0.0.1:${port}/index.html`);
  await page.waitForFunction(() => window.__bmt, null, { timeout: 30000 });

  if (MODE === 'beats') {
    await page.click('#beatsBtn');
    await page.waitForFunction(() => window.__bmt.tracks.length >= 11, null, { timeout: 60000 });
  } else {
    await page.click('#demoBtn');
    await page.waitForFunction(() => window.__bmt.tracks.length >= 2, null, { timeout: 300000 });
  }
  R.added = await page.evaluate(() => window.__bmt.tracks.length);

  // Reload: tracks now come back out of IndexedDB, as they do every launch.
  await page.reload({ waitUntil: 'load' });
  await page.waitForFunction(() => window.__bmt, null, { timeout: 30000 });
  await page.waitForTimeout(400);
  R.afterReload = await page.evaluate(() => ({
    tracks: window.__bmt.tracks.length,
    round: !!window.__bmt.round,
  }));
  if (!R.afterReload.round) fail('no round was dealt after reload');

  const t0 = Date.now();
  const ready = await page.waitForFunction(
    () => window.__bmt.decks.A.ready && window.__bmt.decks.B.ready, null, { timeout: 120000 },
  ).then(() => true).catch(() => false);
  R.readyMs = Date.now() - t0;
  R.ready = ready;
  if (!ready) fail('decks never became ready');
  // A deck the user cannot start within a couple of seconds reads as broken.
  if (ready && R.readyMs > 4000) fail(`decks took ${R.readyMs} ms to become playable`);

  if (ready) {
    R.play = await page.evaluate(async () => {
      const b = window.__bmt;
      const node = b.ctx.createAnalyser(); node.fftSize = 2048;
      (b.master.out || b.master.focus).connect(node);
      const buf = new Float32Array(node.fftSize);
      document.getElementById('playA').dispatchEvent(new PointerEvent('pointerdown',
        { bubbles: true, pointerId: 1, pointerType: 'touch', isPrimary: true }));
      let peak = 0;
      for (let i = 0; i < 40; i++) {
        await new Promise(r => setTimeout(r, 50));
        node.getFloatTimeDomainData(buf);
        for (const v of buf) peak = Math.max(peak, Math.abs(v));
      }
      return { peak: +peak.toFixed(4), playing: b.decks.A.playing, state: b.ctx.state };
    });
    if (!(R.play.peak > 0.01)) fail('no audio left the master after pressing play');
  }
  R.logs = logs.slice(-10);
  R.verdict = R.failures.length ? 'FAIL' : 'PASS';
} catch (e) {
  R.fatal = String(e && e.message || e);
  R.logs = logs.slice(-10);
}
await browser.close();
server.kill();
console.log(JSON.stringify(R, null, 1));
process.exit(R.failures.length || R.fatal ? 1 : 0);
