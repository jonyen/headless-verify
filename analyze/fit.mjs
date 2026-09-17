// Fit per-session characters-per-token ratios from the transcript's own recorded usage.
// Pure: observations in, ratios and held-out validation numbers out.
//
// Model: recorded ≈ o + toolChars·a + contextChars·b + imageTokens, where o is a fixed per-turn
// overhead (tokens with no characters in the transcript: framing, unlogged harness content) and
// a, b are tokens per char for tool-result text and context:user text. Least squares on the
// normal equations; a negative overhead is clamped to 0, and a class that has too little data or
// fits non-positive is held at the spec's fixed 4 chars/token, with the remaining terms refit.

import { resultTokens } from './cost.mjs';

export const FIXED_CHARS_PER_TOKEN = 4;
export const MIN_OBSERVATIONS = 20;
export const MIN_CLASS_OBSERVATIONS = 5;
export const FOLDS = 5;

const FIXED = 1 / FIXED_CHARS_PER_TOKEN;
const context = (u) => u.input + u.cacheCreation + u.cacheRead;

// One observation per turn k ≥ 1 that received content requested/arriving after turn k−1.
export function buildObservations({ results, turns }) {
  const obs = [];
  for (let k = 1; k < turns.length; k++) {
    const arriving = results.filter((r) => r.turn === k - 1);
    if (arriving.length === 0) continue;
    let toolChars = 0;
    let contextChars = 0;
    let imageTokens = 0;
    for (const r of arriving) {
      if (r.name === 'context:user') contextChars += r.textChars;
      else toolChars += r.textChars;
      imageTokens += resultTokens(r).image;
    }
    const recorded = context(turns[k].usage) - context(turns[k - 1].usage) - turns[k - 1].usage.output;
    obs.push({ turn: k, recorded, toolChars, contextChars, imageTokens });
  }
  return obs;
}

// Least squares on the free terms (overhead o, tool a, context b), with fixed terms moved to the
// response. Gaussian elimination on the ≤3×3 normal equations; null if singular.
function leastSquares(obs, free, fixedValues) {
  const col = { o: () => 1, a: (x) => x.toolChars, b: (x) => x.contextChars };
  const n = free.length;
  const M = Array.from({ length: n }, () => new Array(n + 1).fill(0));
  for (const x of obs) {
    const y = x.recorded - x.imageTokens - fixedValues.o - fixedValues.a * x.toolChars - fixedValues.b * x.contextChars;
    const row = free.map((t) => col[t](x));
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) M[i][j] += row[i] * row[j];
      M[i][n] += row[i] * y;
    }
  }
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < 1e-9 * Math.max(1, Math.abs(M[c][c]))) return null;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c] / M[c][c];
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return Object.fromEntries(free.map((t, i) => [t, M[i][n] / M[i][i]]));
}

// Returns { o, a, b, fitted } with a, b in tokens per char and o in tokens per turn, or null if
// neither char class can be fitted. Terms that fit out of bounds (overhead < 0, ratio
// coefficient ≤ 0) are removed one at a time, worst first — overhead goes to 0, a ratio to the
// fixed 4 chars/token — and the rest refit. A singular system drops overhead, then context.
function solve(obs) {
  const DEFAULT = { o: 0, a: FIXED, b: FIXED };
  const free = ['o'];
  if (obs.filter((x) => x.toolChars > 0).length >= MIN_CLASS_OBSERVATIONS) free.push('a');
  if (obs.filter((x) => x.contextChars > 0).length >= MIN_CLASS_OBSERVATIONS) free.push('b');
  while (free.some((t) => t !== 'o')) {
    // Free terms contribute nothing to the response adjustment; fixed ones take their default.
    const fixedValues = Object.fromEntries(Object.entries(DEFAULT).map(([t, v]) => [t, free.includes(t) ? 0 : v]));
    const coef = leastSquares(obs, free, fixedValues);
    if (!coef) {
      free.splice(free.indexOf(free.includes('o') ? 'o' : free.includes('b') ? 'b' : 'a'), 1);
      continue;
    }
    const bad = free.filter((t) => (t === 'o' ? coef[t] < 0 : coef[t] <= 0));
    if (bad.length === 0) {
      const out = { ...DEFAULT, ...coef };
      return { ...out, fitted: free.map((t) => ({ o: 'overhead', a: 'tool', b: 'context' })[t]) };
    }
    // Overhead first, then tool (as before the overhead term existed), then context.
    const worst = bad.includes('o') ? 'o' : bad[0];
    free.splice(free.indexOf(worst), 1);
  }
  return null;
}

const predict = (x, { o, a, b }) => o + x.toolChars * a + x.contextChars * b + x.imageTokens;

function median(values) {
  if (values.length === 0) return null;
  const s = [...values].sort((x, y) => x - y);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export function fitRatios(observations) {
  const usable = observations.filter((o) => o.recorded > 0);
  const base = { observations: usable.length, dropped: observations.length - usable.length };
  const fixed = (reason) => ({
    method: 'fixed',
    toolCharsPerToken: FIXED_CHARS_PER_TOKEN,
    contextCharsPerToken: FIXED_CHARS_PER_TOKEN,
    overheadTokensPerTurn: 0,
    ...base,
    holdoutErrorPct: null,
    medianTurnErrorPct: null,
    holdoutPredicted: null,
    holdoutRecorded: null,
    reason,
  });

  if (usable.length < MIN_OBSERVATIONS) {
    return fixed(`${usable.length} usable observations, need at least ${MIN_OBSERVATIONS}`);
  }
  const all = solve(usable);
  if (!all) {
    return fixed(`no class has at least ${MIN_CLASS_OBSERVATIONS} observations with a positive fit`);
  }

  let predicted = 0;
  let recorded = 0;
  const turnErrors = [];
  for (let fold = 0; fold < FOLDS; fold++) {
    const held = usable.filter((o) => o.turn % FOLDS === fold);
    if (held.length === 0) continue;
    const train = usable.filter((o) => o.turn % FOLDS !== fold);
    const coef = solve(train) ?? { o: 0, a: FIXED, b: FIXED };
    for (const o of held) {
      const p = predict(o, coef);
      predicted += p;
      recorded += o.recorded;
      turnErrors.push((Math.abs(p - o.recorded) / o.recorded) * 100);
    }
  }

  return {
    method: 'fitted',
    toolCharsPerToken: 1 / all.a,
    contextCharsPerToken: 1 / all.b,
    overheadTokensPerTurn: all.o,
    fittedClasses: all.fitted,
    ...base,
    holdoutErrorPct: (Math.abs(predicted - recorded) / recorded) * 100,
    medianTurnErrorPct: median(turnErrors),
    holdoutPredicted: predicted,
    holdoutRecorded: recorded,
  };
}
