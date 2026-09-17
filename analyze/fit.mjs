// Fit per-session characters-per-token ratios from the transcript's own recorded usage.
// Pure: observations in, ratios and held-out validation numbers out.
//
// Model: recorded ≈ toolChars·a + contextChars·b + imageTokens, where a and b are tokens per
// char for tool-result text and for context:user text. Least squares on the 2×2 normal
// equations; a class that has too little data, or fits to a non-positive coefficient, is held
// at the spec's fixed 4 chars/token and the other class is refit alone.
//
// Turns that break the model are excluded before fitting and before scoring: a context reset
// (recorded context below the previous turn's, or an explicit compact_boundary marker), the
// turn right after it (its growth is measured from a reset base), and turns with growth ≤ 0.
// The accuracy criterion is the median absolute per-turn error on held-out turns; the summed
// holdout error is secondary, because totals can match while individual turns are far off.

import { resultTokens } from './cost.mjs';

export const FIXED_CHARS_PER_TOKEN = 4;
export const MIN_OBSERVATIONS = 20;
export const MIN_CLASS_OBSERVATIONS = 5;
export const FOLDS = 5;

const FIXED = 1 / FIXED_CHARS_PER_TOKEN;
const context = (u) => u.input + u.cacheCreation + u.cacheRead;

export const CRITERION = 'medianTurnHoldoutErrorPct';

// One observation per turn k ≥ 1 that received content requested/arriving after turn k−1.
// `reset` is 'drop' for a context-reset turn, 'after' for the turn following one, else null.
export function buildObservations({ results, turns, compactBoundaries = [] }) {
  const markers = new Set(compactBoundaries);
  const isReset = (k) => k > 0 && k < turns.length && (context(turns[k].usage) < context(turns[k - 1].usage) || markers.has(k));
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
    const reset = isReset(k) ? 'drop' : isReset(k - 1) ? 'after' : null;
    const o = { turn: k, recorded, toolChars, contextChars, imageTokens, reset };
    if (markers.has(k)) Object.defineProperty(o, 'compactMarker', { value: true, enumerable: false });
    obs.push(o);
  }
  return obs;
}

// Returns { a, b, fitted: ['tool'|'context'...] } in tokens per char, or null if neither
// class can be fitted.
function solve(obs) {
  const toolN = obs.filter((o) => o.toolChars > 0).length;
  const ctxN = obs.filter((o) => o.contextChars > 0).length;
  let fitTool = toolN >= MIN_CLASS_OBSERVATIONS;
  let fitCtx = ctxN >= MIN_CLASS_OBSERVATIONS;

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
      if (a > 0 && b > 0) return { a, b, fitted: ['tool', 'context'] };
      // Hold a non-positive class at the fixed ratio (tool first if both) and refit the other.
      if (a <= 0) fitTool = false;
      else fitCtx = false;
    } else {
      // Collinear (e.g. context chars proportional to tool chars): fit tool text alone.
      fitCtx = false;
    }
  }
  if (fitTool) {
    // y − contextChars·FIXED = a·toolChars
    const a = (sty - FIXED * stc) / stt;
    if (a > 0) return { a, b: FIXED, fitted: ['tool'] };
    fitTool = false;
  }
  if (fitCtx) {
    const b = (scy - FIXED * stc) / scc;
    if (b > 0) return { a: FIXED, b, fitted: ['context'] };
  }
  return null;
}

const predict = (o, { a, b }) => o.toolChars * a + o.contextChars * b + o.imageTokens;

function median(values) {
  if (values.length === 0) return null;
  const s = [...values].sort((x, y) => x - y);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export function fitRatios(observations) {
  const excluded = { contextDrop: 0, afterDrop: 0, nonPositiveGrowth: 0 };
  const usable = [];
  for (const o of observations) {
    if (o.reset === 'drop') excluded.contextDrop += 1;
    else if (o.reset === 'after') excluded.afterDrop += 1;
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
  const fixed = (reason) => ({
    method: 'fixed',
    toolCharsPerToken: FIXED_CHARS_PER_TOKEN,
    contextCharsPerToken: FIXED_CHARS_PER_TOKEN,
    ...base,
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
    const coef = solve(train) ?? { a: FIXED, b: FIXED };
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
    ...base,
    medianTurnHoldoutErrorPct: median(turnErrors.map((t) => t.errorPct)),
    summedHoldoutErrorPct: (Math.abs(predicted - recorded) / recorded) * 100,
    holdoutTurns: turnErrors,
    holdoutPredicted: predicted,
    holdoutRecorded: recorded,
  };
}
