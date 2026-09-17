import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { imageSize } from '../analyze/image-size.mjs';
import { parseTranscript, toolFamily } from '../analyze/transcript.mjs';

const fixture = () => readFile(new URL('./fixtures/session-small.jsonl', import.meta.url), 'utf8');

test('imageSize reads PNG dimensions', () => {
  const png = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png, 0);
  png.writeUInt32BE(640, 16);
  png.writeUInt32BE(480, 20);
  assert.deepEqual(imageSize(png.toString('base64')), { width: 640, height: 480 });
});

test('imageSize reads JPEG SOF0 dimensions', () => {
  const jpeg = Buffer.from([
    0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00,
    0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0xe0, 0x02, 0x80, 0x03,
  ]);
  assert.deepEqual(imageSize(jpeg.toString('base64')), { width: 640, height: 480 });
});

test('imageSize returns null for unknown data', () => {
  assert.equal(imageSize(Buffer.from('hello').toString('base64')), null);
});

test('parseTranscript pairs calls and results and counts malformed lines', async () => {
  const t = parseTranscript(await fixture());
  assert.equal(t.turns.length, 3);
  assert.equal(t.malformed, 1);
  assert.deepEqual(t.turns[1].usage, { input: 10, cacheCreation: 2150, cacheRead: 1000, output: 40 });
  const [r1, r2, orphan] = t.results;
  assert.equal(r1.name, 'mcp__claude-in-chrome__computer');
  assert.equal(r1.turn, 0);
  assert.equal(r1.textChars, 400);
  assert.deepEqual(r1.images, [{ width: 1500, height: 1000 }]);
  assert.equal(r2.name, 'Bash');
  assert.equal(r2.turn, 1);
  assert.equal(r2.textChars, 800);
  assert.equal(orphan.name, 'unknown');
});

test('repeated assistant lines with the same message.id do not double-count turns', () => {
  const lines = [
    JSON.stringify({
      type: 'assistant',
      message: {
        id: 'msg_1',
        usage: { input_tokens: 10, cache_creation_input_tokens: 100, cache_read_input_tokens: 0, output_tokens: 20 },
        content: [{ type: 'text', text: 'thinking' }],
      },
    }),
    JSON.stringify({
      type: 'assistant',
      message: {
        id: 'msg_1',
        usage: { input_tokens: 10, cache_creation_input_tokens: 100, cache_read_input_tokens: 0, output_tokens: 20 },
        content: [{ type: 'tool_use', id: 'tA', name: 'Bash', input: {} }],
      },
    }),
    JSON.stringify({
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 'tA', content: 'ok' }] },
    }),
    JSON.stringify({
      type: 'assistant',
      message: {
        id: 'msg_2',
        usage: { input_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 200, output_tokens: 10 },
        content: [{ type: 'text', text: 'done' }],
      },
    }),
  ];
  const t = parseTranscript(lines.join('\n'));
  assert.equal(t.turns.length, 2);
  const result = t.results.find((r) => r.toolUseId === 'tA');
  assert.equal(result.turn, 0);
  assert.equal(t.turns[1].index, 1);
});

test('non-tool-result content in a user entry is captured as a context:user entry, attributed to the prior turn', () => {
  const lines = [
    JSON.stringify({
      type: 'assistant',
      message: {
        id: 'msg_1',
        usage: { input_tokens: 10, cache_creation_input_tokens: 100, cache_read_input_tokens: 0, output_tokens: 20 },
        content: [{ type: 'tool_use', id: 'tA', name: 'Bash', input: {} }],
      },
    }),
    JSON.stringify({
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 'tA', content: 'ok' }, { type: 'text', text: 'a'.repeat(40) }] },
    }),
    JSON.stringify({
      type: 'assistant',
      message: {
        id: 'msg_2',
        usage: { input_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 200, output_tokens: 10 },
        content: [{ type: 'text', text: 'done' }],
      },
    }),
  ];
  const t = parseTranscript(lines.join('\n'));
  const ctx = t.results.find((r) => r.name === 'context:user');
  assert.ok(ctx, 'expected a context:user entry');
  assert.equal(ctx.turn, 0);
  assert.equal(ctx.textChars, 40);
});

test('non-tool-result user content before any completed turn is not attributed (no negative turn)', () => {
  const lines = [
    JSON.stringify({ type: 'user', message: { content: 'check the app' } }),
    JSON.stringify({
      type: 'assistant',
      message: {
        id: 'msg_1',
        usage: { input_tokens: 10, cache_creation_input_tokens: 100, cache_read_input_tokens: 0, output_tokens: 20 },
        content: [{ type: 'text', text: 'ack' }],
      },
    }),
  ];
  const t = parseTranscript(lines.join('\n'));
  assert.equal(t.results.filter((r) => r.name === 'context:user').length, 0);
});

test('toolFamily groups MCP tools by server', () => {
  assert.equal(toolFamily('mcp__claude-in-chrome__computer'), 'claude-in-chrome');
  assert.equal(toolFamily('mcp__XcodeBuildMCP__build_sim'), 'mcp:XcodeBuildMCP');
  assert.equal(toolFamily('Bash'), 'Bash');
});
