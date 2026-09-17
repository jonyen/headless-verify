import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fitRatios, buildObservations, summarizeFits } from '../analyze/fit.mjs';
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
  const obs2 = buildObservations(t2);
  const o2 = obs2.find((o) => o.turn === 41);
  assert.ok(o2.recorded < 0);
  assert.equal(o2.afterDrop, true);
  assert.deepEqual(fitRatios(obs2).excluded, { contextDrop: 1, compactMarker: 0, afterDrop: 1, nonPositiveGrowth: 0 });
  const mid = syntheticTranscript();
  const obs = buildObservations(mid);
  const growths = obs.filter((o) => !o.reset).map((o) => o.recorded).sort((x, y) => x - y);
  const median = growths[growths.length >> 1];
  const target = obs.find((o) => o.turn === 41).recorded;
  for (let k = 41; k < mid.turns.length; k++) mid.turns[k].usage.cacheRead += Math.max(0, 4 * median - target);
  const midObs = buildObservations(mid);
  assert.equal(midObs.find((o) => o.turn === 41).afterDrop, true);
  assert.equal(fitRatios(midObs).excluded.afterDrop, 0);
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
    { turn: 1, recorded: 2100, toolChars: 400, contextChars: 0, imageTokens: 2000, reset: null, afterDrop: false },
    { turn: 2, recorded: 200, toolChars: 800, contextChars: 0, imageTokens: 0, reset: null, afterDrop: false },
  ]);
});

test('attachment image blocks count as image tokens, never as text; source/data fields are skipped', () => {
  const png = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png, 0);
  png.writeUInt32BE(300, 16);
  png.writeUInt32BE(250, 20);
  const t = parseTranscript(jsonl([
    asst('a'),
    { type: 'attachment', attachment: { type: 'queued_command', prompt: [
      { type: 'text', text: 'q'.repeat(80) },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: png.toString('base64') + 'A'.repeat(250000) } },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'not-an-image' } },
      { type: 'document', source: { type: 'base64', data: 'D'.repeat(9000) } },
      { type: 'text', text: 'w'.repeat(5), data: 'x'.repeat(700) },
    ] } },
    asst('b'),
  ]));
  const r = t.results.filter((x) => x.name === 'context:attachment');
  assert.equal(r.length, 1);
  assert.equal(r[0].textChars, 85);
  assert.deepEqual(r[0].images, [{ width: 300, height: 250 }, null]);
  assert.equal(t.attachmentChars, 85);
  const obs = buildObservations(t);
  assert.equal(obs[0].contextChars, 85);
  assert.equal(obs[0].imageTokens, 100 + 1600);
});

test('a class fitted outside 1-8 chars/token is held at 4 and reported out of range', () => {
  const ctxLow = fitRatios(synthetic({ context: 0.8 }));
  assert.equal(ctxLow.method, 'fitted');
  assert.equal(ctxLow.contextCharsPerToken, 4);
  assert.deepEqual(ctxLow.fittedClasses, ['tool']);
  assert.deepEqual(ctxLow.outOfRange, ['context']);
  const toolHigh = fitRatios(synthetic({ tool: 12, context: 3 }));
  assert.equal(toolHigh.toolCharsPerToken, 4);
  assert.ok(toolHigh.outOfRange.includes('tool'), `outOfRange ${toolHigh.outOfRange}`);
  const both = fitRatios(synthetic({ tool: 20, context: 0.3 }));
  assert.equal(both.method, 'fixed');
  assert.deepEqual([...both.outOfRange].sort(), ['context', 'tool']);
  assert.match(both.reason, /range/);
  const ok = fitRatios(synthetic());
  assert.deepEqual(ok.outOfRange, []);
});

test('summarizeFits reports headline figures with and without out-of-range sessions', () => {
  const fit = (median, extra = {}) => ({ method: 'fitted', toolCharsPerToken: 2, contextCharsPerToken: 3, fittedClasses: ['tool', 'context'], outOfRange: [], medianTurnHoldoutErrorPct: median, summedHoldoutErrorPct: 1, holdoutPredicted: 10, holdoutRecorded: 10, ...extra });
  const fits = [
    fit(10),
    fit(12, { contextCharsPerToken: 4, fittedClasses: ['tool'], outOfRange: ['context'] }),
    fit(40),
    { method: 'fixed', toolCharsPerToken: 4, contextCharsPerToken: 4, outOfRange: ['tool', 'context'], medianTurnHoldoutErrorPct: null },
    { method: 'fixed', toolCharsPerToken: 4, contextCharsPerToken: 4, outOfRange: [], medianTurnHoldoutErrorPct: null },
  ];
  const s = summarizeFits(fits);
  assert.equal(s.all.fittedSessions, 3);
  assert.equal(s.all.medianSessionMedianTurnHoldoutErrorPct, 12);
  assert.equal(s.all.sessionsMeeting15Pct, 2);
  assert.equal(s.outOfRangeSessions, 2);
  assert.equal(s.inRangeOnly.fittedSessions, 2);
  assert.equal(s.inRangeOnly.medianSessionMedianTurnHoldoutErrorPct, 25);
  assert.equal(s.inRangeOnly.sessionsMeeting15Pct, 1);
  // Context median only over sessions where context was actually fitted in range.
  assert.equal(s.all.medianContextCharsPerToken, 3);
});

test('the after-drop threshold for held-out turns comes from training turns only', () => {
  const obs = [];
  const at100 = new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 15, 20, 25]);
  for (let turn = 1; turn <= 26; turn++) {
    const recorded = at100.has(turn) ? 100 : 1000;
    obs.push({ turn, recorded, toolChars: recorded * 1.5, contextChars: 0, imageTokens: 0, reset: null, afterDrop: false });
  }
  obs.push({ turn: 30, recorded: 3000, toolChars: 4500, contextChars: 0, imageTokens: 0, reset: null, afterDrop: true });
  const fit = fitRatios(obs);
  // All turns: median 100, so 3000 > 5x100 and the final fit excludes the candidate.
  assert.equal(fit.excluded.afterDrop, 1);
  assert.equal(fit.observations, 26);
  // Fold 0 training turns: median 1000, so the held-out candidate (3000 < 5000) is scored.
  assert.equal(fit.holdoutTurns.length, 27);
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

const attachFixture = new URL('./fixtures/session-attachments.jsonl', import.meta.url).pathname;

test('CLI --fixed reproduces main exactly on a fixture with attachments and a compaction marker', async () => {
  // Expected values are main's analyzer output (commit 7f62565) on this fixture.
  const { stdout } = await run(attachFixture, '--fixed');
  assert.match(stdout, /Sessions: 1 · billed input tokens: 7,570 · skipped 1 malformed lines/);
  const rows = stdout.split('\n').filter((l) => /^\| (?!tool family|---)/.test(l));
  assert.deepEqual(rows, [
    '| claude-in-chrome | 1 | 1 | 2,100 | 2,100 | 55.5% |',
    '| Bash | 1 | 0 | 200 | 0 | 2.6% |',
    '| unknown | 1 | 0 | 2 | 0 | 0.0% |',
  ]);
  assert.match(stdout, /calibration: estimated 2,300 vs recorded 2,300 tokens of new context \(0\.0% off\) · implied chars\/token \(tool-result-only turns\): 4\.00/);
  assert.match(stdout, /Ratios: fixed \(--fixed\)/);
  assert.doesNotMatch(stdout, /attachment|excluded|holdout/);
  const data = JSON.parse((await run(attachFixture, '--fixed', '--json')).stdout);
  assert.deepEqual(data.families.map((f) => [f.family, f.directTokens, f.carryTokens]), [['claude-in-chrome', 2100, 2100], ['Bash', 200, 0], ['unknown', 2, 0]]);
  assert.deepEqual(data.calibration, { estimated: 2300, recorded: 2300, errorPct: 0, impliedCharsPerToken: 4 });
  assert.deepEqual(data.ratios, { method: 'fixed', toolCharsPerToken: 4, contextCharsPerToken: 4, reason: '--fixed' });
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
