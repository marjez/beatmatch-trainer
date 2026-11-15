/**
 * pw_upgrade.mjs — does a phone that INSTALLED AN OLD BUILD still work offline
 * after the deploy moves on?  pw_offline.mjs only ever sees one build.
 *
 *   node tools/harness/pw_upgrade.mjs <old-tree> <new-tree> <crate-dir> [update|noupdate]
 */
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const [oldRoot, newRoot, crate, mode = 'update'] = process.argv.slice(2);
const port = 8993;
let root = oldRoot;
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.wav': 'audio/wav', '.mp3': 'audio/mpeg' };
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p.endsWith('/')) p += 'index.html';
  const file = p.startsWith('/crate/') ? path.join(crate, p.slice(7)) : path.join(root, p);
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); res.end(); return; }
    // GitHub Pages serves everything with max-age=600.
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'max-age=600' });
    res.end(buf);
  });
}).listen(port, '127.0.0.1');

const env = { ...process.env };
if (env.HOME && !env.LD_LIBRARY_PATH) {
  env.LD_LIBRARY_PATH = `${env.HOME}/tools/libs/usr/lib/x86_64-linux-gnu:${env.HOME}/tools/libs/lib/x86_64-linux-gnu`;
  env.FONTCONFIG_FILE = `${env.HOME}/tools/fonts.conf`;
}
const browser = await chromium.launch({ headless: true, env, args: ['--no-sandbox', '--disable-dev-shm-usage', '--autoplay-policy=no-user-gesture-required'] });
const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
const R = { mode, failures: [], steps: {} };
const fail = m => R.failures.push(m);
const URL0 = `http://127.0.0.1:${port}/`;
const open = async label => {
  const page = await context.newPage();
  const log = [];
  page.on('pageerror', e => log.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') log.push('console: ' + m.text()); });
  page.on('requestfailed', r => { if (r.url().startsWith(URL0)) log.push('failed: ' + r.url().slice(URL0.length)); });
  await page.goto(URL0).catch(e => log.push('navigation: ' + e.message));
  // The old build may predate the harness handle; it only has to install.
  if (label !== 'old') await page.waitForFunction(() => window.__bmt, null, { timeout: 15000 }).catch(() => log.push('app did not boot'));
  R.steps[label] = { log };
  return page;
};
const state = page => page.evaluate(async () => ({
  build: document.getElementById('buildStamp')?.textContent || null,
  tracks: window.__bmt ? window.__bmt.tracks.length : -1,
  withBpm: window.__bmt ? window.__bmt.tracks.filter(t => t.bpm).length : -1,
  round: !!(window.__bmt && window.__bmt.round),
  ready: !!(window.__bmt && window.__bmt.decks.A.ready && window.__bmt.decks.B.ready),
  caches: await caches.keys(),
  controller: !!navigator.serviceWorker.controller,
  waiting: !!(await navigator.serviceWorker.getRegistration())?.waiting,
})).catch(e => ({ error: e.message }));

try {
  // 1. The old build, installed and used: tracks added with no grid file.
  let page = await open('old');
  await page.waitForFunction(() => navigator.serviceWorker.controller, null, { timeout: 15000 });
  await page.waitForTimeout(1500);   // the first worker claiming the page may reload it
  const files = (await (await fetch(`${URL0}crate/files.json`)).json()).filter(n => /House/.test(n));
  await page.evaluate(async files => {
    const dt = new DataTransfer();
    for (const n of files) dt.items.add(new File([await (await fetch('/crate/' + encodeURIComponent(n))).arrayBuffer()], n, { type: 'audio/wav' }));
    const input = document.getElementById('fileInput');
    input.files = dt.files; input.dispatchEvent(new Event('change', { bubbles: true }));
  }, files);
  await page.waitForTimeout(6000);
  Object.assign(R.steps.old, await state(page));
  await page.close();

  // 2. The deploy moves on; the app is opened again, online.
  root = newRoot;
  page = await open('new-online');
  await page.waitForTimeout(3000);
  if (mode === 'update') {
    // What the owner was told to do: Check for update, then reopen.
    await page.evaluate(() => document.getElementById('forceUpdate').click());
    await page.waitForTimeout(4000);
    await page.waitForFunction(() => window.__bmt, null, { timeout: 15000 }).catch(() => {});
    await page.evaluate(() => document.getElementById('forceUpdate').click()).catch(() => {});
    await page.waitForTimeout(4000);
    await page.waitForFunction(() => window.__bmt, null, { timeout: 15000 }).catch(() => {});
  }
  await page.waitForFunction(() => window.__bmt.round && window.__bmt.decks.A.ready && window.__bmt.decks.B.ready, null, { timeout: 30000 }).catch(() => {});
  Object.assign(R.steps['new-online'], await state(page));
  await page.close();

  // 3. Airplane mode, cold launch, play.
  await context.setOffline(true);
  page = await open('offline');
  await page.waitForFunction(() => window.__bmt.round && window.__bmt.decks.A.ready && window.__bmt.decks.B.ready, null, { timeout: 30000 }).catch(() => fail('decks never became ready offline'));
  await page.dispatchEvent('#playA', 'pointerdown', { pointerId: 1, pointerType: 'touch', isPrimary: true, bubbles: true }).catch(() => {});
  await page.waitForTimeout(800);
  const s = await state(page);
  s.playing = await page.evaluate(() => !!window.__bmt.decks.A.playing).catch(() => false);
  s.toasts = await page.evaluate(() => window.__bmt.toastLog || document.getElementById('toast')?.textContent).catch(() => null);
  Object.assign(R.steps.offline, s);
  if (!s.playing) fail('deck A does not play offline after the upgrade');
  if (R.steps.offline.log.length) fail('errors offline: ' + R.steps.offline.log.join(' | '));
  R.verdict = R.failures.length ? 'FAIL' : 'PASS';
} catch (e) { R.fatal = String(e && e.stack || e); }
await browser.close(); server.close();
console.log(JSON.stringify(R, null, 1));
process.exit(R.failures.length || R.fatal ? 1 : 0);
