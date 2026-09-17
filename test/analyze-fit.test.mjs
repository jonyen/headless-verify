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

test('a context drop excludes the drop turn and the next turn, counted separately', () => {
  const obs = buildObservations(syntheticTranscript());
  const fit = fitRatios(obs);
  assert.equal(fit.method, 'fitted');
  assert.deepEqual(fit.excluded, { contextDrop: 1, afterDrop: 1, nonPositiveGrowth: 0 });
  assert.equal(fit.observations, obs.length - 2);
  assert.ok(within(fit.toolCharsPerToken, 1.5, 5), `tool ${fit.toolCharsPerToken}`);
  assert.ok(fit.medianTurnHoldoutErrorPct < 2, `median ${fit.medianTurnHoldoutErrorPct}`);
});

test('an explicit compact marker flags a reset even when usage does not drop', () => {
  const t = syntheticTranscript({ dropAt: 1000, marker: true });
  t.compactBoundaries = [30];
  const fit = fitRatios(buildObservations(t));
  assert.equal(fit.excluded.contextDrop, 1);
  assert.equal(fit.excluded.afterDrop, 1);
  assert.equal(fit.compactMarkers, 1);
});

test('parseTranscript records compact_boundary positions without content', () => {
  const lines = [
    { type: 'assistant', message: { id: 'a', usage: { input_tokens: 1, output_tokens: 1 }, content: [] } },
    { type: 'system', subtype: 'compact_boundary' },
    { type: 'user', isCompactSummary: true, message: { content: 'summary' } },
    { type: 'assistant', message: { id: 'b', usage: { input_tokens: 1, output_tokens: 1 }, content: [] } },
  ];
  const t = parseTranscript(lines.map((l) => JSON.stringify(l)).join('\n'));
  assert.deepEqual(t.compactBoundaries, [1]);
});

test('a class with too little data stays fixed at 4 chars/token', () => {
  // Only 3 observations carry context chars: too few to fit that class.
  const obs = synthetic({ contextEvery: 1000 }).map((o, i) =>
    i < 3 ? { ...o, contextChars: 400, recorded: o.recorded + 100 } : o,
  );
  const fit = fitRatios(obs);
  assert.equal(fit.method, 'fitted');
  assert.equal(fit.contextCharsPerToken, 4);
  assert.ok(within(fit.toolCharsPerToken, 1.5, 5), `tool ${fit.toolCharsPerToken}`);
});

test('observations with zero or negative recorded growth are dropped and counted', () => {
  const obs = synthetic();
  obs[3] = { ...obs[3], recorded: 0 };
  obs[10] = { ...obs[10], recorded: -50000 };
  obs[20] = { ...obs[20], recorded: -1 };
  const fit = fitRatios(obs);
  assert.equal(fit.dropped, 3);
  assert.equal(fit.excluded.nonPositiveGrowth, 3);
  assert.equal(fit.observations, 97);
  assert.ok(within(fit.toolCharsPerToken, 1.5, 5));
});

test('fewer than 20 usable observations gives method fixed', () => {
  const fit = fitRatios(synthetic({ n: 19 }));
  assert.equal(fit.method, 'fixed');
  assert.equal(fit.toolCharsPerToken, 4);
  assert.equal(fit.contextCharsPerToken, 4);
  assert.match(fit.reason, /20/);
});

test('dropped rows do not count toward the 20-observation minimum', () => {
  const obs = synthetic({ n: 21 });
  obs[0] = { ...obs[0], recorded: 0 };
  obs[1] = { ...obs[1], recorded: -3 };
  const fit = fitRatios(obs);
  assert.equal(fit.method, 'fixed');
  assert.equal(fit.dropped, 2);
});

test('costBreakdown with explicit ratios scales tool and context tokens independently', () => {
  const turns = [0, 1, 2].map((index) => ({ index, usage: { input: 0, cacheCreation: 0, cacheRead: 0, output: 0 } }));
  const results = [
    { name: 'Bash', turn: 0, textChars: 300, images: [] },
    { name: 'context:user', turn: 0, textChars: 700, images: [] },
  ];
  const fam = (b, name) => b.families.find((f) => f.family === name).directTokens;
  const fixed = costBreakdown({ results, turns });
  assert.equal(fam(fixed, 'Bash'), 75);
  assert.equal(fam(fixed, 'context:user'), 175);
  const scaled = costBreakdown({ results, turns }, { ratios: { toolCharsPerToken: 1.5, contextCharsPerToken: 3.5 } });
  assert.equal(fam(scaled, 'Bash'), 200);
  assert.equal(fam(scaled, 'context:user'), 200);
  const toolOnly = costBreakdown({ results, turns }, { ratios: { toolCharsPerToken: 3, contextCharsPerToken: 4 } });
  assert.equal(fam(toolOnly, 'Bash'), 100);
  assert.equal(fam(toolOnly, 'context:user'), 175);
});

test('buildObservations splits arriving chars into tool, context and image tokens', async () => {
  const transcript = parseTranscript(await readFile(new URL('./fixtures/session-small.jsonl', import.meta.url), 'utf8'));
  const obs = buildObservations(transcript);
  // Fixture: turn1 growth 2100 = 400 chars + 2000 image tokens; turn2 growth 200 = 800 chars.
  assert.deepEqual(obs, [
    { turn: 1, recorded: 2100, toolChars: 400, contextChars: 0, imageTokens: 2000, reset: null },
    { turn: 2, recorded: 200, toolChars: 800, contextChars: 0, imageTokens: 0, reset: null },
  ]);
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
  assert.match(stdout, /observations 2 · excluded: context drop 0, after drop 0, growth ≤ 0: 0/);
  assert.match(stdout, /median per-turn holdout error n\/a \(criterion\)/);
  assert.doesNotMatch(stdout, /overhead/i);
  assert.doesNotMatch(stdout, /yyyy|xxxx|orphan/);
  const { stdout: out } = await run(fixture, '--json');
  assert.doesNotMatch(out, /yyyy|xxxx|orphan/);
  assert.equal(JSON.parse(out).ratios.observations, 2);
});
