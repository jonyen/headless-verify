import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parseTranscript } from '../analyze/transcript.mjs';
import { costBreakdown, resultTokens } from '../analyze/cost.mjs';

const fixturePath = new URL('./fixtures/session-small.jsonl', import.meta.url);
const load = async () => parseTranscript(await readFile(fixturePath, 'utf8'));

test('resultTokens counts text by chars and images by pixels', () => {
  assert.deepEqual(
    resultTokens({ textChars: 401, images: [{ width: 1500, height: 1000 }, null] }),
    { text: 101, image: 2000 + 1600, total: 3701 },
  );
});

test('costBreakdown attributes direct and carry tokens per family', async () => {
  const { families, totals } = costBreakdown(await load());
  const chrome = families.find((f) => f.family === 'claude-in-chrome');
  const bash = families.find((f) => f.family === 'Bash');
  // t1: 100 text + 2000 image = 2100, requested at turn 0, read fresh by turn 1, re-read by turn 2.
  assert.equal(chrome.calls, 1);
  assert.equal(chrome.images, 1);
  assert.equal(chrome.directTokens, 2100);
  assert.equal(chrome.carryTokens, 2100);
  // t2: 200 text, requested at turn 1, read fresh by turn 2, no later turns.
  assert.equal(bash.directTokens, 200);
  assert.equal(bash.carryTokens, 0);
  assert.equal(totals.billedInput, 1010 + 3160 + 3400);
  assert.ok(Math.abs(chrome.shareOfInput - 4200 / 7570) < 1e-9);
});

test('calibration compares estimated and recorded context growth', async () => {
  const { calibration } = costBreakdown(await load());
  // turn1 growth: 3160 - 1010 - 50 = 2100 (estimated 2100); turn2: 3400 - 3160 - 40 = 200 (estimated 200)
  assert.equal(calibration.recorded, 2300);
  assert.equal(calibration.estimated, 2300);
  assert.equal(calibration.errorPct, 0);
});

test('CLI prints a markdown table without tool-result content', async () => {
  const { stdout } = await promisify(execFile)('node', [
    new URL('../analyze/session-cost.mjs', import.meta.url).pathname,
    fixturePath.pathname,
  ]);
  assert.match(stdout, /\| claude-in-chrome \| 1 \| 1 \|/);
  assert.doesNotMatch(stdout, /yyyy|xxxx|orphan/);
});
