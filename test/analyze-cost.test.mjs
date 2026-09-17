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
  // Fixture is tool-result-only throughout: t1 400 chars / 100 tokens, t2 800 chars / 200
  // tokens (image tokens come from real pixel data, not from chars) — both exactly 4.
  assert.equal(calibration.impliedCharsPerToken, 4);
});

test('impliedCharsPerToken uses only turns whose arriving content is solely tool results', () => {
  // t0 -> t1: only tool result tA arrives (100 chars, no image). recorded growth 50.
  // t1 -> t2: tool result tB (50 chars) arrives alongside context:user content (60 chars) -
  //   this turn must be excluded entirely, in numerator and denominator.
  // t2 -> t3: only tool result tC arrives (30 chars, no image). recorded growth 15.
  // Expected: (100 + 30) / (50 + 15) = 130 / 65 = 2.
  const lines = [
    JSON.stringify({
      type: 'assistant',
      message: {
        id: 'm0',
        usage: { input_tokens: 0, cache_creation_input_tokens: 1000, cache_read_input_tokens: 0, output_tokens: 10 },
        content: [{ type: 'tool_use', id: 'tA', name: 'Bash', input: {} }],
      },
    }),
    JSON.stringify({
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 'tA', content: 'x'.repeat(100) }] },
    }),
    JSON.stringify({
      type: 'assistant',
      message: {
        id: 'm1',
        usage: { input_tokens: 0, cache_creation_input_tokens: 1060, cache_read_input_tokens: 0, output_tokens: 20 },
        content: [{ type: 'tool_use', id: 'tB', name: 'Bash', input: {} }],
      },
    }),
    JSON.stringify({
      type: 'user',
      message: {
        content: [
          { type: 'tool_result', tool_use_id: 'tB', content: 'x'.repeat(50) },
          { type: 'text', text: 'x'.repeat(60) },
        ],
      },
    }),
    JSON.stringify({
      type: 'assistant',
      message: {
        id: 'm2',
        usage: { input_tokens: 0, cache_creation_input_tokens: 1280, cache_read_input_tokens: 0, output_tokens: 15 },
        content: [{ type: 'tool_use', id: 'tC', name: 'Write', input: {} }],
      },
    }),
    JSON.stringify({
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 'tC', content: 'x'.repeat(30) }] },
    }),
    JSON.stringify({
      type: 'assistant',
      message: {
        id: 'm3',
        usage: { input_tokens: 0, cache_creation_input_tokens: 1310, cache_read_input_tokens: 0, output_tokens: 0 },
        content: [{ type: 'text', text: 'done' }],
      },
    }),
  ];
  const { calibration } = costBreakdown(parseTranscript(lines.join('\n')));
  assert.equal(calibration.impliedCharsPerToken, 2);
});

test('impliedCharsPerToken is n/a when no turn qualifies', () => {
  const { calibration } = costBreakdown({ results: [], turns: [{ index: 0, usage: { input: 0, cacheCreation: 0, cacheRead: 0, output: 0 } }] });
  assert.equal(calibration.impliedCharsPerToken, null);
});

test('CLI prints a markdown table without tool-result content', async () => {
  const { stdout } = await promisify(execFile)('node', [
    new URL('../analyze/session-cost.mjs', import.meta.url).pathname,
    fixturePath.pathname,
  ]);
  assert.match(stdout, /\| claude-in-chrome \| 1 \| 1 \|/);
  assert.match(stdout, /implied chars\/token \(tool-result-only turns\): 4\.00/);
  assert.doesNotMatch(stdout, /yyyy|xxxx|orphan/);
});
