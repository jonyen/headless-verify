// Parse a Claude Code session transcript (JSONL) into tool calls, tool
// results and per-API-call usage. Pure: takes the file text, returns data.

import { imageSize } from './image-size.mjs';

export function toolFamily(name) {
  const mcp = /^mcp__(.+?)__/.exec(name);
  if (!mcp) return name;
  return mcp[1] === 'claude-in-chrome' ? 'claude-in-chrome' : `mcp:${mcp[1]}`;
}

function contentBlocks(content) {
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  return Array.isArray(content) ? content : [];
}

export function parseTranscript(text) {
  const calls = new Map();
  const results = [];
  const turns = [];
  let malformed = 0;

  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      malformed += 1;
      continue;
    }
    const message = entry.message ?? {};
    if (entry.type === 'assistant') {
      const u = message.usage;
      if (u) {
        turns.push({
          index: turns.length,
          usage: {
            input: u.input_tokens ?? 0,
            cacheCreation: u.cache_creation_input_tokens ?? 0,
            cacheRead: u.cache_read_input_tokens ?? 0,
            output: u.output_tokens ?? 0,
          },
        });
      }
      for (const block of contentBlocks(message.content)) {
        if (block.type === 'tool_use') calls.set(block.id, { name: block.name, turn: turns.length - 1 });
      }
    } else if (entry.type === 'user') {
      for (const block of contentBlocks(message.content)) {
        if (block.type !== 'tool_result') continue;
        const call = calls.get(block.tool_use_id);
        let textChars = 0;
        const images = [];
        for (const item of contentBlocks(block.content)) {
          if (item.type === 'text') textChars += (item.text ?? '').length;
          else if (item.type === 'image') images.push(imageSize(item.source?.data ?? ''));
        }
        results.push({
          toolUseId: block.tool_use_id,
          name: call?.name ?? 'unknown',
          turn: call?.turn ?? turns.length - 1,
          textChars,
          images,
        });
      }
    }
  }
  return { calls, results, turns, malformed };
}
