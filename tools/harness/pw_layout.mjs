/**
 * pw_layout.mjs — is every mixer control ON SCREEN and under the thumb?
 *
 * Every other test drives controls by clicking the element directly, which says
 * nothing about whether a finger can reach it: the mixer is a fixed,
 * non-scrolling surface, so a control pushed past the viewport is simply gone,
 * and one sitting under an overlay or the toast is just as unreachable. A v30
 * screenshot appeared not to show a button that was in fact on screen under the
 * toast, and nothing in the suite could have told the difference.
 *
 * Controls inside #sheet are SKIPPED: the sheet is the one scrolling surface,
 * so its contents are legitimately below the fold while it is closed.
 *
 *   node tools/harness/pw_layout.mjs [shot-dir]
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SHOTS = process.argv[2] || null;
const port = 8991;

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
const browser = await chromium.launch({ headless: true, env, args: ['--no-sandbox', '--disable-dev-shm-usage'] });

// Everything a round is played with. If one of these is unreachable the app is
// broken on that screen however well the logic tests do.
const CONTROLS = ['playA', 'playB', 'cueA', 'cueB', 'xfTrack', 'xfKnob',
                  'faderTrackA', 'faderTrackB', 'faderKnobA', 'faderKnobB',
                  'nudgeUpA', 'nudgeDownA', 'nudgeUpB', 'nudgeDownB',
                  'focusBtn', 'newPairBtn', 'revealBtn', 'menuBtn'];
// Read, not pressed: they only have to be visible and not covered by anything.
const INDICATORS = ['pitchReadoutA', 'pitchReadoutB', 'zeroLedA', 'zeroLedB'];
const IDS = [...CONTROLS, ...INDICATORS];
// SE 2nd gen, 14/15, Pro Max, and landscape — which clips differently.
const VIEWPORTS = [{ w: 390, h: 844 }, { w: 375, h: 667 }, { w: 430, h: 932 }, { w: 844, h: 390 }];
const MIN = 22;   // a control collapsing below this is a layout regression

const R = { failures: [], sizes: {} };
try {
  for (const vp of VIEWPORTS) {
    const ctx = await browser.newContext({ viewport: { width: vp.w, height: vp.h }, hasTouch: true, isMobile: true });
    const page = await ctx.newPage();
    await page.goto(`http://127.0.0.1:${port}/index.html`);
    await page.waitForFunction(() => window.__bmt, null, { timeout: 30000 });
    // A real session: practice beats in the crate, sheet closed, round dealt.
    await page.click('#beatsBtn');
    await page.waitForFunction(() => window.__bmt.tracks.length >= 11, null, { timeout: 60000 });
    await page.evaluate(() => document.getElementById('sheetClose')?.click());
    await page.waitForTimeout(600);

    const key = `${vp.w}x${vp.h}`;
    R.sizes[key] = await page.evaluate(ids => {
      const sheet = document.getElementById('sheet');
      const vh = innerHeight, vw = innerWidth, out = {};
      for (const id of ids) {
        const el = document.getElementById(id);
        if (!el) { out[id] = 'MISSING'; continue; }
        if (sheet && sheet.contains(el)) { out[id] = 'IN_SHEET'; continue; }
        const r = el.getBoundingClientRect(), cs = getComputedStyle(el);
        const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
        out[id] = {
          y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height),
          off: r.bottom > vh + 0.5 || r.top < -0.5 || r.right > vw + 0.5 || r.left < -0.5,
          hidden: cs.display === 'none' || cs.visibility === 'hidden' || +cs.opacity === 0 || r.width < 1 || r.height < 1,
          // A tap at the centre must land on the control, or on something it owns.
          reach: !!(hit && (hit === el || el.contains(hit) || hit.contains(el))),
          hitId: hit ? (hit.id || hit.tagName.toLowerCase() + '.' + (hit.className || '')) : null,
        };
      }
      out._page = { vw, vh, bodyScroll: document.scrollingElement.scrollHeight > vh + 1 };
      return out;
    }, IDS);

    for (const [id, v] of Object.entries(R.sizes[key])) {
      if (id.startsWith('_') || v === 'IN_SHEET') continue;
      if (v === 'MISSING') { R.failures.push(`${key}: #${id} does not exist`); continue; }
      if (v.hidden) R.failures.push(`${key}: #${id} is not rendered (${v.w}x${v.h})`);
      else if (v.off) R.failures.push(`${key}: #${id} is off screen at y=${v.y} h=${v.h}`);
      else if (!v.reach) R.failures.push(`${key}: #${id} is covered by ${v.hitId}`);
      else if (CONTROLS.includes(id) && (v.w < MIN || v.h < MIN)) R.failures.push(`${key}: #${id} is only ${v.w}x${v.h}`);
    }
    // The mixer must not scroll — a page scroll steals the drag off the fader.
    if (R.sizes[key]._page.bodyScroll) R.failures.push(`${key}: the mixer surface scrolls`);
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/layout-${key}.png` });
    await ctx.close();
  }
  R.verdict = R.failures.length ? 'FAIL' : 'PASS';
} catch (e) {
  R.fatal = String(e && e.message || e);
}
await browser.close();
server.kill();
console.log(JSON.stringify(R, null, 1));
process.exit(R.failures.length || R.fatal ? 1 : 0);
