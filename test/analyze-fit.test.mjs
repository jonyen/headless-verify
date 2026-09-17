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

function synthetic({ n = 100, tool = 1.5, context = 3.5, overhead = 0, noise = 0.03, contextEvery = 2, seed = 7 } = {}) {
  const r = rng(seed);
  const obs = [];
  for (let turn = 1; turn <= n; turn++) {
    const toolChars = Math.round(200 + r() * 20000);
    const contextChars = turn % contextEvery === 0 ? Math.round(100 + r() * 8000) : 0;
    const imageTokens = turn % 7 === 0 ? 1600 : 0;
    const exact = overhead + toolChars / tool + contextChars / context + imageTokens;
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
  assert.ok(fit.holdoutErrorPct < 3, `holdout ${fit.holdoutErrorPct}`);
  assert.ok(fit.medianTurnErrorPct < 5, `median ${fit.medianTurnErrorPct}`);
});

test('fitRatios recovers a known per-turn overhead and both ratios within 5%', () => {
  const fit = fitRatios(synthetic({ overhead: 250, noise: 0.01 }));
  assert.equal(fit.method, 'fitted');
  assert.ok(within(fit.overheadTokensPerTurn, 250, 5), `overhead ${fit.overheadTokensPerTurn}`);
  assert.ok(within(fit.toolCharsPerToken, 1.5, 5), `tool ${fit.toolCharsPerToken}`);
  assert.ok(within(fit.contextCharsPerToken, 3.5, 5), `context ${fit.contextCharsPerToken}`);
  assert.ok(fit.holdoutErrorPct < 3, `holdout ${fit.holdoutErrorPct}`);
});

test('data with no overhead fits an overhead near zero, never negative', () => {
  for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
    const fit = fitRatios(synthetic({ seed }));
    assert.ok(fit.overheadTokensPerTurn >= 0, `seed ${seed}: ${fit.overheadTokensPerTurn}`);
    assert.ok(fit.overheadTokensPerTurn < 100, `seed ${seed}: ${fit.overheadTokensPerTurn}`);
    assert.ok(within(fit.toolCharsPerToken, 1.5, 5), `seed ${seed}: tool ${fit.toolCharsPerToken}`);
  }
});

test('overhead that would fit negative is clamped to zero and the ratios refit', () => {
  // Every turn is 300 tokens short of the char-based estimate: an unclamped intercept is -300.
  const obs = synthetic({ noise: 0 }).map((o) => ({ ...o, recorded: o.recorded - 300 }));
  const fit = fitRatios(obs);
  assert.equal(fit.method, 'fitted');
  assert.equal(fit.overheadTokensPerTurn, 0);
  assert.ok(fit.toolCharsPerToken > 0 && fit.contextCharsPerToken > 0);
});

test('fixed method reports zero overhead', () => {
  assert.equal(fitRatios(synthetic({ n: 10 })).overheadTokensPerTurn, 0);
});

test('costBreakdown reports per-turn overhead as its own row, not in any family', () => {
  const turns = [0, 1, 2, 3].map((index) => ({ index, usage: { input: 0, cacheCreation: 0, cacheRead: 0, output: 0 } }));
  const results = [
    { name: 'Bash', turn: 0, textChars: 300, images: [] },
    { name: 'Bash', turn: 1, textChars: 300, images: [] },
  ];
  const ratios = { toolCharsPerToken: 3, contextCharsPerToken: 4, overheadTokensPerTurn: 50 };
  const b = costBreakdown({ results, turns }, { ratios });
  const bash = b.families.find((f) => f.family === 'Bash');
  assert.equal(bash.directTokens, 200);
  assert.equal(b.families.length, 1);
  // Observation turns 1 and 2 each receive 50 overhead tokens; turn 1's is re-read by turns 2 and 3,
  // turn 2's by turn 3.
  assert.deepEqual(
    { turns: b.overhead.turns, directTokens: b.overhead.directTokens, carryTokens: b.overhead.carryTokens },
    { turns: 2, directTokens: 100, carryTokens: 150 },
  );
  assert.equal(costBreakdown({ results, turns }).overhead.directTokens, 0);
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
    { turn: 1, recorded: 2100, toolChars: 400, contextChars: 0, imageTokens: 2000 },
    { turn: 2, recorded: 200, toolChars: 800, contextChars: 0, imageTokens: 0 },
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
  assert.match(stdout, /observations 2, dropped 0/);
  assert.doesNotMatch(stdout, /yyyy|xxxx|orphan/);
  const { stdout: out } = await run(fixture, '--json');
  assert.doesNotMatch(out, /yyyy|xxxx|orphan/);
  assert.equal(JSON.parse(out).ratios.observations, 2);
});

test('CLI reports overhead per turn in the ratios and an overhead block in JSON', async () => {
  const { stdout } = await run(fixture, '--json');
  const data = JSON.parse(stdout);
  assert.equal(data.ratios.overheadTokensPerTurn, 0);
  assert.deepEqual(data.overhead, { turns: 2, directTokens: 0, carryTokens: 0 });
  const { stdout: md } = await run(fixture);
  assert.match(md, /overhead 0 tokens\/turn/);
});
