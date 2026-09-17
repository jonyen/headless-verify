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
  };
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event.type === 'user') {
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
