// Tool inputs that mention benchmark internals: the answer key, the fixture
// source, the spec or the fixture tests. A run that touches these is suspect.
const LEAK_NEEDLES = ['variants.mjs', '/bench/', 'fixture-app', 'docs/superpowers', 'test/fixture-app'];

// Phrases `claude -p` uses when a run is blocked by the account's usage/rate
// limit rather than by anything the model did. These are infrastructure
// failures, not model failures, so they get their own subtype.
const RATE_LIMIT_PHRASES = ["hit your session limit", "you've hit your session limit", 'usage limit', 'rate limit', 'limit · resets'];

// A run is rate_limited when either:
//   1. the final text STARTS WITH one of the phrases AND the run shows some
//      sign of not having really completed (isError, or zero cost), or
//   2. the result is an error with zero cost and exactly one turn (the
//      signature of a run that never actually executed) AND a phrase appears
//      anywhere in the final text.
// Rule 1 alone (with no isError/cost check) would also match a genuine,
// successful answer that happens to start by discussing "rate limiting" in
// prose (e.g. "Rate limiting is a common technique..."), so it additionally
// requires isError or zero cost. A genuine answer that merely mentions a
// phrase mid-text, with real cost/turns and no error, matches neither rule.
export function isRateLimited(finalText, { isError, costUsd, turns }) {
  const t = (finalText || '').trim().toLowerCase();
  const startsWithPhrase = (isError || costUsd === 0) && RATE_LIMIT_PHRASES.some((p) => t.startsWith(p));
  const looksLikeBlockedRun = isError && costUsd === 0 && turns === 1 && RATE_LIMIT_PHRASES.some((p) => t.includes(p));
  return startsWithPhrase || looksLikeBlockedRun;
}

// Shared classification for a full run record (fresh from parseStream, or an
// older one loaded from a results file written before this fix, which never
// got tagged subtype: 'rate_limited'). Used by both summarize.mjs (to keep
// legacy results files out of the medians/accuracy) and resume.mjs (to decide
// which legacy records still need to be re-run).
export function wasRateLimited(record) {
  return record.subtype === 'rate_limited' || isRateLimited(record.finalText, { isError: record.isError, costUsd: record.costUsd, turns: record.turns });
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
