// Token cost model for tool results in a parsed transcript.

import { toolFamily } from './transcript.mjs';

const UNKNOWN_IMAGE_TOKENS = 1600;

export function resultTokens(result) {
  const text = Math.ceil(result.textChars / 4);
  const image = result.images.reduce(
    (sum, img) => sum + (img ? Math.round((img.width * img.height) / 750) : UNKNOWN_IMAGE_TOKENS),
    0,
  );
  return { text, image, total: text + image };
}

const context = (u) => u.input + u.cacheCreation + u.cacheRead;

export function costBreakdown({ results, turns }) {
  const byFamily = new Map();
  for (const result of results) {
    const family = toolFamily(result.name);
    const row = byFamily.get(family) ?? { family, calls: 0, images: 0, directTokens: 0, carryTokens: 0 };
    const { total } = resultTokens(result);
    const laterTurns = turns.filter((t) => t.index > result.turn + 1).length;
    row.calls += 1;
    row.images += result.images.length;
    row.directTokens += total;
    row.carryTokens += total * laterTurns;
    byFamily.set(family, row);
  }

  const billedInput = turns.reduce((sum, t) => sum + context(t.usage), 0);
  const families = [...byFamily.values()]
    .map((f) => ({ ...f, shareOfInput: billedInput ? (f.directTokens + f.carryTokens) / billedInput : 0 }))
    .sort((a, b) => b.directTokens + b.carryTokens - (a.directTokens + a.carryTokens));

  let estimated = 0;
  let recorded = 0;
  for (let k = 1; k < turns.length; k++) {
    const arriving = results.filter((r) => r.turn === k - 1);
    if (arriving.length === 0) continue;
    estimated += arriving.reduce((sum, r) => sum + resultTokens(r).total, 0);
    recorded += context(turns[k].usage) - context(turns[k - 1].usage) - turns[k - 1].usage.output;
  }

  return {
    families,
    totals: {
      billedInput,
      direct: families.reduce((s, f) => s + f.directTokens, 0),
      carry: families.reduce((s, f) => s + f.carryTokens, 0),
    },
    calibration: {
      estimated,
      recorded,
      errorPct: recorded ? (Math.abs(estimated - recorded) / recorded) * 100 : 0,
    },
  };
}
