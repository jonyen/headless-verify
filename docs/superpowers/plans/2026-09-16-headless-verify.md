# headless-verify Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Claude Code plugin whose skill makes Claude verify local web apps with short headless scripts, plus a benchmark and a session analyzer that measure the token savings against claude-in-chrome.

**Architecture:** Plain Node ESM, no build step. `scripts/verify.mjs` wraps `playwright-core` (installed Chrome) behind a tiny check-runner API. `analyze/` parses Claude Code JSONL transcripts. `bench/` serves a fixture app with correct and defective variants, drives `claude -p` under two tool configurations, grades JSON answers and reports medians/IQR. Pure logic lives in small modules with `node --test` suites; I/O shells are thin.

**Tech Stack:** Node ≥ 20 (ESM, `node:test`, `node:http`), `playwright-core` ^1.63, Claude Code CLI ≥ 2.1, Google Chrome.

**Spec:** `docs/superpowers/specs/2026-09-16-headless-verify-design.md`

## Global Constraints

- Node 20+; ESM only (`"type": "module"`); no TypeScript, no bundler, no build step.
- Single runtime dependency: `playwright-core`. Dev/test uses only `node:test` and `node:assert`.
- Browser: `channel: 'chrome'` (installed Chrome). No Playwright browser downloads by default.
- `verify.mjs` exit codes: `0` all passed, `1` a check failed, `2` could not run.
- Default per-check timeout 15 s; screenshots cropped and capped at ~800 px wide.
- Analyzer: text ≈ 4 chars/token; image tokens = `width × height / 750`; reads local files only; output never includes tool-result content.
- Benchmark: 5 tasks × 2 arms × 5 runs; interleaved arms; `--max-budget-usd` cap per run; failures recorded, never dropped; accuracy shown beside savings; raw data in `results/<date>-<model>.json`.
- Tests run offline and spend no tokens (`npm test`).
- License MIT. Commit messages end with the session's Co-Authored-By / Claude-Session trailers.

## Spec amendments made while planning

Two gaps in the spec are fixed here and in the spec (Task 1 commits the edit):

1. **Screenshot counts without transcripts.** Runs use `--no-session-persistence`, so no transcript file exists. The runner uses `--output-format stream-json --verbose` and counts images in the streamed `tool_result` blocks; the final `result` event supplies usage, cost, duration and turns.
2. **Guessing must not score.** If every task's answer were "doesn't work", a model could score 100% by always answering `false`. Each task therefore has a **correct** and a **defective** variant of the fixture page (`?variant=ok` / `?variant=bug`). Each run is assigned a variant from a seeded shuffle that gives each task and arm an equal split; the answer key is `works: variant === 'ok'`.

## File structure

```
headless-verify/
  package.json                       name, type module, engines, deps, scripts
  .claude-plugin/plugin.json         plugin manifest
  skills/verifying-web-apps-headlessly/
    SKILL.md                         the skill Claude loads
    reference.md                     runnable recipes
  scripts/
    load-playwright.mjs              resolve playwright-core, self-install to a cache dir if missing
    verify.mjs                       verify(url, fn, opts) check runner, output, exit codes
  analyze/
    transcript.mjs                   parse JSONL → calls, results, assistant usage (pure)
    image-size.mjs                   PNG/JPEG/WebP/GIF dimensions from base64 (pure)
    cost.mjs                         sizes, carry cost, grouping, calibration (pure)
    session-cost.mjs                 CLI: file discovery, formatting
  bench/
    fixture-app/index.html           five widgets, each with ok/bug behaviour by ?variant
    fixture-app/app.js
    fixture-app/styles.css
    fixture-app/clip.mp4             6 s generated test video (committed, ~60 KB)
    fixture-app/make-clip.sh         regenerates clip.mp4 with ffmpeg
    server.mjs                       startFixture() → { url, close }
    tasks/*.md                       five prompts with {URL} placeholder
    tasks.mjs                        task ids, prompt loading
    grade.mjs                        extract JSON answer, grade vs variant (pure)
    stats.mjs                        median, IQR, savings (pure)
    stream.mjs                       parse stream-json output → run record (pure)
    arms.mjs                         claude CLI args per arm (pure)
    schedule.mjs                     seeded interleaved run schedule (pure)
    run.mjs                          CLI: preflight, consent, execute, write results
    report.mjs                       CLI: results JSON → markdown table, README update
  test/
    fixtures/session-small.jsonl     synthetic transcript with known answers
    fixtures/stream-headless.jsonl   synthetic stream-json run
    fixtures/stream-browser.jsonl
    analyze-*.test.mjs, bench-*.test.mjs, verify.test.mjs, fixture-app.test.mjs
  results/                           benchmark outputs (committed)
  README.md, LICENSE
```

---

### Task 1: Project scaffold and spec amendments

**Files:**
- Create: `package.json`, `.claude-plugin/plugin.json`, `test/smoke.test.mjs`
- Modify: `.gitignore`, `docs/superpowers/specs/2026-09-16-headless-verify-design.md`

**Interfaces:**
- Produces: `npm test` runs `node --test test/` ; plugin name `headless-verify`.

- [ ] **Step 1: Write the smoke test**

`test/smoke.test.mjs`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('package and plugin manifests agree on name and version', async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const plugin = JSON.parse(
    await readFile(new URL('../.claude-plugin/plugin.json', import.meta.url), 'utf8'),
  );
  assert.equal(pkg.name, 'headless-verify');
  assert.equal(plugin.name, pkg.name);
  assert.equal(plugin.version, pkg.version);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test test/`
Expected: FAIL, `ENOENT` for `package.json`.

- [ ] **Step 3: Create the manifests**

`package.json`:
```json
{
  "name": "headless-verify",
  "version": "0.1.0",
  "description": "Verify local web apps from Claude Code with headless scripts instead of screenshot-driven browser automation.",
  "type": "module",
  "license": "MIT",
  "author": "Jonathan Yen",
  "engines": { "node": ">=20" },
  "scripts": {
    "test": "node --test test/",
    "analyze": "node analyze/session-cost.mjs",
    "bench": "node bench/run.mjs",
    "report": "node bench/report.mjs"
  },
  "dependencies": { "playwright-core": "^1.63.0" }
}
```

`.claude-plugin/plugin.json`:
```json
{
  "name": "headless-verify",
  "version": "0.1.0",
  "description": "Verify local web apps with headless scripts that print compact text instead of screenshot-driven browser automation.",
  "author": { "name": "Jonathan Yen" },
  "license": "MIT",
  "repository": "https://github.com/jonyen/headless-verify"
}
```

Append to `.gitignore`:
```
bench/.runs/
```

- [ ] **Step 4: Amend the spec**

In the spec's **Per-run record** paragraph, replace "Screenshot count comes from the run's transcript." with:
"Runs use `--output-format stream-json --verbose`; screenshot count comes from image blocks in the streamed tool results, and usage, cost, duration and turns from the final `result` event."

In the spec's **Tasks** paragraph, append:
"Each task has a correct (`?variant=ok`) and a defective (`?variant=bug`) version of its widget. Runs are assigned variants by a seeded shuffle giving every task and arm an equal split, and the answer key is `works === (variant === 'ok')`, so always answering `false` scores 50%, not 100%."

- [ ] **Step 5: Install and run tests**

Run: `npm install && npm test`
Expected: PASS (1 test).

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json .claude-plugin/plugin.json .gitignore test/smoke.test.mjs docs/superpowers/specs/2026-09-16-headless-verify-design.md
git commit -m "Scaffold plugin package and amend spec for stream-json and ok/bug variants"
```

---

### Task 2: Analyzer — transcript parsing and image sizes

**Files:**
- Create: `analyze/transcript.mjs`, `analyze/image-size.mjs`, `test/fixtures/session-small.jsonl`, `test/analyze-transcript.test.mjs`

**Interfaces:**
- Produces:
  - `imageSize(base64: string) → { width: number, height: number } | null`
  - `parseTranscript(text: string) → { calls: Map<id, {name, turn}>, results: Array<{toolUseId, name, turn, textChars, images: Array<{width,height}|null>}>, turns: Array<{index, usage: {input, cacheCreation, cacheRead, output}}>, malformed: number }`
    - `turn` is the index into `turns` of the most recent assistant API call at the time the call/result appeared (results: the call that *requested* it).
    - `name` is `'unknown'` when no matching call exists.
  - `toolFamily(name: string) → 'claude-in-chrome' | 'Bash' | 'Read' | string` (`mcp__claude-in-chrome__*` → `'claude-in-chrome'`, other `mcp__server__tool` → `'mcp:server'`, built-ins unchanged).

- [ ] **Step 1: Create the synthetic transcript fixture**

Generate `test/fixtures/session-small.jsonl` with this script (run once, commit the output):

```bash
node --input-type=module -e '
import { writeFileSync } from "node:fs";
// PNG header only: signature + IHDR with width=1500, height=1000
const png = Buffer.alloc(33);
Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]).copy(png, 0);
png.writeUInt32BE(13, 8); png.write("IHDR", 12, "ascii");
png.writeUInt32BE(1500, 16); png.writeUInt32BE(1000, 20);
const img = png.toString("base64");
const u = (input, cc, cr, out) => ({ input_tokens: input, cache_creation_input_tokens: cc, cache_read_input_tokens: cr, output_tokens: out });
const lines = [
  { type: "user", message: { role: "user", content: "check the app" } },
  { type: "assistant", message: { usage: u(10, 1000, 0, 50), content: [{ type: "tool_use", id: "t1", name: "mcp__claude-in-chrome__computer", input: {} }] } },
  { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "x".repeat(400) }, { type: "image", source: { type: "base64", media_type: "image/png", data: img } }] }] } },
  "this line is not json",
  { type: "assistant", message: { usage: u(10, 2150, 1000, 40), content: [{ type: "tool_use", id: "t2", name: "Bash", input: {} }] } },
  { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t2", content: "y".repeat(800) }] } },
  { type: "assistant", message: { usage: u(10, 240, 3150, 30), content: [{ type: "text", text: "done" }] } },
  { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "zzz", content: "orphan" }] } },
];
writeFileSync("test/fixtures/session-small.jsonl", lines.map(l => typeof l === "string" ? l : JSON.stringify(l)).join("\n") + "\n");
'
```

Known answers: 3 assistant turns; result `t1` → claude-in-chrome, turn 0, 400 text chars, one image 1500×1000 (2000 tokens); result `t2` → Bash, turn 1, 800 chars; orphan result name `unknown`; `malformed === 1`.

- [ ] **Step 2: Write failing tests**

`test/analyze-transcript.test.mjs`:
```js
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

test('toolFamily groups MCP tools by server', () => {
  assert.equal(toolFamily('mcp__claude-in-chrome__computer'), 'claude-in-chrome');
  assert.equal(toolFamily('mcp__XcodeBuildMCP__build_sim'), 'mcp:XcodeBuildMCP');
  assert.equal(toolFamily('Bash'), 'Bash');
});
```

- [ ] **Step 3: Run to verify failure**

Run: `node --test test/analyze-transcript.test.mjs`
Expected: FAIL, cannot find module `../analyze/image-size.mjs`.

- [ ] **Step 4: Implement**

`analyze/image-size.mjs`:
```js
// Pixel dimensions from the header of a base64 PNG, JPEG, GIF or WebP.
// Returns null when the format is not recognised.

export function imageSize(base64) {
  const buf = Buffer.from(base64.slice(0, 64_000), 'base64');
  if (buf.length >= 24 && buf.readUInt32BE(0) === 0x89504e47) {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  if (buf.length >= 10 && buf.toString('ascii', 0, 3) === 'GIF') {
    return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
  }
  if (buf.length >= 30 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    const chunk = buf.toString('ascii', 12, 16);
    if (chunk === 'VP8X') {
      return { width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) };
    }
    if (chunk === 'VP8 ') {
      return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
    }
    if (chunk === 'VP8L') {
      const bits = buf.readUInt32LE(21);
      return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >> 14) & 0x3fff) };
    }
  }
  if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) return null;
      const marker = buf[i + 1];
      const len = buf.readUInt16BE(i + 2);
      const isSof = marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);
      if (isSof) return { width: buf.readUInt16BE(i + 7), height: buf.readUInt16BE(i + 5) };
      i += 2 + len;
    }
  }
  return null;
}
```

`analyze/transcript.mjs`:
```js
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
```

- [ ] **Step 5: Run tests**

Run: `node --test test/analyze-transcript.test.mjs`
Expected: PASS (5 tests).

- [ ] **Step 6: Commit**

```bash
git add analyze/transcript.mjs analyze/image-size.mjs test/fixtures/session-small.jsonl test/analyze-transcript.test.mjs
git commit -m "Analyzer: parse transcripts and read image dimensions"
```

---

### Task 3: Analyzer — cost model, calibration and CLI

**Files:**
- Create: `analyze/cost.mjs`, `analyze/session-cost.mjs`, `test/analyze-cost.test.mjs`

**Interfaces:**
- Consumes: `parseTranscript`, `toolFamily` (Task 2).
- Produces:
  - `resultTokens(result) → { text: number, image: number, total: number }` — text `ceil(chars/4)`, image `round(w*h/750)` per image, unknown image dims count as 1600.
  - `costBreakdown(transcript) → { families: Array<{family, calls, images, directTokens, carryTokens, shareOfInput}>, totals: {billedInput, direct, carry}, calibration: {estimated, recorded, errorPct} }`
    - `carryTokens` for a result = `total × (number of turns with index > result.turn + 1)`: the turn right after the result reads it fresh (direct); every later turn re-reads it from cache.
    - `billedInput` = Σ over turns of `input + cacheCreation + cacheRead`.
    - `shareOfInput` = `(directTokens + carryTokens) / billedInput`.
    - `calibration`: for every turn `k ≥ 1`, recorded growth = `(input+cacheCreation+cacheRead)[k] − (input+cacheCreation+cacheRead)[k−1] − output[k−1]`; estimated growth = Σ `total` of results whose `turn === k−1`. Sum both over turns where at least one result exists; `errorPct = |estimated − recorded| / recorded × 100`.
  - CLI `node analyze/session-cost.mjs <file.jsonl | --all> [--since YYYY-MM-DD] [--json]`.

- [ ] **Step 1: Write failing tests**

`test/analyze-cost.test.mjs`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parseTranscript } from '../analyze/transcript.mjs';
import { costBreakdown, resultTokens } from '../analyze/cost.mjs';

const fixturePath = new URL('./fixtures/session-small.jsonl', import.meta.url);
const load = async () => parseTranscript(await readFile(fixturePath, 'utf8'));

test('resultTokens counts text by chars and images by pixels', () => {
  assert.deepEqual(
    resultTokens({ textChars: 401, images: [{ width: 1500, height: 1000 }, null] }),
    { text: 101, image: 2000 + 1600, total: 3701 },
  );
});

test('costBreakdown attributes direct and carry tokens per family', async () => {
  const { families, totals } = costBreakdown(await load());
  const chrome = families.find((f) => f.family === 'claude-in-chrome');
  const bash = families.find((f) => f.family === 'Bash');
  // t1: 100 text + 2000 image = 2100, requested at turn 0, read fresh by turn 1, re-read by turn 2.
  assert.equal(chrome.calls, 1);
  assert.equal(chrome.images, 1);
  assert.equal(chrome.directTokens, 2100);
  assert.equal(chrome.carryTokens, 2100);
  // t2: 200 text, requested at turn 1, read fresh by turn 2, no later turns.
  assert.equal(bash.directTokens, 200);
  assert.equal(bash.carryTokens, 0);
  assert.equal(totals.billedInput, 1010 + 3160 + 3400);
  assert.ok(Math.abs(chrome.shareOfInput - 4200 / 7570) < 1e-9);
});

test('calibration compares estimated and recorded context growth', async () => {
  const { calibration } = costBreakdown(await load());
  // turn1 growth: 3160 - 1010 - 50 = 2100 (estimated 2100); turn2: 3400 - 3160 - 40 = 200 (estimated 200)
  assert.equal(calibration.recorded, 2300);
  assert.equal(calibration.estimated, 2300);
  assert.equal(calibration.errorPct, 0);
});

test('CLI prints a markdown table without tool-result content', async () => {
  const { stdout } = await promisify(execFile)('node', [
    new URL('../analyze/session-cost.mjs', import.meta.url).pathname,
    fixturePath.pathname,
  ]);
  assert.match(stdout, /\| claude-in-chrome \| 1 \| 1 \|/);
  assert.doesNotMatch(stdout, /yyyy|xxxx|orphan/);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test test/analyze-cost.test.mjs`
Expected: FAIL, cannot find module `../analyze/cost.mjs`.

- [ ] **Step 3: Implement `analyze/cost.mjs`**

```js
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
```

- [ ] **Step 4: Implement `analyze/session-cost.mjs`**

```js
#!/usr/bin/env node
// Usage: node analyze/session-cost.mjs <session.jsonl | --all> [--since YYYY-MM-DD] [--json]
// Reads Claude Code transcripts locally and reports token cost by tool family.
// Output never includes tool-result content.

import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseTranscript } from './transcript.mjs';
import { costBreakdown } from './cost.mjs';

const args = process.argv.slice(2);
const json = args.includes('--json');
const sinceIdx = args.indexOf('--since');
const since = sinceIdx >= 0 ? new Date(args[sinceIdx + 1]) : null;
const target = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--since');

async function allTranscripts() {
  const root = join(homedir(), '.claude', 'projects');
  const files = [];
  for (const dir of await readdir(root)) {
    for (const name of await readdir(join(root, dir)).catch(() => [])) {
      if (!name.endsWith('.jsonl')) continue;
      const path = join(root, dir, name);
      if (since && (await stat(path)).mtime < since) continue;
      files.push(path);
    }
  }
  return files;
}

if (!target && !args.includes('--all')) {
  console.error('usage: session-cost.mjs <session.jsonl | --all> [--since YYYY-MM-DD] [--json]');
  process.exit(2);
}

const files = args.includes('--all') ? await allTranscripts() : [target];
let malformed = 0;
// Carry cost must not cross session boundaries.
const reports = [];
for (const file of files) {
  const transcript = parseTranscript(await readFile(file, 'utf8'));
  malformed += transcript.malformed;
  reports.push(costBreakdown(transcript));
}
const combined = reports.reduce(
  (acc, r) => {
    for (const f of r.families) {
      const row = acc.families.get(f.family) ?? { family: f.family, calls: 0, images: 0, directTokens: 0, carryTokens: 0 };
      row.calls += f.calls;
      row.images += f.images;
      row.directTokens += f.directTokens;
      row.carryTokens += f.carryTokens;
      acc.families.set(f.family, row);
    }
    acc.billedInput += r.totals.billedInput;
    acc.estimated += r.calibration.estimated;
    acc.recorded += r.calibration.recorded;
    return acc;
  },
  { families: new Map(), billedInput: 0, estimated: 0, recorded: 0 },
);
const families = [...combined.families.values()]
  .map((f) => ({ ...f, shareOfInput: combined.billedInput ? (f.directTokens + f.carryTokens) / combined.billedInput : 0 }))
  .sort((a, b) => b.directTokens + b.carryTokens - (a.directTokens + a.carryTokens));
const errorPct = combined.recorded ? (Math.abs(combined.estimated - combined.recorded) / combined.recorded) * 100 : 0;

if (json) {
  console.log(JSON.stringify({ sessions: files.length, malformed, billedInput: combined.billedInput, families, calibration: { estimated: combined.estimated, recorded: combined.recorded, errorPct } }, null, 2));
} else {
  const fmt = (n) => Math.round(n).toLocaleString('en-US');
  console.log(`Sessions: ${files.length} · billed input tokens: ${fmt(combined.billedInput)}${malformed ? ` · skipped ${malformed} malformed lines` : ''}\n`);
  console.log('| tool family | calls | images | direct tokens | carry tokens | share of input |');
  console.log('| --- | --- | --- | --- | --- | --- |');
  for (const f of families) {
    console.log(`| ${f.family} | ${f.calls} | ${f.images} | ${fmt(f.directTokens)} | ${fmt(f.carryTokens)} | ${(f.shareOfInput * 100).toFixed(1)}% |`);
  }
  console.log(`\nCalibration: estimated ${fmt(combined.estimated)} vs recorded ${fmt(combined.recorded)} tokens of new context (${errorPct.toFixed(1)}% off)`);
}
```

- [ ] **Step 5: Run tests**

Run: `node --test test/analyze-cost.test.mjs`
Expected: PASS (4 tests).

- [ ] **Step 6: Run against a real session (no assertion, sanity check)**

Run: `node analyze/session-cost.mjs "$(ls -t ~/.claude/projects/*/*.jsonl | head -1)"`
Expected: a table with at least a `Bash` row and a calibration line. Note the calibration error in the commit message body.

- [ ] **Step 7: Commit**

```bash
git add analyze/cost.mjs analyze/session-cost.mjs test/analyze-cost.test.mjs
git commit -m "Analyzer: direct and carry token cost by tool family, with calibration"
```

---

### Task 4: `verify.mjs` helper

**Files:**
- Create: `scripts/load-playwright.mjs`, `scripts/verify.mjs`, `test/verify.test.mjs`

**Interfaces:**
- Produces:
  - `loadPlaywright() → Promise<import('playwright-core')>` — imports `playwright-core` normally; if that fails, runs `npm install --prefix <cacheDir> playwright-core@^1.63.0` once (`cacheDir` = `$HEADLESS_VERIFY_CACHE` or `~/.cache/headless-verify`) and imports from there.
  - `verify(url: string, fn: (page, check) => Promise<void>, opts?: { viewport?: {width,height}, timeout?: number, channel?: string, headless?: boolean, log?: (line: string) => void, exit?: boolean }) → Promise<{ passed: number, failed: number, consoleErrors: string[], exitCode: 0|1|2 }>`
    - `check(name: string, predicate: () => boolean | Promise<boolean>)` retries the predicate every 100 ms until true or `timeout` (default 15000) → logs `✓ name` or `✗ name: <reason>` (reason: `timed out after Ns` or the thrown message).
    - `screenshot(page, { path, clip, maxWidth = 800 })` exported separately: element or clip screenshot, then scales down by setting `deviceScaleFactor` so width ≤ maxWidth; logs `saved <path> (WxH)`.
    - After `fn`, logs each console error as `console.error: <text>` and page errors as `pageerror: <message>`, then `N passed, M failed`.
    - `exit` (default `true` when run as a script via `process.argv[1]`): calls `process.exit(exitCode)`.
    - Exit code 2 when Chrome fails to launch (message includes `npx playwright install chromium` and `channel: 'chromium'`), when `page.goto` fails, or when `fn` throws before any check ran.

- [ ] **Step 1: Write failing tests**

`test/verify.test.mjs`:
```js
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { verify } from '../scripts/verify.mjs';

let server;
let url;
before(async () => {
  server = http.createServer((req, res) => {
    res.setHeader('content-type', 'text/html');
    res.end(`<button id="b">go</button><p id="out"></p>
      <script>
        document.getElementById('b').onclick = () => { document.getElementById('out').textContent = 'clicked'; };
        console.error('boom from page');
      </script>`);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${server.address().port}/`;
});
after(() => server.close());

const quiet = () => {
  const lines = [];
  return { lines, log: (l) => lines.push(l) };
};

test('passing and failing checks, console errors, exit code 1', async () => {
  const { lines, log } = quiet();
  const result = await verify(
    url,
    async (page, check) => {
      await page.click('#b');
      await check('output says clicked', async () => (await page.textContent('#out')) === 'clicked');
      await check('output says nope', async () => (await page.textContent('#out')) === 'nope');
    },
    { log, exit: false, timeout: 500 },
  );
  assert.equal(result.passed, 1);
  assert.equal(result.failed, 1);
  assert.equal(result.exitCode, 1);
  assert.ok(lines.includes('✓ output says clicked'));
  assert.ok(lines.some((l) => l.startsWith('✗ output says nope: timed out after 0.5s')));
  assert.ok(lines.includes('console.error: boom from page'));
  assert.equal(lines.at(-1), '1 passed, 1 failed');
});

test('unreachable URL exits with code 2', async () => {
  const { log } = quiet();
  const result = await verify('http://127.0.0.1:1/', async () => {}, { log, exit: false });
  assert.equal(result.exitCode, 2);
});

test('all checks passing exits 0', async () => {
  const { log } = quiet();
  const result = await verify(url, async (page, check) => {
    await check('button exists', async () => (await page.locator('#b').count()) === 1);
  }, { log, exit: false });
  assert.equal(result.exitCode, 0);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test test/verify.test.mjs`
Expected: FAIL, cannot find module `../scripts/verify.mjs`.

- [ ] **Step 3: Implement `scripts/load-playwright.mjs`**

```js
// Resolve playwright-core. Inside this repo it is a normal dependency; when the
// plugin is installed without node_modules, install it once into a cache dir.

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const VERSION = '^1.63.0';

export async function loadPlaywright() {
  try {
    return await import('playwright-core');
  } catch {
    const cache = process.env.HEADLESS_VERIFY_CACHE ?? join(homedir(), '.cache', 'headless-verify');
    const entry = join(cache, 'node_modules', 'playwright-core', 'index.mjs');
    if (!existsSync(entry)) {
      process.stderr.write(`installing playwright-core into ${cache} (one time)\n`);
      execFileSync('npm', ['install', '--prefix', cache, '--no-save', `playwright-core@${VERSION}`], {
        stdio: ['ignore', 'ignore', 'inherit'],
      });
    }
    return import(pathToFileURL(entry).href);
  }
}
```

- [ ] **Step 4: Implement `scripts/verify.mjs`**

```js
// verify(url, async (page, check) => { ... }) runs checks against a page in
// headless Chrome and prints one line per check, console errors, and a summary.
// Exit codes: 0 all passed, 1 a check failed, 2 could not run.

import { loadPlaywright } from './load-playwright.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function screenshot(page, { path, clip, selector, maxWidth = 800, log = console.log }) {
  const target = selector ? page.locator(selector) : page;
  const box = selector ? await target.boundingBox() : clip ?? { x: 0, y: 0, ...page.viewportSize() };
  const scale = Math.min(1, maxWidth / box.width);
  const buffer = await target.screenshot({ ...(selector ? {} : { clip: box }), scale: 'css' });
  const { writeFile } = await import('node:fs/promises');
  if (scale < 1) {
    const small = await page.evaluate(
      async ({ data, scale }) => {
        const img = new Image();
        img.src = `data:image/png;base64,${data}`;
        await img.decode();
        const c = document.createElement('canvas');
        c.width = Math.round(img.width * scale);
        c.height = Math.round(img.height * scale);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        return c.toDataURL('image/png').split(',')[1];
      },
      { data: buffer.toString('base64'), scale },
    );
    await writeFile(path, Buffer.from(small, 'base64'));
  } else {
    await writeFile(path, buffer);
  }
  log(`saved ${path} (${Math.round(box.width * scale)}x${Math.round(box.height * scale)})`);
}

export async function verify(url, fn, opts = {}) {
  const {
    viewport = { width: 1280, height: 800 },
    timeout = 15_000,
    channel = 'chrome',
    headless = true,
    log = console.log,
    exit = process.argv[1] !== undefined && !process.argv[1].includes('node_modules') && opts.exit !== false,
  } = opts;
  const result = { passed: 0, failed: 0, consoleErrors: [], exitCode: 0 };
  const finish = () => {
    if (exit) process.exit(result.exitCode);
    return result;
  };

  const { chromium } = await loadPlaywright();
  let browser;
  try {
    browser = await chromium.launch({ channel, headless });
  } catch (err) {
    log(`could not launch ${channel}: ${err.message.split('\n')[0]}`);
    log("install Chromium with `npx playwright install chromium` and pass { channel: 'chromium' }");
    result.exitCode = 2;
    return finish();
  }

  const pageErrors = [];
  try {
    const page = await browser.newPage({ viewport });
    page.on('console', (msg) => {
      if (msg.type() === 'error') result.consoleErrors.push(msg.text());
    });
    page.on('pageerror', (err) => pageErrors.push(err.message));
    try {
      await page.goto(url, { waitUntil: 'load', timeout });
    } catch (err) {
      log(`could not open ${url}: ${err.message.split('\n')[0]}`);
      result.exitCode = 2;
      return finish();
    }

    const check = async (name, predicate) => {
      const deadline = Date.now() + timeout;
      let lastError;
      for (;;) {
        try {
          if (await predicate()) {
            result.passed += 1;
            log(`✓ ${name}`);
            return true;
          }
          lastError = undefined;
        } catch (err) {
          lastError = err;
        }
        if (Date.now() >= deadline) break;
        await sleep(100);
      }
      result.failed += 1;
      log(`✗ ${name}: ${lastError ? lastError.message.split('\n')[0] : `timed out after ${timeout / 1000}s`}`);
      return false;
    };

    try {
      await fn(page, check);
    } catch (err) {
      log(`script error: ${err.message.split('\n')[0]}`);
      if (result.passed + result.failed === 0) {
        result.exitCode = 2;
        return finish();
      }
      result.failed += 1;
    }
    for (const text of result.consoleErrors) log(`console.error: ${text}`);
    for (const message of pageErrors) log(`pageerror: ${message}`);
    log(`${result.passed} passed, ${result.failed} failed`);
    result.exitCode = result.failed > 0 ? 1 : 0;
    return finish();
  } finally {
    await browser.close();
  }
}
```

Note: `finish()` inside `try` still runs `finally` because `process.exit` is only called when `exit` is true, and in scripts closing the browser before exit is not required (the process ends). Tests pass `exit: false`.

- [ ] **Step 5: Run tests**

Run: `node --test test/verify.test.mjs`
Expected: PASS (3 tests). If Chrome is missing on the machine, the first test fails with the launch message; install Chrome, don't change the default channel.

- [ ] **Step 6: Commit**

```bash
git add scripts/load-playwright.mjs scripts/verify.mjs test/verify.test.mjs
git commit -m "Add verify.mjs check runner with compact output and exit codes"
```

---

### Task 5: Fixture app with ok/bug variants

**Files:**
- Create: `bench/fixture-app/index.html`, `bench/fixture-app/app.js`, `bench/fixture-app/styles.css`, `bench/fixture-app/make-clip.sh`, `bench/fixture-app/clip.mp4`, `bench/server.mjs`, `test/fixture-app.test.mjs`

**Interfaces:**
- Consumes: `verify` (Task 4) in tests.
- Produces:
  - `startFixture() → Promise<{ url: string, close: () => Promise<void> }>` — serves `bench/fixture-app/` on `127.0.0.1` random port, with HTTP range support for `clip.mp4`. `url` ends with `/`.
  - Page contract (`?variant=ok|bug`, default `ok`), element ids used by tests and tasks:
    1. **load**: `#load-btn` button, `#load-result` text `"Loaded 3 items"` after click. Bug: first click ignored.
    2. **preview**: `#track` (400 px wide, represents 0–60 s), hovering shows `#preview` with text `m:ss`. Bug: time computed from `clientX` without subtracting the track's left edge.
    3. **captions**: `<video id="clip" src="clip.mp4">` and `#captions` with six `<span data-start="0..5">` words; the span whose second is playing gets class `active`. Bug: `timeupdate` listener attached to a `video` looked up before it is inserted into the DOM.
    4. **toolbar**: `#toolbar` (max-width 260 px) with buttons; `#show-cuts` label. Bug: `white-space: nowrap` and no wrap so `#show-cuts` extends past `#toolbar`'s right edge.
    5. **form**: `#email` input, `#submit` button, `#form-status` shows `"Saved"`. Bug: submit handler reads `undefined.value`, throws (console error), status never updates.

- [ ] **Step 1: Generate the clip**

`bench/fixture-app/make-clip.sh`:
```bash
#!/usr/bin/env bash
# 6 s, 320x180, 1 fps counter video with a quiet tone. ~60 KB. Regenerate with this script.
set -euo pipefail
cd "$(dirname "$0")"
ffmpeg -hide_banner -loglevel error -y \
  -f lavfi -i "testsrc2=size=320x180:rate=10:duration=6" \
  -f lavfi -i "sine=frequency=220:duration=6" \
  -c:v libx264 -crf 32 -pix_fmt yuv420p -c:a aac -b:a 32k -movflags +faststart clip.mp4
```

Run: `chmod +x bench/fixture-app/make-clip.sh && bench/fixture-app/make-clip.sh && ls -la bench/fixture-app/clip.mp4`
Expected: file exists, under 200 KB.

- [ ] **Step 2: Write failing tests (the helper must detect every defect and pass every correct variant)**

`test/fixture-app.test.mjs`:
```js
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startFixture } from '../bench/server.mjs';
import { verify } from '../scripts/verify.mjs';

let fixture;
before(async () => { fixture = await startFixture(); });
after(() => fixture.close());

const opts = { log: () => {}, exit: false, timeout: 3000 };
const run = (variant, fn) => verify(`${fixture.url}?variant=${variant}`, fn, opts);

const checks = {
  load: async (page, check) => {
    await page.click('#load-btn');
    await check('load shows items', async () => (await page.textContent('#load-result')) === 'Loaded 3 items');
  },
  preview: async (page, check) => {
    const box = await page.locator('#track').boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await check('preview shows 0:30', async () => (await page.textContent('#preview')) === '0:30');
  },
  captions: async (page, check) => {
    await page.evaluate(() => new Promise((resolve) => {
      const v = document.getElementById('clip');
      v.muted = true;
      const go = () => { v.currentTime = 3.5; v.addEventListener('seeked', () => resolve(), { once: true }); };
      v.readyState >= 1 ? go() : v.addEventListener('loadedmetadata', go, { once: true });
    }));
    await check('word 3 active', async () => (await page.getAttribute('#captions [data-start="3"]', 'class'))?.includes('active'));
  },
  toolbar: async (page, check) => {
    await check('label inside toolbar', async () => {
      const bar = await page.locator('#toolbar').boundingBox();
      const label = await page.locator('#show-cuts').boundingBox();
      return label.x + label.width <= bar.x + bar.width + 0.5;
    });
  },
  form: async (page, check) => {
    await page.fill('#email', 'a@example.com');
    await page.click('#submit');
    await check('form saved', async () => (await page.textContent('#form-status')) === 'Saved');
  },
};

for (const [name, fn] of Object.entries(checks)) {
  test(`${name}: ok variant passes`, async () => {
    const r = await run('ok', fn);
    assert.equal(r.exitCode, 0);
    assert.deepEqual(r.consoleErrors, []);
  });
  test(`${name}: bug variant fails`, async () => {
    const r = await run('bug', fn);
    assert.equal(r.exitCode, 1);
  });
}
```

- [ ] **Step 3: Run to verify failure**

Run: `node --test test/fixture-app.test.mjs`
Expected: FAIL, cannot find module `../bench/server.mjs`.

- [ ] **Step 4: Implement the server**

`bench/server.mjs`:
```js
// Serves bench/fixture-app on a random localhost port, with Range support for video.

import http from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('./fixture-app/', import.meta.url));
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.mp4': 'video/mp4' };

export async function startFixture() {
  const server = http.createServer(async (req, res) => {
    const pathname = new URL(req.url, 'http://x').pathname;
    const file = normalize(join(root, pathname === '/' ? 'index.html' : pathname));
    if (!file.startsWith(root)) return res.writeHead(403).end();
    let info;
    try {
      info = await stat(file);
    } catch {
      return res.writeHead(404).end();
    }
    const type = types[extname(file)] ?? 'application/octet-stream';
    const range = /bytes=(\d*)-(\d*)/.exec(req.headers.range ?? '');
    if (range) {
      const start = range[1] ? Number(range[1]) : 0;
      const end = range[2] ? Number(range[2]) : info.size - 1;
      res.writeHead(206, {
        'content-type': type,
        'content-range': `bytes ${start}-${end}/${info.size}`,
        'accept-ranges': 'bytes',
        'content-length': end - start + 1,
      });
      return createReadStream(file, { start, end }).pipe(res);
    }
    res.writeHead(200, { 'content-type': type, 'content-length': info.size, 'accept-ranges': 'bytes' });
    createReadStream(file).pipe(res);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    url: `http://127.0.0.1:${server.address().port}/`,
    close: () => new Promise((r) => server.close(r)),
  };
}
```

- [ ] **Step 5: Implement the page**

`bench/fixture-app/index.html`:
```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Fixture app</title>
    <link rel="stylesheet" href="styles.css" />
  </head>
  <body>
    <section id="load">
      <h2>Load items</h2>
      <button id="load-btn" type="button">Load</button>
      <p id="load-result"></p>
    </section>

    <section id="preview-section">
      <h2>Timeline</h2>
      <div class="spacer-left"></div>
      <div id="track"></div>
      <p>Preview: <span id="preview"></span></p>
    </section>

    <section id="captions-section">
      <h2>Captions</h2>
      <div id="player-slot"></div>
      <p id="captions">
        <span data-start="0">zero</span> <span data-start="1">one</span>
        <span data-start="2">two</span> <span data-start="3">three</span>
        <span data-start="4">four</span> <span data-start="5">five</span>
      </p>
    </section>

    <section id="toolbar-section">
      <h2>Toolbar</h2>
      <div id="toolbar">
        <button type="button">Remove fillers</button>
        <button type="button">Tighten pauses</button>
        <label id="show-cuts"><input type="checkbox" checked /> Show cuts</label>
      </div>
    </section>

    <section id="form-section">
      <h2>Subscribe</h2>
      <form id="form">
        <input id="email" type="email" placeholder="email" />
        <button id="submit" type="submit">Save</button>
        <p id="form-status"></p>
      </form>
    </section>

    <script src="app.js"></script>
  </body>
</html>
```

`bench/fixture-app/styles.css`:
```css
body { font: 16px system-ui, sans-serif; margin: 24px; max-width: 720px; }
section { margin-bottom: 32px; }
#preview-section { position: relative; }
.spacer-left { display: inline-block; width: 120px; }
#track { display: inline-block; width: 400px; height: 16px; background: #ccd; vertical-align: middle; }
#captions .active { background: #fde047; }
#toolbar { max-width: 260px; display: flex; flex-wrap: wrap; gap: 8px; border: 1px solid #ccc; padding: 8px; }
#toolbar button, #toolbar label { white-space: nowrap; }
body.bug #toolbar { flex-wrap: nowrap; }
```

`bench/fixture-app/app.js`:
```js
const bug = new URLSearchParams(location.search).get('variant') === 'bug';
if (bug) document.body.classList.add('bug');

// 1. Load: the buggy version ignores the first click.
let clicks = 0;
document.getElementById('load-btn').addEventListener('click', () => {
  clicks += 1;
  if (bug && clicks === 1) return;
  document.getElementById('load-result').textContent = 'Loaded 3 items';
});

// 2. Preview: track spans 0–60 s. The buggy version forgets the track's left offset.
const track = document.getElementById('track');
track.addEventListener('mousemove', (e) => {
  const rect = track.getBoundingClientRect();
  const x = bug ? e.clientX : e.clientX - rect.left;
  const seconds = Math.max(0, Math.min(60, Math.round((x / rect.width) * 60)));
  document.getElementById('preview').textContent = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
});

// 3. Captions: highlight the word for the current second. The buggy version
// binds to the video before it exists, so nothing ever updates.
function highlight(t) {
  for (const span of document.querySelectorAll('#captions span')) {
    span.classList.toggle('active', Math.floor(t) === Number(span.dataset.start));
  }
}
const earlyVideo = document.getElementById('clip');
const video = document.createElement('video');
video.id = 'clip';
video.src = 'clip.mp4';
video.preload = 'auto';
video.controls = true;
video.width = 320;
if (bug) {
  earlyVideo?.addEventListener('timeupdate', () => highlight(earlyVideo.currentTime));
} else {
  const sync = () => highlight(video.currentTime);
  video.addEventListener('timeupdate', sync);
  video.addEventListener('seeked', sync);
}
document.getElementById('player-slot').append(video);

// 4. Toolbar: styling only (body.bug disables wrapping).

// 5. Form: the buggy version reads a field that does not exist.
document.getElementById('form').addEventListener('submit', (e) => {
  e.preventDefault();
  const email = bug ? document.getElementById('e-mail').value : document.getElementById('email').value;
  if (email) document.getElementById('form-status').textContent = 'Saved';
});
```

- [ ] **Step 6: Run tests**

Run: `node --test test/fixture-app.test.mjs`
Expected: PASS (10 tests). If `captions: ok` fails, confirm Chrome (not Chromium) is used — Chromium lacks H.264.

- [ ] **Step 7: Commit**

```bash
git add bench/server.mjs bench/fixture-app test/fixture-app.test.mjs
git commit -m "Benchmark fixture app with ok and bug variants of five widgets"
```

---

### Task 6: The skill

**Files:**
- Create: `skills/verifying-web-apps-headlessly/SKILL.md`, `skills/verifying-web-apps-headlessly/reference.md`

**Interfaces:**
- Consumes: `verify`, `screenshot` from `scripts/verify.mjs` (Task 4); recipes mirror `test/fixture-app.test.mjs` (Task 5).
- Produces: skill name `verifying-web-apps-headlessly`, referenced by the benchmark's headless arm.

- [ ] **Step 1: Baseline (RED) — observe behaviour without the skill**

Start the fixture: `node -e "import('./bench/server.mjs').then(async m => { const f = await m.startFixture(); console.log(f.url); setInterval(()=>{}, 1e9); })"` and note the URL.

Dispatch a fresh general-purpose subagent (no plugin) with exactly: "Check whether the captions highlight follows the video at {URL}?variant=bug. Answer only with JSON {\"works\": boolean, \"cause\": string}." Record: tools used, number of screenshots, whether it concluded correctly. Save notes to `bench/baseline-notes.md` (committed; no transcript content, just counts and the approach taken).

- [ ] **Step 2: Write `SKILL.md`**

```markdown
---
name: verifying-web-apps-headlessly
description: Use when about to check, test, or confirm that a change works in a web app running locally (localhost, a dev server, a static HTML file) — before reaching for browser-automation or screenshot tools.
---

# Verifying web apps headlessly

## Overview

Check a local web app with **one headless script that prints a few lines of text**, not a
sequence of browser-tool calls and screenshots. Every screenshot is an image that stays in the
conversation and is re-read on every later turn; every navigate/click/screenshot step is a
round trip. A script does the whole check in one call and returns only the verdict.

## When to use

- "Does the button work now?", "check the page loads", "confirm the fix", "test the form".
- After changing front-end code in a project with a dev server.

Use a real browser tool (such as claude-in-chrome) **only** when the check needs the user's own
logged-in browser session, a browser extension, or the user asks to watch.

## Workflow

1. Make sure the app is running and note its URL.
2. Write a short script to the scratchpad (or `/tmp`) that imports `verify` from
   `${CLAUDE_PLUGIN_ROOT}/scripts/verify.mjs`:

   ```js
   import { verify } from '${CLAUDE_PLUGIN_ROOT}/scripts/verify.mjs';

   await verify('http://localhost:5173', async (page, check) => {
     await page.getByRole('button', { name: 'Load' }).click();
     await check('items appear', async () => (await page.locator('.item').count()) === 3);
   });
   ```

3. Run it with `node script.mjs`. Read the output: `✓`/`✗` per check, console errors, a summary.
   Exit code `0` = passed, `1` = a check failed, `2` = could not run.
4. If a check fails, add a check or print one specific value that explains why
   (`console.log(await page.textContent('#status'))`), re-run, and fix the code.

## Output rules

- Print only what decides the question: pass/fail and the few values that explain a failure.
- Never print page HTML, `page.content()`, or accessibility trees.
- Wait on conditions (`check` retries until true; `waitForSelector`, media events), never fixed
  sleeps.
- Screenshots only for visual questions (layout, overlap, colour, alignment). Use
  `screenshot(page, { selector, path })` from the same module: it crops to the element and caps
  width at 800 px. Then Read the one image. Prefer measuring bounding boxes instead when the
  question is "does X overflow / overlap Y".

## Common mistakes

| Mistake | Instead |
| --- | --- |
| Screenshot after every step to "see what happened" | One `check` per expected outcome; text output |
| Clicking by coordinates from a screenshot | `page.getByRole` / `page.locator` |
| Testing media in a browser tool whose tab is hidden (media won't load) | Headless Chrome: mute, seek, wait for `seeked` |
| `waitForTimeout(3000)` | `check(...)` or an event/selector wait |
| Chromium for mp4/H.264 | Default `channel: 'chrome'` |

See `reference.md` for complete recipes: media playback, hover/drag, forms, console errors,
layout overlap, authenticated pages.
```

- [ ] **Step 3: Write `reference.md`**

Include six complete, runnable recipes. Each is a full script using `verify`; copy the bodies of
the corresponding checks in `test/fixture-app.test.mjs` for media (`captions`), hover (`preview`),
form + console errors (`form`), layout overlap (`toolbar`), plus:

Drag:
```js
import { verify } from '${CLAUDE_PLUGIN_ROOT}/scripts/verify.mjs';

await verify('http://localhost:5173', async (page, check) => {
  const bar = await page.locator('.scrubber').boundingBox();
  await page.mouse.move(bar.x + 5, bar.y + bar.height / 2);
  await page.mouse.down();
  await page.mouse.move(bar.x + bar.width * 0.75, bar.y + bar.height / 2, { steps: 10 });
  await page.mouse.up();
  await check('playhead near 75%', async () => {
    const t = await page.evaluate(() => document.querySelector('video').currentTime);
    const d = await page.evaluate(() => document.querySelector('video').duration);
    return Math.abs(t / d - 0.75) < 0.05;
  });
});
```

Authenticated pages (save state once with a visible browser, reuse headless):
```js
// save-login.mjs — run once: node save-login.mjs, log in, then close the window.
import { loadPlaywright } from '${CLAUDE_PLUGIN_ROOT}/scripts/load-playwright.mjs';
const { chromium } = await loadPlaywright();
const browser = await chromium.launch({ channel: 'chrome', headless: false });
const context = await browser.newContext();
const page = await context.newPage();
await page.goto('http://localhost:5173/login');
page.on('close', async () => { await context.storageState({ path: '.auth.json' }); await browser.close(); });
```
```js
// check.mjs — reuse the saved session headlessly.
import { loadPlaywright } from '${CLAUDE_PLUGIN_ROOT}/scripts/load-playwright.mjs';
const { chromium } = await loadPlaywright();
const browser = await chromium.launch({ channel: 'chrome' });
const context = await browser.newContext({ storageState: '.auth.json' });
const page = await context.newPage();
await page.goto('http://localhost:5173/account');
console.log((await page.locator('h1').textContent()) === 'Your account' ? '✓ logged in' : '✗ not logged in');
await browser.close();
```

Add a note at the top of `reference.md`: never commit `.auth.json`; add it to `.gitignore`.

- [ ] **Step 4: GREEN — re-run the baseline with the skill**

Dispatch a fresh subagent with the same prompt, this time instructing it to first read
`skills/verifying-web-apps-headlessly/SKILL.md` and `reference.md` and to set
`CLAUDE_PLUGIN_ROOT` to the repo root in its scripts. Record the same counts in
`bench/baseline-notes.md`. Expected: a script via Bash, zero or one screenshot, correct answer.
If it still reaches for browser tools, tighten the "When to use" wording and repeat.

- [ ] **Step 5: Commit**

```bash
git add skills bench/baseline-notes.md
git commit -m "Add verifying-web-apps-headlessly skill and recipes"
```

---

### Task 7: Benchmark core — tasks, grading, stats, stream parsing, arms, schedule

**Files:**
- Create: `bench/tasks/load.md`, `bench/tasks/preview.md`, `bench/tasks/captions.md`, `bench/tasks/toolbar.md`, `bench/tasks/form.md`, `bench/tasks.mjs`, `bench/grade.mjs`, `bench/stats.mjs`, `bench/stream.mjs`, `bench/arms.mjs`, `bench/schedule.mjs`, `test/fixtures/stream-headless.jsonl`, `test/fixtures/stream-browser.jsonl`, `test/bench-core.test.mjs`

**Interfaces:**
- Produces:
  - `TASK_IDS = ['load', 'preview', 'captions', 'toolbar', 'form']`; `loadPrompt(id, url) → Promise<string>` replaces `{URL}`.
  - `extractAnswer(text) → { works: boolean, cause: string } | null` — last JSON object in the text containing a boolean `works`.
  - `grade(answer, variant) → boolean` — `answer !== null && answer.works === (variant === 'ok')`.
  - `median(xs) → number`, `iqr(xs) → [q1, q3]` (linear interpolation, inclusive), `savedPct(browser, headless) → number` = `(browser − headless) / browser × 100`.
  - `parseStream(text) → { finalText, usage: {input, output, cacheCreation, cacheRead}, costUsd, durationMs, turns, screenshots, isError, subtype }`.
  - `armArgs(arm: 'browser'|'headless', { model, budgetUsd, pluginDir }) → string[]` (excluding the prompt, which is passed last).
  - `schedule({ tasks, runs, seed }) → Array<{ task, arm, variant, run }>` — for each task, runs `0..runs-1` for both arms; variants alternate `ok`/`bug` by run index then are permuted by the seed (same permutation for both arms of a task, so arms see identical variant sequences); order interleaves arms `browser, headless, headless, browser, …` per task and shuffles tasks by seed.

- [ ] **Step 1: Write the task prompts**

Each file is exactly (with the widget description changed):

`bench/tasks/load.md`:
```
There is a web page running at {URL}. In its "Load items" section, clicking the Load button should show "Loaded 3 items".

Check whether that works. Do not modify any files of the app.

Answer with only a JSON object on the last line: {"works": true or false, "cause": "one sentence"}
```

`bench/tasks/preview.md`:
```
There is a web page running at {URL}. In its "Timeline" section, hovering the bar should show the time at the pointer in the "Preview" text, where the bar spans 0:00 at its left edge to 1:00 at its right edge.

Check whether that works. Do not modify any files of the app.

Answer with only a JSON object on the last line: {"works": true or false, "cause": "one sentence"}
```

`bench/tasks/captions.md`:
```
There is a web page running at {URL}. In its "Captions" section, while the video plays, the word for the current second should be highlighted.

Check whether that works. Do not modify any files of the app.

Answer with only a JSON object on the last line: {"works": true or false, "cause": "one sentence"}
```

`bench/tasks/toolbar.md`:
```
There is a web page running at {URL}. In its "Toolbar" section, every control, including the "Show cuts" checkbox label, should sit inside the toolbar's border.

Check whether that works. Do not modify any files of the app.

Answer with only a JSON object on the last line: {"works": true or false, "cause": "one sentence"}
```

`bench/tasks/form.md`:
```
There is a web page running at {URL}. In its "Subscribe" section, entering an email and pressing Save should show "Saved".

Check whether that works. Do not modify any files of the app.

Answer with only a JSON object on the last line: {"works": true or false, "cause": "one sentence"}
```

- [ ] **Step 2: Create stream fixtures**

`test/fixtures/stream-headless.jsonl` (one JSON object per line):
```
{"type":"system","subtype":"init","model":"claude-opus-5"}
{"type":"assistant","message":{"content":[{"type":"tool_use","id":"a","name":"Bash","input":{"command":"node check.mjs"}}]}}
{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"a","content":"✗ word 3 active: timed out after 15s\n0 passed, 1 failed"}]}}
{"type":"assistant","message":{"content":[{"type":"text","text":"The highlight never updates.\n{\"works\": false, \"cause\": \"timeupdate listener is never attached\"}"}]}}
{"type":"result","subtype":"success","is_error":false,"duration_ms":41000,"num_turns":3,"total_cost_usd":0.21,"result":"The highlight never updates.\n{\"works\": false, \"cause\": \"timeupdate listener is never attached\"}","usage":{"input_tokens":20,"output_tokens":900,"cache_creation_input_tokens":14000,"cache_read_input_tokens":30000}}
```

`test/fixtures/stream-browser.jsonl`:
```
{"type":"system","subtype":"init","model":"claude-opus-5"}
{"type":"assistant","message":{"content":[{"type":"tool_use","id":"a","name":"mcp__claude-in-chrome__computer","input":{"action":"screenshot"}}]}}
{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"a","content":[{"type":"text","text":"ok"},{"type":"image","source":{"type":"base64","media_type":"image/jpeg","data":"/9j/"}}]}]}}
{"type":"assistant","message":{"content":[{"type":"tool_use","id":"b","name":"mcp__claude-in-chrome__computer","input":{"action":"screenshot"}}]}}
{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"b","content":[{"type":"image","source":{"type":"base64","media_type":"image/jpeg","data":"/9j/"}}]}]}}
{"type":"result","subtype":"error_max_budget_usd","is_error":true,"duration_ms":90000,"num_turns":9,"total_cost_usd":1.5,"result":"","usage":{"input_tokens":40,"output_tokens":2000,"cache_creation_input_tokens":60000,"cache_read_input_tokens":200000}}
```

- [ ] **Step 3: Write failing tests**

`test/bench-core.test.mjs`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { TASK_IDS, loadPrompt } from '../bench/tasks.mjs';
import { extractAnswer, grade } from '../bench/grade.mjs';
import { iqr, median, savedPct } from '../bench/stats.mjs';
import { parseStream } from '../bench/stream.mjs';
import { armArgs } from '../bench/arms.mjs';
import { schedule } from '../bench/schedule.mjs';

const fx = (name) => readFile(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');

test('prompts load for every task with the URL filled in', async () => {
  for (const id of TASK_IDS) {
    const p = await loadPrompt(id, 'http://127.0.0.1:9/?variant=ok');
    assert.match(p, /http:\/\/127\.0\.0\.1:9\/\?variant=ok/);
    assert.doesNotMatch(p, /\{URL\}|bug|broken|defect/i);
  }
});

test('extractAnswer takes the last JSON object with a boolean works', () => {
  const text = 'first {"works": true, "cause": "x"} then\n{"works": false, "cause": "y"}';
  assert.deepEqual(extractAnswer(text), { works: false, cause: 'y' });
  assert.equal(extractAnswer('no json here'), null);
  assert.equal(extractAnswer('{"works": "yes"}'), null);
});

test('grade compares works against the variant', () => {
  assert.equal(grade({ works: true, cause: '' }, 'ok'), true);
  assert.equal(grade({ works: true, cause: '' }, 'bug'), false);
  assert.equal(grade(null, 'bug'), false);
});

test('median, IQR and savings', () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 3, 2]), 2.5);
  assert.deepEqual(iqr([1, 2, 3, 4, 5]), [2, 4]);
  assert.equal(savedPct(200, 50), 75);
});

test('parseStream reads usage, cost, answer and screenshots', async () => {
  const h = parseStream(await fx('stream-headless.jsonl'));
  assert.deepEqual(h.usage, { input: 20, output: 900, cacheCreation: 14000, cacheRead: 30000 });
  assert.equal(h.costUsd, 0.21);
  assert.equal(h.turns, 3);
  assert.equal(h.screenshots, 0);
  assert.equal(h.isError, false);
  assert.deepEqual(extractAnswer(h.finalText), { works: false, cause: 'timeupdate listener is never attached' });

  const b = parseStream(await fx('stream-browser.jsonl'));
  assert.equal(b.screenshots, 2);
  assert.equal(b.isError, true);
  assert.equal(b.subtype, 'error_max_budget_usd');
});

test('arm arguments isolate the tools under test', () => {
  const common = { model: 'claude-opus-5', budgetUsd: 2, pluginDir: '/repo' };
  const browser = armArgs('browser', common);
  const headless = armArgs('headless', common);
  for (const args of [browser, headless]) {
    assert.ok(args.includes('-p'));
    assert.deepEqual(args.slice(args.indexOf('--output-format'), args.indexOf('--output-format') + 2), ['--output-format', 'stream-json']);
    assert.ok(args.includes('--verbose'));
    assert.ok(args.includes('--no-session-persistence'));
    assert.equal(args[args.indexOf('--max-budget-usd') + 1], '2');
    assert.equal(args[args.indexOf('--model') + 1], 'claude-opus-5');
  }
  assert.ok(browser.includes('--chrome'));
  assert.equal(browser[browser.indexOf('--disallowedTools') + 1], 'Bash');
  assert.ok(!browser.includes('--plugin-dir'));
  assert.ok(headless.includes('--no-chrome'));
  assert.equal(headless[headless.indexOf('--plugin-dir') + 1], '/repo');
});

test('schedule: equal ok/bug split, identical variants across arms, interleaved', () => {
  const s = schedule({ tasks: TASK_IDS, runs: 4, seed: 7 });
  assert.equal(s.length, TASK_IDS.length * 2 * 4);
  for (const task of TASK_IDS) {
    for (const arm of ['browser', 'headless']) {
      const mine = s.filter((r) => r.task === task && r.arm === arm);
      assert.equal(mine.filter((r) => r.variant === 'ok').length, 2);
    }
    const seq = (arm) => s.filter((r) => r.task === task && r.arm === arm).sort((a, b) => a.run - b.run).map((r) => r.variant);
    assert.deepEqual(seq('browser'), seq('headless'));
  }
  const firstTask = s.filter((r) => r.task === s[0].task).map((r) => r.arm);
  assert.deepEqual(firstTask.slice(0, 4), ['browser', 'headless', 'headless', 'browser']);
  assert.deepEqual(schedule({ tasks: TASK_IDS, runs: 4, seed: 7 }), s);
});
```

- [ ] **Step 4: Run to verify failure**

Run: `node --test test/bench-core.test.mjs`
Expected: FAIL, cannot find module `../bench/tasks.mjs`.

- [ ] **Step 5: Implement the modules**

`bench/tasks.mjs`:
```js
import { readFile } from 'node:fs/promises';

export const TASK_IDS = ['load', 'preview', 'captions', 'toolbar', 'form'];

export async function loadPrompt(id, url) {
  const text = await readFile(new URL(`./tasks/${id}.md`, import.meta.url), 'utf8');
  return text.replaceAll('{URL}', url);
}
```

`bench/grade.mjs`:
```js
export function extractAnswer(text) {
  const candidates = text.match(/\{[^{}]*\}/g) ?? [];
  for (let i = candidates.length - 1; i >= 0; i--) {
    try {
      const obj = JSON.parse(candidates[i]);
      if (typeof obj.works === 'boolean') return { works: obj.works, cause: String(obj.cause ?? '') };
    } catch {
      // not JSON; keep looking
    }
  }
  return null;
}

export function grade(answer, variant) {
  return answer !== null && answer.works === (variant === 'ok');
}
```

`bench/stats.mjs`:
```js
const sorted = (xs) => [...xs].sort((a, b) => a - b);

function quantile(xs, q) {
  const s = sorted(xs);
  if (s.length === 0) return NaN;
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return s[lo] + (s[hi] - s[lo]) * (pos - lo);
}

export const median = (xs) => quantile(xs, 0.5);
export const iqr = (xs) => [quantile(xs, 0.25), quantile(xs, 0.75)];
export const savedPct = (browser, headless) => ((browser - headless) / browser) * 100;
```

`bench/stream.mjs`:
```js
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
```

`bench/arms.mjs`:
```js
export function armArgs(arm, { model, budgetUsd, pluginDir }) {
  const common = [
    '-p',
    '--output-format', 'stream-json',
    '--verbose',
    '--no-session-persistence',
    '--setting-sources', 'project',
    '--permission-mode', 'bypassPermissions',
    '--model', model,
    '--max-budget-usd', String(budgetUsd),
  ];
  if (arm === 'browser') return [...common, '--chrome', '--disallowedTools', 'Bash'];
  if (arm === 'headless') return [...common, '--no-chrome', '--plugin-dir', pluginDir];
  throw new Error(`unknown arm ${arm}`);
}
```

`bench/schedule.mjs`:
```js
function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 2 ** 32;
  };
}

function shuffle(xs, random) {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export function schedule({ tasks, runs, seed }) {
  const random = rng(seed);
  const out = [];
  for (const task of shuffle(tasks, random)) {
    const variants = shuffle(
      Array.from({ length: runs }, (_, i) => (i % 2 === 0 ? 'ok' : 'bug')),
      random,
    );
    for (let run = 0; run < runs; run++) {
      const order = run % 2 === 0 ? ['browser', 'headless'] : ['headless', 'browser'];
      for (const arm of order) out.push({ task, arm, variant: variants[run], run });
    }
  }
  return out;
}
```

- [ ] **Step 6: Run tests**

Run: `node --test test/bench-core.test.mjs`
Expected: PASS (7 tests).

- [ ] **Step 7: Commit**

```bash
git add bench/tasks bench/tasks.mjs bench/grade.mjs bench/stats.mjs bench/stream.mjs bench/arms.mjs bench/schedule.mjs test/fixtures/stream-*.jsonl test/bench-core.test.mjs
git commit -m "Benchmark core: prompts, grading, stats, stream parsing, arms, schedule"
```

---

### Task 8: Benchmark runner and report

**Files:**
- Create: `bench/run.mjs`, `bench/report.mjs`, `bench/summarize.mjs`, `test/bench-report.test.mjs`
- Modify: `README.md`

**Interfaces:**
- Consumes: everything from Task 7, `startFixture` (Task 5).
- Produces:
  - `summarize(records) → { overall: ArmPair, byTask: Record<taskId, ArmPair> }` where `ArmPair = { browser: ArmStats, headless: ArmStats, savedTokensPct, savedCostPct, savedDurationPct }` and `ArmStats = { n, correct, accuracy, tokens: {median, iqr}, costUsd: {median, iqr}, durationS: {median, iqr}, screenshots: {median} }`. Total tokens = `input + output + cacheCreation + cacheRead`.
  - `renderTable(summary, meta) → string` markdown.
  - Results file shape: `{ meta: { date, model, runs, seed, budgetUsd, claudeVersion }, records: Array<{ task, arm, variant, run, correct, answer, ...parseStream fields }> }`.
  - CLI `node bench/run.mjs [--runs 5] [--tasks a,b] [--model claude-opus-5] [--budget 2] [--seed N] [--yes]`.
  - CLI `node bench/report.mjs results/<file>.json [--readme]` — prints the table; with `--readme` replaces the block between `<!-- results:start -->` and `<!-- results:end -->` in README.md.

- [ ] **Step 1: Write failing tests for the pure summary and table**

`test/bench-report.test.mjs`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderTable, summarize } from '../bench/summarize.mjs';

const rec = (task, arm, tokens, cost, correct) => ({
  task, arm, variant: 'ok', run: 0, correct,
  usage: { input: 0, output: 0, cacheCreation: 0, cacheRead: tokens },
  costUsd: cost, durationMs: 10_000, screenshots: arm === 'browser' ? 4 : 0, isError: false,
});

const records = [
  rec('load', 'browser', 100_000, 1.0, true),
  rec('load', 'browser', 120_000, 1.2, true),
  rec('load', 'headless', 20_000, 0.2, true),
  rec('load', 'headless', 30_000, 0.3, false),
];

test('summarize computes medians, accuracy and savings', () => {
  const s = summarize(records);
  assert.equal(s.byTask.load.browser.tokens.median, 110_000);
  assert.equal(s.byTask.load.headless.tokens.median, 25_000);
  assert.equal(s.byTask.load.headless.accuracy, 0.5);
  assert.equal(s.overall.browser.n, 2);
  assert.ok(Math.abs(s.overall.savedTokensPct - ((110_000 - 25_000) / 110_000) * 100) < 1e-9);
});

test('renderTable shows accuracy next to savings for every task and overall', () => {
  const table = renderTable(summarize(records), { model: 'claude-opus-5', runs: 2, date: '2026-09-16' });
  assert.match(table, /\| load \|/);
  assert.match(table, /\| \*\*overall\*\* \|/);
  assert.match(table, /100% → 50%/);
  assert.match(table, /77\.3%/);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test test/bench-report.test.mjs`
Expected: FAIL, cannot find module `../bench/summarize.mjs`.

- [ ] **Step 3: Implement `bench/summarize.mjs`**

```js
import { iqr, median, savedPct } from './stats.mjs';

const totalTokens = (r) => r.usage.input + r.usage.output + r.usage.cacheCreation + r.usage.cacheRead;

function armStats(records) {
  const tokens = records.map(totalTokens);
  const cost = records.map((r) => r.costUsd);
  const duration = records.map((r) => r.durationMs / 1000);
  const correct = records.filter((r) => r.correct).length;
  return {
    n: records.length,
    correct,
    accuracy: records.length ? correct / records.length : 0,
    tokens: { median: median(tokens), iqr: iqr(tokens) },
    costUsd: { median: median(cost), iqr: iqr(cost) },
    durationS: { median: median(duration), iqr: iqr(duration) },
    screenshots: { median: median(records.map((r) => r.screenshots)) },
  };
}

function pair(records) {
  const browser = armStats(records.filter((r) => r.arm === 'browser'));
  const headless = armStats(records.filter((r) => r.arm === 'headless'));
  return {
    browser,
    headless,
    savedTokensPct: savedPct(browser.tokens.median, headless.tokens.median),
    savedCostPct: savedPct(browser.costUsd.median, headless.costUsd.median),
    savedDurationPct: savedPct(browser.durationS.median, headless.durationS.median),
  };
}

export function summarize(records) {
  const tasks = [...new Set(records.map((r) => r.task))];
  return {
    overall: pair(records),
    byTask: Object.fromEntries(tasks.map((t) => [t, pair(records.filter((r) => r.task === t))])),
  };
}

const k = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(Math.round(n)));
const usd = (n) => `$${n.toFixed(2)}`;
const pct = (n) => `${n.toFixed(1)}%`;
const acc = (a) => `${Math.round(a * 100)}%`;

export function renderTable(summary, meta) {
  const lines = [
    `Model \`${meta.model}\`, ${meta.runs} runs per task per arm, ${meta.date}. Medians; IQR in the results file.`,
    '',
    '| task | tokens (browser → headless) | saved | cost | saved | time | screenshots | accuracy |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
  ];
  const row = (name, p) =>
    `| ${name} | ${k(p.browser.tokens.median)} → ${k(p.headless.tokens.median)} | ${pct(p.savedTokensPct)} | ` +
    `${usd(p.browser.costUsd.median)} → ${usd(p.headless.costUsd.median)} | ${pct(p.savedCostPct)} | ` +
    `${Math.round(p.browser.durationS.median)}s → ${Math.round(p.headless.durationS.median)}s | ` +
    `${p.browser.screenshots.median} → ${p.headless.screenshots.median} | ` +
    `${acc(p.browser.accuracy)} → ${acc(p.headless.accuracy)} |`;
  for (const [task, p] of Object.entries(summary.byTask)) lines.push(row(task, p));
  lines.push(row('**overall**', summary.overall));
  return lines.join('\n');
}
```

- [ ] **Step 4: Run tests**

Run: `node --test test/bench-report.test.mjs`
Expected: PASS (2 tests).

- [ ] **Step 5: Implement `bench/run.mjs`**

```js
#!/usr/bin/env node
// Runs the benchmark: each task × arm × run through `claude -p`, graded, written to results/.

import { execFileSync, spawn } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { armArgs } from './arms.mjs';
import { extractAnswer, grade } from './grade.mjs';
import { schedule } from './schedule.mjs';
import { startFixture } from './server.mjs';
import { parseStream } from './stream.mjs';
import { TASK_IDS, loadPrompt } from './tasks.mjs';

const repo = fileURLToPath(new URL('..', import.meta.url));
const flag = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
};
const runs = Number(flag('runs', '5'));
const tasks = flag('tasks', TASK_IDS.join(',')).split(',');
const model = flag('model', 'claude-opus-5');
const budgetUsd = Number(flag('budget', '2'));
const seed = Number(flag('seed', String(Date.now() % 100000)));
const yes = process.argv.includes('--yes');

function claudeVersion() {
  try {
    return execFileSync('claude', ['--version'], { encoding: 'utf8' }).trim();
  } catch {
    console.error('`claude` CLI not found on PATH');
    process.exit(2);
  }
}

function runClaude(args, prompt, cwd) {
  return new Promise((resolve) => {
    const child = spawn('claude', [...args, prompt], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', () => {});
    child.on('close', () => resolve(out));
  });
}

async function once(item, fixture, cwd) {
  const url = `${fixture.url}?variant=${item.variant}`;
  const prompt = await loadPrompt(item.task, url);
  const parsed = parseStream(await runClaude(armArgs(item.arm, { model, budgetUsd, pluginDir: repo }), prompt, cwd));
  const answer = parsed.isError ? null : extractAnswer(parsed.finalText);
  return { ...item, ...parsed, answer, correct: grade(answer, item.variant) };
}

const version = claudeVersion();
const fixture = await startFixture();
const work = await mkdtemp(join(tmpdir(), 'headless-verify-bench-'));

// Preflight: the browser arm must actually have claude-in-chrome.
const probe = parseStream(
  await runClaude(
    armArgs('browser', { model, budgetUsd: 0.5, pluginDir: repo }),
    'List the names of your tools that start with mcp__claude-in-chrome, then stop.',
    work,
  ),
);
if (!/mcp__claude-in-chrome/.test(probe.finalText)) {
  console.error('claude-in-chrome is not available to `claude -p --chrome`. Connect the extension and retry.');
  await fixture.close();
  process.exit(2);
}

const plan = schedule({ tasks, runs, seed });
const calibration = await once(plan.find((p) => p.arm === 'browser'), fixture, work);
const calibrationH = await once(plan.find((p) => p.arm === 'headless'), fixture, work);
const estimate = ((calibration.costUsd + calibrationH.costUsd) / 2) * plan.length;
console.log(`${plan.length} runs planned (${tasks.length} tasks × 2 arms × ${runs}); estimated cost ≈ $${estimate.toFixed(2)} (budget cap $${budgetUsd}/run)`);

if (!yes) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question('Proceed? [y/N] ');
  rl.close();
  if (answer.trim().toLowerCase() !== 'y') {
    await fixture.close();
    process.exit(0);
  }
}

const records = [];
for (const [i, item] of plan.entries()) {
  const record = await once(item, fixture, work);
  records.push(record);
  console.log(`[${i + 1}/${plan.length}] ${item.task} ${item.arm} ${item.variant}: ${record.correct ? 'correct' : 'wrong'} · $${record.costUsd.toFixed(3)}${record.isError ? ` · ${record.subtype}` : ''}`);
}
await fixture.close();

const date = new Date().toISOString().slice(0, 10);
await mkdir(join(repo, 'results'), { recursive: true });
const path = join(repo, 'results', `${date}-${model}.json`);
await writeFile(path, JSON.stringify({ meta: { date, model, runs, seed, budgetUsd, claudeVersion: version }, records }, null, 2));
console.log(`wrote ${path}\nnext: node bench/report.mjs ${path} --readme`);
```

- [ ] **Step 6: Implement `bench/report.mjs`**

```js
#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { renderTable, summarize } from './summarize.mjs';

const [file] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
if (!file) {
  console.error('usage: report.mjs results/<file>.json [--readme]');
  process.exit(2);
}
const { meta, records } = JSON.parse(await readFile(file, 'utf8'));
const table = renderTable(summarize(records), meta);
console.log(table);

if (process.argv.includes('--readme')) {
  const readmeUrl = new URL('../README.md', import.meta.url);
  const readme = await readFile(readmeUrl, 'utf8');
  const start = '<!-- results:start -->';
  const end = '<!-- results:end -->';
  if (!readme.includes(start)) throw new Error('README.md has no results markers');
  const next = readme.replace(new RegExp(`${start}[\\s\\S]*${end}`), `${start}\n${table}\n\nRaw data: [\`${file}\`](${file})\n${end}`);
  await writeFile(readmeUrl, next);
}
```

- [ ] **Step 7: Rewrite README.md**

```markdown
# headless-verify

A Claude Code plugin that makes Claude check local web apps with short headless scripts that
print a few lines of text, instead of step-by-step browser automation with screenshots. It
includes a benchmark and a session analyzer that measure how many tokens that saves.

## Install

```sh
claude plugin install https://github.com/jonyen/headless-verify
```

Needs Node 20+ and Google Chrome. The first run installs `playwright-core` into
`~/.cache/headless-verify` if it isn't already available.

## What it does

When you ask Claude to confirm a change works on localhost, the `verifying-web-apps-headlessly`
skill has it write one script with `scripts/verify.mjs` and run it:

```
✓ items appear
✗ preview shows 0:30: timed out after 15s
console.error: Uncaught TypeError: Cannot read properties of null (reading 'value')
1 passed, 1 failed
```

Screenshots are reserved for visual questions, cropped to the element and capped at 800 px.

## Results

<!-- results:start -->
Not run yet.
<!-- results:end -->

## Measure your own sessions

```sh
node analyze/session-cost.mjs ~/.claude/projects/<project>/<session>.jsonl
node analyze/session-cost.mjs --all --since 2026-09-01
```

Reports calls, images, direct tokens and carry tokens (results re-read on later turns) per tool
family, plus a calibration line comparing its estimates with the usage recorded in the
transcript. It reads local files only and never prints tool-result content.

## Run the benchmark

```sh
npm install
node bench/run.mjs --runs 5        # asks before spending; --runs 1 for a cheap trial
node bench/report.mjs results/<file>.json --readme
```

Five tasks against a bundled fixture app, each with a working and a broken variant. Every run is
a fresh `claude -p` session. The *browser* arm has claude-in-chrome and no Bash; the *headless*
arm has Bash and this plugin and no claude-in-chrome. Runs are interleaved, capped with
`--max-budget-usd`, and failures count against their arm. See
[the design spec](docs/superpowers/specs/2026-09-16-headless-verify-design.md) for the method.

## Develop

```sh
npm test    # offline, spends no tokens
```

MIT © Jonathan Yen
```

- [ ] **Step 8: Run full test suite**

Run: `npm test`
Expected: PASS, all suites.

- [ ] **Step 9: Commit**

```bash
git add bench/run.mjs bench/report.mjs bench/summarize.mjs test/bench-report.test.mjs README.md
git commit -m "Benchmark runner, results summary and README"
```

---

### Task 9: Validation against the spec's success criteria

**Files:**
- Create: `results/<date>-<model>.json` (from the run), `docs/validation.md`
- Modify: `README.md` (results block)

**Interfaces:**
- Consumes: all CLIs.

- [ ] **Step 1: Offline suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 2: Analyzer calibration on the originating session**

Run: `node analyze/session-cost.mjs ~/.claude/projects/-Users-jonyen-Projects/c34456c0-8c79-4ce9-82d6-bb174c64936b.jsonl`
Expected: calibration error ≤ 15%. If higher, inspect which turns diverge (`--json`), adjust only the
constants in `analyze/cost.mjs` that the evidence supports (for example the chars-per-token ratio),
add a test that pins the corrected behaviour, and re-run. Record the table and error in
`docs/validation.md`.

- [ ] **Step 3: Plugin install smoke test**

Run: `claude --plugin-dir . -p "What skills do you have for checking a web app on localhost? Name them only."`
Expected: output names `verifying-web-apps-headlessly`.

Then confirm the install command documented in README.md against `claude plugin --help` on the
installed CLI (installing from a GitHub URL may require adding the repo as a marketplace first).
Correct the README's Install section to the command that actually works, and try it in a scratch
directory before committing.

- [ ] **Step 4: Trial benchmark (requires user confirmation of spend)**

Ask the user before running. Then: `node bench/run.mjs --runs 1 --tasks load,captions`
Expected: preflight passes, 4 runs recorded, results file written. Review for arm isolation
(browser arm has 0 Bash calls; headless arm has 0 screenshots unless a layout task).

- [ ] **Step 5: Full benchmark (requires user confirmation of the printed estimate)**

Run: `node bench/run.mjs --runs 5` then `node bench/report.mjs results/<file>.json --readme`
Expected: 50 records, README results block filled.

- [ ] **Step 6: Commit and push**

```bash
git add results docs/validation.md README.md
git commit -m "Record benchmark results and analyzer calibration"
git push
```

---

## Self-review notes

- **Spec coverage:** layout (T1–T8), skill + reference (T6), helper incl. exit codes and Chrome fallback message (T4), fixture with five defects (T5), tasks/arms/runs/interleaving/budget cap/records/failures kept (T7–T8), report with medians, IQR, accuracy beside savings, raw JSON, README table (T8), consent + calibration estimate + `--runs/--tasks` (T8), analyzer pairing/sizes/carry/grouping/calibration/markdown+JSON/local-only (T2–T3), error handling (T3 malformed + unknown, T4 launch/goto, T8 preflight), tests offline (all), skill baseline/with-skill (T6), success criteria (T9).
- **Amendments:** stream-json for screenshot counts; ok/bug variants to prevent guessing. Both folded into the spec in T1.
- **Types:** `parseStream` fields used by `summarize` (`usage`, `costUsd`, `durationMs`, `screenshots`) match; `schedule` items `{task, arm, variant, run}` flow into records; `verify` result shape matches its tests.
