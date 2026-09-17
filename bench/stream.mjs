// Tool inputs that mention benchmark internals: the answer key, the fixture
// source, the spec or the fixture tests. A run that touches these is suspect.
const LEAK_NEEDLES = ['variants.mjs', '/bench/', 'fixture-app', 'docs/superpowers', 'test/fixture-app'];

// Phrases `claude -p` uses when a run is blocked by the account's usage/rate
// limit rather than by anything the model did. These are infrastructure
// failures, not model failures, so they get their own subtype.
const RATE_LIMIT_PHRASES = ["hit your session limit", "you've hit your session limit", 'usage limit', 'rate limit', 'limit · resets'];

// A run is rate_limited when either:
//   1. the final text STARTS WITH one of the phrases (the normal shape of a
//      limit message, e.g. "You've hit your session limit · resets ..."), or
//   2. the result is an error with zero cost and exactly one turn (the
//      signature of a run that never actually executed) AND a phrase appears
//      anywhere in the final text.
// Rule 1 alone would also match a genuine answer that merely discusses
// "rate limit" in the middle of its prose, so that case only counts under
// rule 2, which requires the zero-cost/one-turn signature too.
export function isRateLimited(finalText, { isError, costUsd, turns }) {
  const t = (finalText || '').trim().toLowerCase();
  const startsWithPhrase = RATE_LIMIT_PHRASES.some((p) => t.startsWith(p));
  const looksLikeBlockedRun = isError && costUsd === 0 && turns === 1 && RATE_LIMIT_PHRASES.some((p) => t.includes(p));
  return startsWithPhrase || looksLikeBlockedRun;
}

export function parseStream(text) {
  const out = {
    finalText: '',
    usage: { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 },
    costUsd: 0,
    durationMs: 0,
    turns: 0,
    screenshots: 0,
    isError: true,
    subtype: 'no_result',
    leakSuspect: false,
  };
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event.type === 'assistant') {
      for (const block of event.message?.content ?? []) {
        if (block.type !== 'tool_use') continue;
        const input = JSON.stringify(block.input ?? {});
        if (LEAK_NEEDLES.some((needle) => input.includes(needle))) out.leakSuspect = true;
      }
    } else if (event.type === 'user') {
      for (const block of event.message?.content ?? []) {
        if (block.type !== 'tool_result' || !Array.isArray(block.content)) continue;
        out.screenshots += block.content.filter((c) => c.type === 'image').length;
      }
    } else if (event.type === 'result') {
      const u = event.usage ?? {};
      out.usage = {
        input: u.input_tokens ?? 0,
        output: u.output_tokens ?? 0,
        cacheCreation: u.cache_creation_input_tokens ?? 0,
        cacheRead: u.cache_read_input_tokens ?? 0,
      };
      out.costUsd = event.total_cost_usd ?? 0;
      out.durationMs = event.duration_ms ?? 0;
      out.turns = event.num_turns ?? 0;
      out.finalText = event.result ?? '';
      out.isError = Boolean(event.is_error);
      out.subtype = event.subtype ?? '';
    }
  }
  if (isRateLimited(out.finalText, { isError: out.isError, costUsd: out.costUsd, turns: out.turns })) {
    out.subtype = 'rate_limited';
    out.isError = true;
  }
  return out;
}
