// Tool inputs that mention benchmark internals: the answer key, the fixture
// source, the spec or the fixture tests. A run that touches these is suspect.
const LEAK_NEEDLES = ['variants.mjs', '/bench/', 'fixture-app', 'docs/superpowers', 'test/fixture-app'];

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
  return out;
}
