// Fit per-session characters-per-token ratios from the transcript's own recorded usage.
// Pure: observations in, ratios and held-out validation numbers out.
//
// Model: recorded ≈ toolChars·a + contextChars·b + imageTokens, where a and b are tokens per
// char for tool-result text and for context:user text. Least squares on the 2×2 normal
// equations; a class that has too little data, or fits to a non-positive coefficient, is held
// at the spec's fixed 4 chars/token and the other class is refit alone.
//
// Turns that break the model are excluded before fitting and before scoring: a context drop
// (recorded context below the previous turn's); the turn a compaction marker lands on; the turn
// right after a context drop, only if its growth is negative or above 5× the median growth of the
// reference turns (all turns for the final fit, training turns within each fold); and turns with
// growth ≤ 0 (unavoidable: a percentage error needs a positive denominator).
// The accuracy criterion is the median absolute per-turn error on held-out turns; the summed
// holdout error is secondary, because totals can match while individual turns are far off.

import { resultTokens, isContext } from './cost.mjs';

export const FIXED_CHARS_PER_TOKEN = 4;
export const MIN_OBSERVATIONS = 20;
export const MIN_CLASS_OBSERVATIONS = 5;
export const FOLDS = 5;

const FIXED = 1 / FIXED_CHARS_PER_TOKEN;
const context = (u) => u.input + u.cacheCreation + u.cacheRead;

export const CRITERION = 'medianTurnHoldoutErrorPct';

// One observation per turn k ≥ 1 that received content requested/arriving after turn k−1.
// `reset` is 'drop' for a context-drop turn, 'marker' for the turn a compaction marker lands on
// (without a usage drop), else null. `afterDrop` marks the turn right after a context drop; whether
// it is excluded depends on the median growth of the turns it is judged against (fitRatios).
export const AFTER_DROP_MEDIAN_MULTIPLE = 5;
export function buildObservations({ results, turns, compactBoundaries = [] }) {
  const markers = new Set(compactBoundaries);
  const isDrop = (k) => k > 0 && k < turns.length && context(turns[k].usage) < context(turns[k - 1].usage);
  const obs = [];
  for (let k = 1; k < turns.length; k++) {
    const arriving = results.filter((r) => r.turn === k - 1);
    if (arriving.length === 0) continue;
    let toolChars = 0;
    let contextChars = 0;
    let imageTokens = 0;
    for (const r of arriving) {
      if (isContext(r)) contextChars += r.textChars;
      else toolChars += r.textChars;
      imageTokens += resultTokens(r).image;
    }
    const recorded = context(turns[k].usage) - context(turns[k - 1].usage) - turns[k - 1].usage.output;
    const reset = isDrop(k) ? 'drop' : markers.has(k) ? 'marker' : null;
    const o = { turn: k, recorded, toolChars, contextChars, imageTokens, reset, afterDrop: reset === null && isDrop(k - 1) };
    if (markers.has(k)) Object.defineProperty(o, 'compactMarker', { value: true, enumerable: false });
    obs.push(o);
  }
  return obs;
}

// Plausible fitted ratios, in chars per token. A class fitted outside this range is treated as a
// failed fit, like a non-positive coefficient: held at the fixed ratio, the other class refit.
export const MIN_CHARS_PER_TOKEN = 1;
export const MAX_CHARS_PER_TOKEN = 8;

// Returns { a, b, fitted: ['tool'|'context'...], outOfRange } in tokens per char, or
// { failed: true, outOfRange } if neither class can be fitted.
function solve(obs) {
  const toolN = obs.filter((o) => o.toolChars > 0).length;
  const ctxN = obs.filter((o) => o.contextChars > 0).length;
  let fitTool = toolN >= MIN_CLASS_OBSERVATIONS;
  let fitCtx = ctxN >= MIN_CLASS_OBSERVATIONS;
  const outOfRange = [];
  // Positive but implausible coefficients are recorded; non-positive ones are not.
  const ok = (c, cls, mark) => {
    if (!(c > 0)) return false;
    if (1 / c < MIN_CHARS_PER_TOKEN || 1 / c > MAX_CHARS_PER_TOKEN) {
      if (mark) outOfRange.push(cls);
      return false;
    }
    return true;
  };

  let stt = 0, scc = 0, stc = 0, sty = 0, scy = 0;
  for (const o of obs) {
    const y = o.recorded - o.imageTokens;
    stt += o.toolChars * o.toolChars;
    scc += o.contextChars * o.contextChars;
    stc += o.toolChars * o.contextChars;
    sty += o.toolChars * y;
    scy += o.contextChars * y;
  }

  if (fitTool && fitCtx) {
    const det = stt * scc - stc * stc;
    if (det > 0) {
      const a = (sty * scc - scy * stc) / det;
      const b = (scy * stt - sty * stc) / det;
      if (ok(a, 'tool', false) && ok(b, 'context', false)) return { a, b, fitted: ['tool', 'context'], outOfRange };
      // Hold a failed class at the fixed ratio (tool first if both) and refit the other.
      if (!ok(a, 'tool', true)) fitTool = false;
      else {
        ok(b, 'context', true);
        fitCtx = false;
      }
    } else {
      // Collinear (e.g. context chars proportional to tool chars): fit tool text alone.
      fitCtx = false;
    }
  }
  if (fitTool) {
    // y − contextChars·FIXED = a·toolChars
    const a = (sty - FIXED * stc) / stt;
    if (ok(a, 'tool', true)) return { a, b: FIXED, fitted: ['tool'], outOfRange };
    fitTool = false;
  }
  if (fitCtx) {
    const b = (scy - FIXED * stc) / scc;
    if (ok(b, 'context', !outOfRange.includes('context'))) return { a: FIXED, b, fitted: ['context'], outOfRange };
  }
  return { failed: true, outOfRange };
}

const predict = (o, { a, b }) => o.toolChars * a + o.contextChars * b + o.imageTokens;

function median(values) {
  if (values.length === 0) return null;
  const s = [...values].sort((x, y) => x - y);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// The after-drop rule: a turn right after a context drop is excluded if its growth is negative or
// above AFTER_DROP_MEDIAN_MULTIPLE × the median growth of `reference` (turns not reset, growth > 0).
function afterDropLimit(reference) {
  const m = median(reference.filter((o) => o.reset == null && o.recorded > 0).map((o) => o.recorded));
  return m === null ? Infinity : AFTER_DROP_MEDIAN_MULTIPLE * m;
}
const failsAfterDrop = (o, limit) => o.afterDrop === true && (o.recorded < 0 || o.recorded > limit);

export function fitRatios(observations) {
  const excluded = { contextDrop: 0, compactMarker: 0, afterDrop: 0, nonPositiveGrowth: 0 };
  // Resets never depend on growth; the after-drop and growth rules are applied per reference set.
  const candidates = observations.filter((o) => o.reset !== 'drop' && o.reset !== 'marker');
  const limit = afterDropLimit(candidates);
  const usable = [];
  for (const o of observations) {
    if (o.reset === 'drop') excluded.contextDrop += 1;
    else if (o.reset === 'marker') excluded.compactMarker += 1;
    else if (failsAfterDrop(o, limit)) excluded.afterDrop += 1;
    else if (!(o.recorded > 0)) excluded.nonPositiveGrowth += 1;
    else usable.push(o);
  }
  const base = {
    criterion: CRITERION,
    observations: usable.length,
    dropped: excluded.nonPositiveGrowth,
    excluded,
    compactMarkers: observations.filter((o) => o.compactMarker).length,
  };
  const fixed = (reason, outOfRange = []) => ({
    method: 'fixed',
    toolCharsPerToken: FIXED_CHARS_PER_TOKEN,
    contextCharsPerToken: FIXED_CHARS_PER_TOKEN,
    ...base,
    outOfRange,
    medianTurnHoldoutErrorPct: null,
    summedHoldoutErrorPct: null,
    holdoutPredicted: null,
    holdoutRecorded: null,
    reason,
  });

  if (usable.length < MIN_OBSERVATIONS) {
    return fixed(`${usable.length} usable observations, need at least ${MIN_OBSERVATIONS}`);
  }
  const all = solve(usable);
  if (all.failed) {
    const range = all.outOfRange.length ? `; out of range (${MIN_CHARS_PER_TOKEN}-${MAX_CHARS_PER_TOKEN} chars/token): ${all.outOfRange.join(', ')}` : '';
    return fixed(`no class has at least ${MIN_CLASS_OBSERVATIONS} observations with a positive, in-range fit${range}`, all.outOfRange);
  }

  let predicted = 0;
  let recorded = 0;
  const turnErrors = [];
  for (let fold = 0; fold < FOLDS; fold++) {
    const heldPool = candidates.filter((o) => o.turn % FOLDS === fold);
    const trainPool = candidates.filter((o) => o.turn % FOLDS !== fold);
    // The after-drop threshold comes from training turns only, never from the turns being scored.
    const foldLimit = afterDropLimit(trainPool);
    const keep = (o) => !failsAfterDrop(o, foldLimit) && o.recorded > 0;
    const held = heldPool.filter(keep);
    if (held.length === 0) continue;
    const train = trainPool.filter(keep);
    const solved = solve(train);
    const coef = solved.failed ? { a: FIXED, b: FIXED } : solved;
    for (const o of held) {
      const p = predict(o, coef);
      predicted += p;
      recorded += o.recorded;
      turnErrors.push({ recorded: o.recorded, errorPct: (Math.abs(p - o.recorded) / o.recorded) * 100 });
    }
  }

  return {
    method: 'fitted',
    toolCharsPerToken: 1 / all.a,
    contextCharsPerToken: 1 / all.b,
    fittedClasses: all.fitted,
    outOfRange: all.outOfRange,
    ...base,
    medianTurnHoldoutErrorPct: median(turnErrors.map((t) => t.errorPct)),
    summedHoldoutErrorPct: (Math.abs(predicted - recorded) / recorded) * 100,
    holdoutTurns: turnErrors,
    holdoutPredicted: predicted,
    holdoutRecorded: recorded,
  };
}

// Cross-session headline figures, for all sessions and for sessions where no class hit the
// plausible-range rule. Ratio medians use only classes actually fitted (in range).
export function summarizeFits(fits) {
  const headline = (set) => {
    const fitted = set.filter((f) => f.method === 'fitted');
    const pooledPredicted = fitted.reduce((s, f) => s + f.holdoutPredicted, 0);
    const pooledRecorded = fitted.reduce((s, f) => s + f.holdoutRecorded, 0);
    return {
      sessions: set.length,
      fittedSessions: fitted.length,
      fixedSessions: set.length - fitted.length,
      medianSessionMedianTurnHoldoutErrorPct: median(fitted.map((f) => f.medianTurnHoldoutErrorPct)),
      sessionsMeeting15Pct: fitted.filter((f) => f.medianTurnHoldoutErrorPct <= 15).length,
      pooledSummedHoldoutErrorPct: pooledRecorded ? (Math.abs(pooledPredicted - pooledRecorded) / pooledRecorded) * 100 : null,
      medianToolCharsPerToken: median(fitted.filter((f) => f.fittedClasses?.includes('tool')).map((f) => f.toolCharsPerToken)),
      medianContextCharsPerToken: median(fitted.filter((f) => f.fittedClasses?.includes('context')).map((f) => f.contextCharsPerToken)),
      medianTurnHoldoutErrorRangePct: fitted.length
        ? [Math.min(...fitted.map((f) => f.medianTurnHoldoutErrorPct)), Math.max(...fitted.map((f) => f.medianTurnHoldoutErrorPct))]
        : null,
    };
  };
  const hit = (f) => (f.outOfRange ?? []).length > 0;
  return {
    criterion: 'medianSessionMedianTurnHoldoutErrorPct',
    outOfRangeSessions: fits.filter(hit).length,
    all: headline(fits),
    inRangeOnly: headline(fits.filter((f) => !hit(f))),
  };
}
