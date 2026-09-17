# Recipes

Each recipe is a complete script. Before running any of them, resolve the import path: when
this skill loads, Claude Code shows this skill's base directory in the skill listing — the
helper is at `<skill base directory>/../../scripts/verify.mjs` (and `load-playwright.mjs`
beside it). Replace `/ABSOLUTE/PATH/TO/headless-verify/scripts/verify.mjs` below with that
resolved absolute path, and replace the URL with the app you're checking.

Never commit `.auth.json` (used in the authenticated-pages recipe below) — add it to
`.gitignore`.

## Media playback (captions/highlight follows video)

```js
// Replace with the resolved absolute path to this plugin's scripts/verify.mjs
import { verify } from '/ABSOLUTE/PATH/TO/headless-verify/scripts/verify.mjs';

await verify('http://localhost:5173', async (page, check) => {
  await page.evaluate(() => new Promise((resolve) => {
    const v = document.getElementById('clip');
    v.muted = true;
    const go = () => { v.currentTime = 3.5; v.addEventListener('seeked', () => resolve(), { once: true }); };
    v.readyState >= 1 ? go() : v.addEventListener('loadedmetadata', go, { once: true });
  }));
  await check('word 3 active', async () => (await page.getAttribute('#captions [data-start="3"]', 'class'))?.includes('active'));
});
```

## Hover preview

```js
// Replace with the resolved absolute path to this plugin's scripts/verify.mjs
import { verify } from '/ABSOLUTE/PATH/TO/headless-verify/scripts/verify.mjs';

await verify('http://localhost:5173', async (page, check) => {
  const box = await page.locator('#track').boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await check('preview shows 0:30', async () => (await page.textContent('#preview')) === '0:30');
});
```

## Form submission + console errors

```js
// Replace with the resolved absolute path to this plugin's scripts/verify.mjs
import { verify } from '/ABSOLUTE/PATH/TO/headless-verify/scripts/verify.mjs';

await verify('http://localhost:5173', async (page, check) => {
  await page.fill('#email', 'a@example.com');
  await page.click('#submit');
  await check('form saved', async () => (await page.textContent('#form-status')) === 'Saved');
});

// verify() already prints any console.error / pageerror lines it saw while
// the script ran, after the checks — no extra code needed to catch them.
```

## Layout overlap

```js
// Replace with the resolved absolute path to this plugin's scripts/verify.mjs
import { verify } from '/ABSOLUTE/PATH/TO/headless-verify/scripts/verify.mjs';

await verify('http://localhost:5173', async (page, check) => {
  await check('label inside toolbar', async () => {
    const bar = await page.locator('#toolbar').boundingBox();
    const label = await page.locator('#show-cuts').boundingBox();
    return label.x + label.width <= bar.x + bar.width + 0.5;
  });
});
```

## Drag (scrubber)

```js
// Replace with the resolved absolute path to this plugin's scripts/verify.mjs
import { verify } from '/ABSOLUTE/PATH/TO/headless-verify/scripts/verify.mjs';

await verify('http://localhost:5173', async (page, check) => {
  const bar = await page.locator('.scrubber').boundingBox();
  await page.mouse.move(bar.x + 5, bar.y + bar.height / 2);
  await page.mouse.down();
  await page.mouse.move(bar.x + bar.width * 0.75, bar.y + bar.height / 2, { steps: 10 });
  await page.mouse.up();
  await check('playhead near 75%', async () => {
    const t = await page.evaluate(() => document.querySelector('video').currentTime);
    const d = await page.evaluate(() => document.querySelector('video').duration);
    return Math.abs(t / d - 0.75) < 0.05;
  });
});
```

## Authenticated pages (save state once with a visible browser, reuse headless)

```js
// save-login.mjs — run once: node save-login.mjs, log in, then close the window.
// Replace with the resolved absolute path to this plugin's scripts/load-playwright.mjs
import { loadPlaywright } from '/ABSOLUTE/PATH/TO/headless-verify/scripts/load-playwright.mjs';
const { chromium } = await loadPlaywright();
const browser = await chromium.launch({ channel: 'chrome', headless: false });
const context = await browser.newContext();
const page = await context.newPage();
await page.goto('http://localhost:5173/login');
page.on('close', async () => { await context.storageState({ path: '.auth.json' }); await browser.close(); });
```

```js
// check.mjs — reuse the saved session headlessly.
// Replace with the resolved absolute path to this plugin's scripts/load-playwright.mjs
import { loadPlaywright } from '/ABSOLUTE/PATH/TO/headless-verify/scripts/load-playwright.mjs';
const { chromium } = await loadPlaywright();
const browser = await chromium.launch({ channel: 'chrome' });
const context = await browser.newContext({ storageState: '.auth.json' });
const page = await context.newPage();
await page.goto('http://localhost:5173/account');
console.log((await page.locator('h1').textContent()) === 'Your account' ? '✓ logged in' : '✗ not logged in');
await browser.close();
```
