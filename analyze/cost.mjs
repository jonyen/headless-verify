// Token cost model for tool results in a parsed transcript.

import { toolFamily } from './transcript.mjs';

const UNKNOWN_IMAGE_TOKENS = 1600;

// The spec fixes this approximation at ~4 chars/token for plain text. See docs/validation.md
// for the calibration's `impliedCharsPerToken` figure, which measures the actual ratio for
// tool-result-only turns without feeding back into this estimate.
export const CHARS_PER_TOKEN = 4;

export const FIXED_RATIOS = Object.freeze({ toolCharsPerToken: CHARS_PER_TOKEN, contextCharsPerToken: CHARS_PER_TOKEN });

// `ratios` (see analyze/fit.mjs) sets chars per token separately for tool-result text and for
// context:user text; the default is the spec's fixed 4/4.
export function resultTokens(result, ratios = FIXED_RATIOS) {
  const divisor = result.name === 'context:user' ? ratios.contextCharsPerToken : ratios.toolCharsPerToken;
  const text = Math.ceil(result.textChars / divisor);
  const image = result.images.reduce(
    (sum, img) => sum + (img ? Math.round((img.width * img.height) / 750) : UNKNOWN_IMAGE_TOKENS),
    0,
  );
  return { text, image, total: text + image };
}

const context = (u) => u.input + u.cacheCreation + u.cacheRead;

export function costBreakdown({ results, turns }, { ratios = FIXED_RATIOS } = {}) {
  const byFamily = new Map();
  for (const result of results) {
    const family = toolFamily(result.name);
    const row = byFamily.get(family) ?? { family, calls: 0, images: 0, directTokens: 0, carryTokens: 0 };
    const { total } = resultTokens(result, ratios);
    const laterTurns = turns.filter((t) => t.index > result.turn + 1).length;
    row.calls += 1;
    row.images += result.images.length;
    row.directTokens += total;
    row.carryTokens += total * laterTurns;
    byFamily.set(family, row);
  }

  // Per-turn overhead (analyze/fit.mjs): an estimate of harness tokens with no characters in the
  // transcript. Never attributed to a tool family. Applies to each turn that received content,
  // and is re-read by every later turn like any other result.
  const overheadPerTurn = ratios.overheadTokensPerTurn ?? 0;
  const overhead = { tokensPerTurn: overheadPerTurn, turns: 0, directTokens: 0, carryTokens: 0 };
  const arrivingTurns = new Set(results.map((r) => r.turn + 1));
  for (const t of turns) {
    if (t.index < 1 || !arrivingTurns.has(t.index)) continue;
    overhead.turns += 1;
    overhead.directTokens += overheadPerTurn;
    overhead.carryTokens += overheadPerTurn * turns.filter((later) => later.index > t.index).length;
  }

  const billedInput = turns.reduce((sum, t) => sum + context(t.usage), 0);
  const families = [...byFamily.values()]
    .map((f) => ({ ...f, shareOfInput: billedInput ? (f.directTokens + f.carryTokens) / billedInput : 0 }))
    .sort((a, b) => b.directTokens + b.carryTokens - (a.directTokens + a.carryTokens));

  // Fixed-ratio calibration: always at the spec's 4 chars/token, whatever `ratios` is, so it
  // stays comparable across runs. The fitted method's own validation is its k-fold holdout
  // error (analyze/fit.mjs).
  let estimated = 0;
  let recorded = 0;
  // Empirical ratio, kept separate from `estimated`/`recorded`: it never feeds back into the
  // estimate above, it only reports what the recorded data implies. Restricted to turns whose
  // arriving content is solely tool results (no context:user content mixed in), so that
  // non-tool-result text (already a separate, unrelated char count) can't distort it.
  let impliedTextChars = 0;
  let impliedDenominator = 0;
  for (let k = 1; k < turns.length; k++) {
    const arriving = results.filter((r) => r.turn === k - 1);
    if (arriving.length === 0) continue;
    estimated += arriving.reduce((sum, r) => sum + resultTokens(r).total, 0);
    const turnRecorded = context(turns[k].usage) - context(turns[k - 1].usage) - turns[k - 1].usage.output;
    recorded += turnRecorded;

    const onlyToolResults = arriving.every((r) => r.name !== 'context:user');
    if (onlyToolResults) {
      const textChars = arriving.reduce((sum, r) => sum + r.textChars, 0);
      const imageTokens = arriving.reduce((sum, r) => sum + resultTokens(r).image, 0);
      const denom = turnRecorded - imageTokens;
      if (denom > 0) {
        impliedTextChars += textChars;
        impliedDenominator += denom;
      }
    }
  }

  return {
    families,
    overhead,
    totals: {
      billedInput,
      direct: families.reduce((s, f) => s + f.directTokens, 0),
      carry: families.reduce((s, f) => s + f.carryTokens, 0),
    },
    calibration: {
      estimated,
      recorded,
      errorPct: recorded ? (Math.abs(estimated - recorded) / recorded) * 100 : 0,
      impliedCharsPerToken: impliedDenominator > 0 ? impliedTextChars / impliedDenominator : null,
      impliedTextChars,
      impliedDenominator,
    },
  };
}
