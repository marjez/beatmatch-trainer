// pw_shot.mjs — screenshots of the real app at phone size, with a crate loaded.
//   node tools/harness/pw_shot.mjs /tmp/bmt-crate out-dir [width height]
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const crate = path.resolve(process.argv[2] || '/tmp/bmt-crate'), out = path.resolve(process.argv[3] || '.');
const W = +(process.argv[4] || 390), H = +(process.argv[5] || 844);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const port = 8911;
const server = spawn('python3', ['-c', `
import sys, time; sys.path.insert(0, 'tools/harness')
from pathlib import Path
import browser_test as bt
bt.serve(Path('.').resolve(), ${port}, Path('/dev/null'), {'crate': Path(${JSON.stringify(crate)})})
print('up', flush=True)
while True: time.sleep(1)`], { cwd: root, stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise(r => server.stdout.once('data', r));
const env = { ...process.env };
if (env.HOME && !env.LD_LIBRARY_PATH) { env.LD_LIBRARY_PATH = `${env.HOME}/tools/libs/usr/lib/x86_64-linux-gnu:${env.HOME}/tools/libs/lib/x86_64-linux-gnu`; env.FONTCONFIG_FILE = `${env.HOME}/tools/fonts.conf`; }
const browser = await chromium.launch({ headless: true, env, args: ['--no-sandbox', '--disable-dev-shm-usage', '--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 2, hasTouch: true, isMobile: true });
try {
  await page.goto(`http://127.0.0.1:${port}/index.html`);
  await page.waitForFunction(() => window.__bmt && navigator.serviceWorker.controller, null, { timeout: 15000 });
  await page.waitForTimeout(400);
  const files = await (await fetch(`http://127.0.0.1:${port}/crate/files.json`)).json();
  await page.evaluate(async ({ picked }) => {
    const dt = new DataTransfer();
    dt.items.add(new File([await (await fetch('/crate/crate.json')).text()], 'crate.json', { type: 'application/json' }));
    for (const n of picked) dt.items.add(new File([await (await fetch('/crate/' + encodeURIComponent(n))).arrayBuffer()], n, { type: 'audio/wav' }));
    const input = document.getElementById('fileInput'); input.files = dt.files; input.dispatchEvent(new Event('change', { bubbles: true }));
  }, { picked: files.slice(0, 4) });
  await page.waitForFunction(() => window.__bmt.round && window.__bmt.decks.A.ready && window.__bmt.decks.B.ready, null, { timeout: 30000 });
  await page.click('#sheetClose').catch(() => {});
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(out, 'mixer.png') });
  await page.click('#menuBtn'); await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(out, 'sheet.png'), fullPage: false });
  await page.evaluate(() => document.querySelector('.sheet-body').scrollTo(0, 99999)); await page.waitForTimeout(200);
  await page.screenshot({ path: path.join(out, 'sheet2.png') });
  await page.click('#sheetClose'); await page.waitForTimeout(200);
  await page.click('#revealBtn'); await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(out, 'reveal.png') });
  console.log('shots in', out);
} catch (e) { console.log('ERR', e.message); }
await browser.close(); server.kill();
