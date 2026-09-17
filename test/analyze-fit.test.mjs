import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fitRatios, buildObservations } from '../analyze/fit.mjs';
import { costBreakdown } from '../analyze/cost.mjs';
import { parseTranscript } from '../analyze/transcript.mjs';

// Deterministic pseudo-random generator (LCG) so the synthetic data never changes.
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

function synthetic({ n = 100, tool = 1.5, context = 3.5, noise = 0.03, contextEvery = 2, seed = 7 } = {}) {
  const r = rng(seed);
  const obs = [];
  for (let turn = 1; turn <= n; turn++) {
    const toolChars = Math.round(200 + r() * 20000);
    const contextChars = turn % contextEvery === 0 ? Math.round(100 + r() * 8000) : 0;
    const imageTokens = turn % 7 === 0 ? 1600 : 0;
    const exact = toolChars / tool + contextChars / context + imageTokens;
    const recorded = Math.round(exact * (1 + (r() * 2 - 1) * noise));
    obs.push({ turn, recorded, toolChars, contextChars, imageTokens });
  }
  return obs;
}

const within = (actual, expected, pct) => Math.abs(actual - expected) / expected <= pct / 100;

test('fitRatios recovers known tool and context ratios within 5% with low holdout error', () => {
  const fit = fitRatios(synthetic());
  assert.equal(fit.method, 'fitted');
  assert.ok(within(fit.toolCharsPerToken, 1.5, 5), `tool ${fit.toolCharsPerToken}`);
  assert.ok(within(fit.contextCharsPerToken, 3.5, 5), `context ${fit.contextCharsPerToken}`);
  assert.equal(fit.observations, 100);
  assert.equal(fit.dropped, 0);
  assert.ok(fit.summedHoldoutErrorPct < 3, `summed ${fit.summedHoldoutErrorPct}`);
  assert.ok(fit.medianTurnHoldoutErrorPct < 5, `median ${fit.medianTurnHoldoutErrorPct}`);
});

test('the criterion is the median per-turn holdout error, and there are no overhead fields', () => {
  const fit = fitRatios(synthetic({ noise: 0.1 }));
  assert.equal(fit.criterion, 'medianTurnHoldoutErrorPct');
  assert.equal(typeof fit.medianTurnHoldoutErrorPct, 'number');
  assert.equal(fit[fit.criterion], fit.medianTurnHoldoutErrorPct);
  assert.equal(typeof fit.summedHoldoutErrorPct, 'number');
  assert.notEqual(fit.medianTurnHoldoutErrorPct, fit.summedHoldoutErrorPct);
  assert.equal('holdoutErrorPct' in fit, false);
  for (const key of Object.keys(fit)) assert.doesNotMatch(key, /overhead/i);
  const fixed = fitRatios(synthetic({ n: 5 }));
  assert.equal(fixed.criterion, 'medianTurnHoldoutErrorPct');
  assert.equal(fixed.medianTurnHoldoutErrorPct, null);
  for (const key of Object.keys(fixed)) assert.doesNotMatch(key, /overhead/i);
});

// Synthetic transcript: every turn gets tool text at 1.5 chars/token; context resets after turn `dropAt`.
function syntheticTranscript({ n = 80, dropAt = 40, marker = false } = {}) {
  const r = rng(11);
  const turns = [];
  const results = [];
  let ctx = 5000;
  for (let k = 0; k < n; k++) {
    if (k > 0) {
      const chars = results.filter((x) => x.turn === k - 1).reduce((s, x) => s + x.textChars, 0);
      ctx += turns[k - 1].usage.output + Math.round(chars / 1.5);
      if (k === dropAt) ctx = 3000; // compaction: context resets below the previous turn
    }
    turns.push({ index: k, usage: { input: 10, cacheCreation: 0, cacheRead: ctx - 10, output: 50 } });
    results.push({ name: 'Bash', turn: k, textChars: Math.round(300 + r() * 3000), images: [] });
  }
  return { turns, results, compactBoundaries: marker ? [dropAt] : [] };
}

test('a context drop excludes the drop turn; a normal following turn is kept', () => {
  const obs = buildObservations(syntheticTranscript());
  const fit = fitRatios(obs);
  assert.equal(fit.method, 'fitted');
  assert.deepEqual(fit.excluded, { contextDrop: 1, compactMarker: 0, afterDrop: 0, nonPositiveGrowth: 0 });
  assert.equal(fit.observations, obs.length - 1);
  assert.ok(within(fit.toolCharsPerToken, 1.5, 5), `tool ${fit.toolCharsPerToken}`);
  assert.ok(fit.medianTurnHoldoutErrorPct < 2, `median ${fit.medianTurnHoldoutErrorPct}`);
});

test('the turn after a drop is excluded when its growth is over 5x the session median', () => {
  const t = syntheticTranscript();
  // Inflate turn 41's context so its growth is far above 5x the median growth.
  for (let k = 41; k < t.turns.length; k++) t.turns[k].usage.cacheRead += 200000;
  const fit = fitRatios(buildObservations(t));
  assert.deepEqual(fit.excluded, { contextDrop: 1, compactMarker: 0, afterDrop: 1, nonPositiveGrowth: 0 });
});

test('the turn after a drop is excluded when its growth is negative, and not at 4x the median', () => {
  // Build a following turn with negative growth but no context drop: output larger than growth.
  const t2 = syntheticTranscript();
  t2.turns[40].usage.output = 100000;
  const o2 = buildObservations(t2).find((o) => o.turn === 41);
  assert.ok(o2.recorded < 0);
  assert.equal(o2.reset, 'after');
  const mid = syntheticTranscript();
  const obs = buildObservations(mid);
  const growths = obs.filter((o) => !o.reset).map((o) => o.recorded).sort((x, y) => x - y);
  const median = growths[growths.length >> 1];
  const target = obs.find((o) => o.turn === 41).recorded;
  for (let k = 41; k < mid.turns.length; k++) mid.turns[k].usage.cacheRead += Math.max(0, 4 * median - target);
  assert.equal(buildObservations(mid).find((o) => o.turn === 41).reset, null);
});

test('an explicit compact marker excludes only the turn it lands on', () => {
  const t = syntheticTranscript({ dropAt: 1000 });
  t.compactBoundaries = [30];
  const fit = fitRatios(buildObservations(t));
  assert.deepEqual(fit.excluded, { contextDrop: 0, compactMarker: 1, afterDrop: 0, nonPositiveGrowth: 0 });
  assert.equal(fit.compactMarkers, 1);
});

const jsonl = (lines) => lines.map((l) => JSON.stringify(l)).join('\n');
const asst = (id) => ({ type: 'assistant', message: { id, usage: { input_tokens: 1, output_tokens: 1 }, content: [] } });

test('parseTranscript records compact_boundary and isCompactSummary positions without content', () => {
  const a = parseTranscript(jsonl([asst('a'), { type: 'system', subtype: 'compact_boundary' }, { type: 'user', isCompactSummary: true, message: { content: 'summary' } }, asst('b')]));
  assert.deepEqual(a.compactBoundaries, [1]);
  const b = parseTranscript(jsonl([asst('a'), asst('b'), { type: 'user', isCompactSummary: true, message: { content: 'summary' } }, asst('c')]));
  assert.deepEqual(b.compactBoundaries, [2]);
});

test('attachment characters count as context for the turn they arrive before', () => {
  const t = parseTranscript(jsonl([
    { type: 'attachment', attachment: { type: 'skill_listing', content: 'x'.repeat(999) } }, // before first turn: not growth
    asst('a'),
    // rendered form present: count its content only
    { type: 'attachment', attachment: { type: 'hook_success', content: 'y'.repeat(50), stdout: 'y'.repeat(50), command: 'zz' }, rendered: [{ content: 'r'.repeat(30) }, { content: 'r'.repeat(12) }] },
    // no rendered form, known sent type: string fields other than metadata
    { type: 'attachment', attachment: { type: 'total_tokens_reminder', text: 't'.repeat(20) } },
    // not sent to the model: not counted
    { type: 'attachment', attachment: { type: 'prompt_snapshot', systemPrompt: ['p'.repeat(5000)] } },
    { type: 'queue-operation', operation: 'enqueue', content: 'q'.repeat(700) },
    asst('b'),
    { type: 'user', message: { content: 'u'.repeat(8) } },
    asst('c'),
  ]));
  assert.equal(t.attachmentChars, 62);
  const obs = buildObservations(t);
  assert.deepEqual(obs.map((o) => [o.turn, o.toolChars, o.contextChars]), [[1, 0, 62], [2, 0, 8]]);
  const b = costBreakdown(t, { ratios: { toolCharsPerToken: 100, contextCharsPerToken: 2 } });
  assert.equal(b.families.find((f) => f.family === 'context:attachment').directTokens, 31);
});

const cli = new URL('../analyze/session-cost.mjs', import.meta.url).pathname;
const fixture = new URL('./fixtures/session-small.jsonl', import.meta.url).pathname;
const run = (...args) => promisify(execFile)('node', [cli, ...args]);

test('CLI --fixed reproduces the fixed-ratio numbers on the fixture', async () => {
  const { stdout } = await run(fixture, '--fixed');
  assert.match(stdout, /\| claude-in-chrome \| 1 \| 1 \| 2,100 \| 2,100 \|/);
  assert.match(stdout, /\| Bash \| 1 \| 0 \| 200 \| 0 \|/);
  assert.match(stdout, /Fixed-ratio calibration: estimated 2,300 vs recorded 2,300 tokens of new context \(0\.0% off\)/);
  assert.match(stdout, /Ratios: fixed/);
  const { stdout: out } = await run(fixture, '--fixed', '--json');
  const data = JSON.parse(out);
  assert.equal(data.calibration.estimated, 2300);
  assert.equal(data.ratios.method, 'fixed');
});

test('CLI reports the ratio method and never prints tool-result text', async () => {
  const { stdout } = await run(fixture);
  assert.match(stdout, /Ratios: fixed \(.*20.*\)/);
  assert.match(stdout, /observations 2 · excluded: context drop 0, compact marker 0, after drop 0, growth ≤ 0: 0/);
  assert.match(stdout, /median per-turn holdout error n\/a \(criterion\)/);
  assert.doesNotMatch(stdout, /overhead/i);
  assert.doesNotMatch(stdout, /yyyy|xxxx|orphan/);
  const { stdout: out } = await run(fixture, '--json');
  assert.doesNotMatch(out, /yyyy|xxxx|orphan/);
  assert.equal(JSON.parse(out).ratios.observations, 2);
});
