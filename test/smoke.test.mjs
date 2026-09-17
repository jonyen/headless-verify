import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('package and plugin manifests agree on name and version', async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const plugin = JSON.parse(
    await readFile(new URL('../.claude-plugin/plugin.json', import.meta.url), 'utf8'),
  );
  assert.equal(pkg.name, 'headless-verify');
  assert.equal(plugin.name, pkg.name);
  assert.equal(plugin.version, pkg.version);
});
