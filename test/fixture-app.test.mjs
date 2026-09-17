import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startFixture } from '../bench/server.mjs';
import { verify } from '../scripts/verify.mjs';

let fixture;
before(async () => { fixture = await startFixture(); });
after(() => fixture.close());

const opts = { log: () => {}, exit: false, timeout: 3000 };
const run = (variant, fn) => verify(`${fixture.url}?variant=${variant}`, fn, opts);

const checks = {
  load: async (page, check) => {
    await page.click('#load-btn');
    await check('load shows items', async () => (await page.textContent('#load-result')) === 'Loaded 3 items');
  },
  preview: async (page, check) => {
    const box = await page.locator('#track').boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await check('preview shows 0:30', async () => (await page.textContent('#preview')) === '0:30');
  },
  captions: async (page, check) => {
    await page.evaluate(() => new Promise((resolve) => {
      const v = document.getElementById('clip');
      v.muted = true;
      const go = () => { v.currentTime = 3.5; v.addEventListener('seeked', () => resolve(), { once: true }); };
      v.readyState >= 1 ? go() : v.addEventListener('loadedmetadata', go, { once: true });
    }));
    await check('word 3 active', async () => (await page.getAttribute('#captions [data-start="3"]', 'class'))?.includes('active'));
  },
  toolbar: async (page, check) => {
    await check('label inside toolbar', async () => {
      const bar = await page.locator('#toolbar').boundingBox();
      const label = await page.locator('#show-cuts').boundingBox();
      return label.x + label.width <= bar.x + bar.width + 0.5;
    });
  },
  form: async (page, check) => {
    await page.fill('#email', 'a@example.com');
    await page.click('#submit');
    await check('form saved', async () => (await page.textContent('#form-status')) === 'Saved');
  },
};

for (const [name, fn] of Object.entries(checks)) {
  test(`${name}: ok variant passes`, async () => {
    const r = await run('ok', fn);
    assert.equal(r.exitCode, 0);
    assert.deepEqual(r.consoleErrors, []);
  });
  test(`${name}: bug variant fails`, async () => {
    const r = await run('bug', fn);
    assert.equal(r.exitCode, 1);
  });
}
