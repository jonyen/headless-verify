// Parse a Claude Code session transcript (JSONL) into tool calls, tool
// results and per-API-call usage. Pure: takes the file text, returns data.

import { imageSize } from './image-size.mjs';

export function toolFamily(name) {
  const mcp = /^mcp__(.+?)__/.exec(name);
  if (!mcp) return name;
  return mcp[1] === 'claude-in-chrome' ? 'claude-in-chrome' : `mcp:${mcp[1]}`;
}

// Attachment entries carry content the harness adds to the next request (hook output, reminders,
// listings). When the entry has a `rendered` form, that is the model-facing text and is counted.
// Older entries have no `rendered` form; for attachment types that are rendered elsewhere, the
// string fields of the attachment are counted, minus metadata fields. Types never seen with a
// rendered form (e.g. prompt_snapshot, a copy of the system prompt) are not counted.
export const SENT_ATTACHMENT_TYPES = new Set([
  'hook_success', 'hook_additional_context', 'environment', 'model', 'deferred_tools_delta',
  'agent_listing_delta', 'mcp_instructions_delta', 'skill_listing', 'auto_mode',
  'total_tokens_reminder', 'session_context', 'date', 'remote_session_change',
  'silent_turn_reminder', 'queued_command', 'edited_text_file', 'diagnostics', 'instructions',
  'bash_output_audience_note',
]);
const ATTACHMENT_METADATA = new Set([
  'type', 'toolUseID', 'hookName', 'hookEvent', 'command', 'durationMs', 'exitCode', 'stdout',
  'stderr', 'names', 'addedNames', 'removedNames', 'readdedNames', 'wireHiddenNames', 'addedTypes',
  'removedTypes', 'failedMcpServers', 'needsAuthMcpServers', 'pendingMcpServers', 'source_uuid',
  'timestamp', 'commandMode', 'origin', 'url', 'commit', 'pr', 'filename', 'displayPath', 'path',
  'isInitial', 'skillCount', 'showConcurrencyNote', 'isNew', 'sendUserFileHint',
]);

// Text characters in an attachment without a rendered form. Image blocks are collected as images
// (their base64 is not text the model reads as characters); document blocks and any `source` or
// `data` field are skipped.
function walkAttachment(value, images) {
  if (typeof value === 'string') return value.length;
  if (Array.isArray(value)) return value.reduce((s, v) => s + walkAttachment(v, images), 0);
  if (!value || typeof value !== 'object') return 0;
  if (value.type === 'image') {
    images.push(imageSize(typeof value.source?.data === 'string' ? value.source.data : ''));
    return 0;
  }
  if (value.type === 'document') return 0;
  return Object.entries(value).reduce(
    (s, [k, v]) => s + (ATTACHMENT_METADATA.has(k) || k === 'source' || k === 'data' ? 0 : walkAttachment(v, images)),
    0,
  );
}

// Returns { textChars, images } for one attachment entry.
export function attachmentContent(entry) {
  const images = [];
  if (Array.isArray(entry.rendered)) {
    const textChars = entry.rendered.reduce((s, r) => s + (typeof r?.content === 'string' ? r.content.length : 0), 0);
    return { textChars, images };
  }
  const a = entry.attachment;
  if (!a || !SENT_ATTACHMENT_TYPES.has(a.type)) return { textChars: 0, images };
  return { textChars: walkAttachment(a, images), images };
}

function contentBlocks(content) {
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  return Array.isArray(content) ? content : [];
}

// `attachments: false` parses as the original analyzer did (attachment entries ignored); the
// CLI's --fixed mode uses it to reproduce the fixed-ratio numbers exactly.
export function parseTranscript(text, { attachments = true } = {}) {
  const calls = new Map();
  const results = [];
  const turns = [];
  const turnByMessageId = new Map();
  // Index of the first turn after each explicit compaction marker (no content is kept).
  const compactBoundaries = [];
  const markCompaction = () => {
    if (compactBoundaries.at(-1) !== turns.length) compactBoundaries.push(turns.length);
  };
  let attachmentTotal = 0;
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
    if (entry.type === 'system' && entry.subtype === 'compact_boundary') {
      markCompaction();
      continue;
    }
    if (entry.type === 'user' && entry.isCompactSummary === true) markCompaction();
    if (entry.type === 'attachment') {
      if (!attachments) continue;
      // Same attribution as context:user: growth only once a turn has completed.
      const { textChars, images } = attachmentContent(entry);
      if ((textChars > 0 || images.length > 0) && turns.length > 0) {
        attachmentTotal += textChars;
        results.push({ toolUseId: null, name: 'context:attachment', turn: turns.length - 1, textChars, images });
      }
      continue;
    }
    if (entry.type === 'assistant') {
      const messageId = message.id;
      let turnIndex = turns.length - 1;
      const seen = messageId != null && turnByMessageId.has(messageId);
      if (!seen) {
        const u = message.usage;
        if (u) {
          turnIndex = turns.length;
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
        if (messageId != null) turnByMessageId.set(messageId, turnIndex);
      } else {
        turnIndex = turnByMessageId.get(messageId);
      }
      for (const block of contentBlocks(message.content)) {
        if (block.type === 'tool_use') calls.set(block.id, { name: block.name, turn: turnIndex });
      }
    } else if (entry.type === 'user') {
      let otherTextChars = 0;
      for (const block of contentBlocks(message.content)) {
        if (block.type === 'text') {
          // Non-tool-result content arriving in a user entry (a real prompt, a system
          // reminder, hook output, etc.). It still becomes context for later turns, so it
          // is counted, but never printed and never mistaken for a tool result.
          otherTextChars += (block.text ?? '').length;
          continue;
        }
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
      // Only attribute to a turn that has actually completed; content before the first
      // assistant turn is part of the initial prompt, not measurable "growth".
      if (otherTextChars > 0 && turns.length > 0) {
        results.push({
          toolUseId: null,
          name: 'context:user',
          turn: turns.length - 1,
          textChars: otherTextChars,
          images: [],
        });
      }
    }
  }
  return { calls, results, turns, compactBoundaries, attachmentChars: attachmentTotal, malformed };
}
