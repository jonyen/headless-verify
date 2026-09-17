// verify(url, async (page, check) => { ... }) runs checks against a page in
// headless Chrome and prints one line per check, console errors, and a summary.
// Exit codes: 0 all passed, 1 a check failed, 2 could not run.

import { loadPlaywright } from './load-playwright.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function screenshot(page, { path, clip, selector, maxWidth = 800, log = console.log }) {
  const target = selector ? page.locator(selector) : page;
  const box = selector ? await target.boundingBox() : clip ?? { x: 0, y: 0, ...page.viewportSize() };
  const scale = Math.min(1, maxWidth / box.width);
  const buffer = await target.screenshot({ ...(selector ? {} : { clip: box }), scale: 'css' });
  const { writeFile } = await import('node:fs/promises');
  if (scale < 1) {
    const small = await page.evaluate(
      async ({ data, scale }) => {
        const img = new Image();
        img.src = `data:image/png;base64,${data}`;
        await img.decode();
        const c = document.createElement('canvas');
        c.width = Math.round(img.width * scale);
        c.height = Math.round(img.height * scale);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        return c.toDataURL('image/png').split(',')[1];
      },
      { data: buffer.toString('base64'), scale },
    );
    await writeFile(path, Buffer.from(small, 'base64'));
  } else {
    await writeFile(path, buffer);
  }
  log(`saved ${path} (${Math.round(box.width * scale)}x${Math.round(box.height * scale)})`);
}

export async function verify(url, fn, opts = {}) {
  const {
    viewport = { width: 1280, height: 800 },
    timeout = 15_000,
    channel = 'chrome',
    headless = true,
    log = console.log,
    exit = process.argv[1] !== undefined && !process.argv[1].includes('node_modules') && opts.exit !== false,
  } = opts;
  const result = { passed: 0, failed: 0, consoleErrors: [], exitCode: 0 };

  let browser;
  let closed = false;
  const closeBrowser = async () => {
    if (browser && !closed) {
      closed = true;
      await browser.close();
    }
  };
  // Always close Chrome before exiting so a `node script.mjs` run never leaves
  // a stray Chrome process behind (process.exit() skips finally blocks).
  const finish = async () => {
    await closeBrowser();
    if (exit) process.exit(result.exitCode);
    return result;
  };

  const { chromium } = await loadPlaywright();
  try {
    browser = await chromium.launch({ channel, headless });
  } catch (err) {
    log(`could not launch ${channel}: ${err.message.split('\n')[0]}`);
    log("install Chromium with `npx playwright install chromium` and pass { channel: 'chromium' }");
    result.exitCode = 2;
    return finish();
  }

  const pageErrors = [];
  try {
    const page = await browser.newPage({ viewport });
    page.on('console', (msg) => {
      if (msg.type() === 'error') result.consoleErrors.push(msg.text());
    });
    page.on('pageerror', (err) => pageErrors.push(err.message));
    try {
      await page.goto(url, { waitUntil: 'load', timeout });
    } catch (err) {
      log(`could not open ${url}: ${err.message.split('\n')[0]}`);
      result.exitCode = 2;
      return finish();
    }

    const check = async (name, predicate) => {
      const deadline = Date.now() + timeout;
      let lastError;
      for (;;) {
        try {
          if (await predicate()) {
            result.passed += 1;
            log(`✓ ${name}`);
            return true;
          }
          lastError = undefined;
        } catch (err) {
          lastError = err;
        }
        if (Date.now() >= deadline) break;
        await sleep(100);
      }
      result.failed += 1;
      log(`✗ ${name}: ${lastError ? lastError.message.split('\n')[0] : `timed out after ${timeout / 1000}s`}`);
      return false;
    };

    try {
      await fn(page, check);
    } catch (err) {
      log(`script error: ${err.message.split('\n')[0]}`);
      if (result.passed + result.failed === 0) {
        result.exitCode = 2;
        return finish();
      }
      result.failed += 1;
    }
    for (const text of result.consoleErrors) log(`console.error: ${text}`);
    for (const message of pageErrors) log(`pageerror: ${message}`);
    log(`${result.passed} passed, ${result.failed} failed`);
    result.exitCode = result.failed > 0 ? 1 : 0;
    return finish();
  } catch (err) {
    await closeBrowser();
    throw err;
  }
}
