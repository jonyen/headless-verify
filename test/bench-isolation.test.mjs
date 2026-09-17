import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { stagePlugin } from '../bench/stage.mjs';
import { parseStream } from '../bench/stream.mjs';

const repo = fileURLToPath(new URL('..', import.meta.url));
const read = (p) => readFile(new URL(`../${p}`, import.meta.url), 'utf8');

test('stagePlugin copies only the plugin, with playwright-core resolvable', async () => {
  const dest = await mkdtemp(join(tmpdir(), 'hv-stage-test-'));
  try {
    await stagePlugin(repo, dest);
    const entries = (await readdir(dest)).sort();
    assert.deepEqual(entries, ['.claude-plugin', 'node_modules', 'scripts', 'skills']);
    assert.deepEqual(await readdir(join(dest, 'node_modules')), ['playwright-core']);
    for (const banned of ['bench', 'docs', 'test', 'analyze', 'README.md', 'package.json']) {
      assert.ok(!existsSync(join(dest, banned)), `${banned} must not be staged`);
    }
    assert.ok(existsSync(join(dest, '.claude-plugin', 'plugin.json')));
    assert.ok(existsSync(join(dest, 'skills', 'verifying-web-apps-headlessly', 'SKILL.md')));
    assert.ok(existsSync(join(dest, 'scripts', 'verify.mjs')));
    const { loadPlaywright } = await import(pathToFileURL(join(dest, 'scripts', 'load-playwright.mjs')).href);
    const pw = await loadPlaywright();
    assert.equal(typeof pw.chromium.launch, 'function');
  } finally {
    await rm(dest, { recursive: true, force: true });
  }
});

test('skill docs do not reuse the fixture app selectors or expected strings', async () => {
  const html = await read('bench/fixture-app/index.html');
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(ids.length >= 10);
  for (const doc of ['skills/verifying-web-apps-headlessly/SKILL.md', 'skills/verifying-web-apps-headlessly/reference.md']) {
    const text = await read(doc);
    for (const id of ids) {
      const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      assert.ok(!new RegExp(`#${escaped}(?![\\w-])`).test(text), `${doc} mentions #${id}`);
      assert.ok(!text.includes(`getElementById('${id}')`), `${doc} looks up #${id} by id`);
    }
    for (const s of ['Loaded 3 items', '0:30', 'Saved', 'Show cuts']) {
      assert.ok(!text.includes(s), `${doc} contains fixture string ${s}`);
    }
  }
});

const toolUse = (input) => JSON.stringify({
  type: 'assistant',
  message: { content: [{ type: 'text', text: 'looking' }, { type: 'tool_use', name: 'Bash', input }] },
});
const result = JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: '{"works": true}' });

test('parseStream flags tool inputs that reach for benchmark internals', () => {
  assert.equal(parseStream([toolUse({ command: 'node /tmp/check.mjs' }), result].join('\n')).leakSuspect, false);
  for (const needle of ['cat ../bench/variants.mjs', 'ls /x/bench/', 'open fixture-app/index.html', 'grep docs/superpowers', 'cat test/fixture-app.test.mjs']) {
    const parsed = parseStream([toolUse({ command: needle }), result].join('\n'));
    assert.equal(parsed.leakSuspect, true, needle);
  }
  // Only assistant tool_use inputs count, not prompt text or results.
  const userText = JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', content: 'bench/ fixture-app' }] } });
  assert.equal(parseStream([userText, result].join('\n')).leakSuspect, false);
});
