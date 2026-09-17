import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { verify } from '../scripts/verify.mjs';

let server;
let url;
before(async () => {
  server = http.createServer((req, res) => {
    res.setHeader('content-type', 'text/html');
    res.end(`<button id="b">go</button><p id="out"></p>
      <script>
        document.getElementById('b').onclick = () => { document.getElementById('out').textContent = 'clicked'; };
        console.error('boom from page');
      </script>`);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${server.address().port}/`;
});
after(() => server.close());

const quiet = () => {
  const lines = [];
  return { lines, log: (l) => lines.push(l) };
};

test('passing and failing checks, console errors, exit code 1', async () => {
  const { lines, log } = quiet();
  const result = await verify(
    url,
    async (page, check) => {
      await page.click('#b');
      await check('output says clicked', async () => (await page.textContent('#out')) === 'clicked');
      await check('output says nope', async () => (await page.textContent('#out')) === 'nope');
    },
    { log, exit: false, timeout: 500 },
  );
  assert.equal(result.passed, 1);
  assert.equal(result.failed, 1);
  assert.equal(result.exitCode, 1);
  assert.ok(lines.includes('✓ output says clicked'));
  assert.ok(lines.some((l) => l.startsWith('✗ output says nope: timed out after 0.5s')));
  assert.ok(lines.includes('console.error: boom from page'));
  assert.equal(lines.at(-1), '1 passed, 1 failed');
});

test('unreachable URL exits with code 2', async () => {
  const { log } = quiet();
  const result = await verify('http://127.0.0.1:1/', async () => {}, { log, exit: false });
  assert.equal(result.exitCode, 2);
});

test('all checks passing exits 0', async () => {
  const { log } = quiet();
  const result = await verify(url, async (page, check) => {
    await check('button exists', async () => (await page.locator('#b').count()) === 1);
  }, { log, exit: false });
  assert.equal(result.exitCode, 0);
});
