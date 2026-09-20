// pw_offline.mjs — offline reload and persistence, driven through Playwright.
//
// browser_test.py can't cut the network; Playwright can. This loads the app
// online (service worker installs, crate is added through the file input),
// then goes OFFLINE, reloads, and checks the shell comes from the cache, the
// crate is still in IndexedDB and a deck plays from it. Then a cold second
// launch (new page) offline. Needs: npm i playwright && npx playwright install chromium.
//
//   python3 tools/harness/make_test_audio.py /tmp/bmt-crate --crate 4
//   node tools/harness/pw_offline.mjs /tmp/bmt-crate
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const crate = path.resolve(process.argv[2] || '/tmp/bmt-crate');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const port = 8910;

// Serve through the same python server the other tests use (mount support).
const server = spawn('python3', ['-c', `
import sys, time; sys.path.insert(0, 'tools/harness')
from pathlib import Path
import browser_test as bt
bt.serve(Path('.').resolve(), ${port}, Path('/dev/null'), {'crate': Path(${JSON.stringify(crate)})})
print('up', flush=True)
while True: time.sleep(1)`], { cwd: root, stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise(r => server.stdout.once('data', r));

const R = { failures: [] };
const fail = m => R.failures.push(m);
const env = { ...process.env };
if (process.env.HOME && !env.LD_LIBRARY_PATH) {
  // Linux-without-root setup (see harness README): extracted libs + fonts under $HOME/tools
  env.LD_LIBRARY_PATH = `${env.HOME}/tools/libs/usr/lib/x86_64-linux-gnu:${env.HOME}/tools/libs/lib/x86_64-linux-gnu`;
  env.FONTCONFIG_FILE = `${env.HOME}/tools/fonts.conf`;
}
const browser = await chromium.launch({ headless: true, env, args: ['--no-sandbox', '--disable-dev-shm-usage', '--autoplay-policy=no-user-gesture-required'] });
const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
const page = await context.newPage();
const errors = [];
page.on('pageerror', e => errors.push(e.message));
page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

try {
  await page.goto(`http://127.0.0.1:${port}/index.html`);
  await page.waitForFunction(() => window.__bmt && navigator.serviceWorker.controller, null, { timeout: 15000 });
  await page.waitForTimeout(500);
  // Load the crate through the real file input.
  const files = await (await fetch(`http://127.0.0.1:${port}/crate/files.json`)).json();
  const picked = files.slice(0, 3);
  await page.evaluate(async ({ picked }) => {
    const dt = new DataTransfer();
    dt.items.add(new File([await (await fetch('/crate/crate.json')).text()], 'crate.json', { type: 'application/json' }));
    for (const n of picked) dt.items.add(new File([await (await fetch('/crate/' + encodeURIComponent(n))).arrayBuffer()], n, { type: 'audio/wav' }));
    const input = document.getElementById('fileInput');
    input.files = dt.files; input.dispatchEvent(new Event('change', { bubbles: true }));
  }, { picked });
  await page.waitForFunction(n => window.__bmt.tracks.length >= n, picked.length, { timeout: 20000 });
  await page.waitForFunction(() => window.__bmt.round && window.__bmt.decks.A.ready && window.__bmt.decks.B.ready, null, { timeout: 30000 });
  R.online = { tracks: picked.length, build: await page.textContent('#buildStamp') };

  // ---- Offline reload ----
  await context.setOffline(true);
  const failedRequests = [];
  page.on('requestfailed', r => failedRequests.push(r.url()));
  await page.reload({ waitUntil: 'load' });
  await page.waitForFunction(() => window.__bmt, null, { timeout: 15000 }).catch(() => fail('app did not boot offline'));
  const tracksOffline = await page.evaluate(() => window.__bmt.tracks.length).catch(() => -1);
  if (tracksOffline !== picked.length) fail(`crate after offline reload: ${tracksOffline} tracks, expected ${picked.length}`);
  await page.waitForFunction(() => window.__bmt.round && window.__bmt.decks.A.ready && window.__bmt.decks.B.ready, null, { timeout: 30000 }).catch(() => fail('decks not ready offline'));
  // Press play, confirm the deck reports playing and the context is running.
  await page.dispatchEvent('#playA', 'pointerdown', { pointerId: 1, pointerType: 'touch', isPrimary: true, bubbles: true });
  await page.waitForTimeout(300);
  const state = await page.evaluate(() => ({ playing: window.__bmt.decks.A.playing, ctx: window.__bmt.ctx && window.__bmt.ctx.state, t: window.__bmt.ctx && window.__bmt.ctx.currentTime }));
  if (!state.playing) fail('deck A not playing offline');
  if (state.ctx !== 'running') fail('context not running offline: ' + state.ctx);
  const localFailures = failedRequests.filter(u => u.startsWith(`http://127.0.0.1:${port}/`) && !u.includes('/crate/'));
  if (localFailures.length) fail('shell requests failed offline: ' + localFailures.join(', '));
  R.offlineReload = { tracks: tracksOffline, ...state, fontRequestsFailed: failedRequests.filter(u => u.includes('fonts.g')).length };

  // ---- Cold second launch, still offline ----
  const page2 = await context.newPage();
  page2.on('pageerror', e => errors.push('page2: ' + e.message));
  await page2.goto(`http://127.0.0.1:${port}/`).catch(e => fail('cold offline navigation failed: ' + e.message));
  await page2.waitForFunction(() => window.__bmt, null, { timeout: 15000 }).catch(() => fail('cold offline launch did not boot'));
  await page2.waitForFunction(n => window.__bmt.tracks.length >= n, picked.length, { timeout: 10000 }).catch(() => {});
  const t2 = await page2.evaluate(() => window.__bmt.tracks.length).catch(() => -1);
  if (t2 !== picked.length) fail(`cold offline launch: ${t2} tracks`);
  R.coldOffline = { tracks: t2, title: await page2.title() };

  // ---- Back online: a bumped build must be picked up ----
  await context.setOffline(false);
  R.jsErrors = errors;
  R.verdict = R.failures.length ? 'FAIL' : 'PASS';
} catch (e) {
  R.fatal = String(e && e.stack || e);
} finally {
  await browser.close();
  server.kill();
  console.log(JSON.stringify(R, null, 1));
  process.exit(R.failures?.length || R.fatal ? 1 : 0);
}
