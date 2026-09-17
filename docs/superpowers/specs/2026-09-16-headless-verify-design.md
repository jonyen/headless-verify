# headless-verify: design

Date: 2026-09-16
Status: approved, including keeping the benchmark in the repo permanently

## Problem

When Claude Code checks that a change to a local web app works, the usual route is a
browser-automation tool such as claude-in-chrome: navigate, screenshot, click, screenshot again.
Each step is a round trip, and each screenshot is an image that stays in the conversation and is
re-read (as cached input) on every later turn. In one working session on a small app
(type-n-stitch), 36 claude-in-chrome calls returned 21 screenshots and ~13 K characters of text.
Several of those calls were retries: coordinate clicks missed after layout shifts, and the
controlled tab was hidden, so Chrome refused to load media and playback could not be tested at
all.

The same check done as one headless Playwright script, run through Bash, printed a few lines of
text, found a real bug the screenshots had missed, and needed no retries.

That observation is anecdotal. This project turns it into (1) a reusable skill and helper that
make the script-first approach the default, and (2) numbers that show how much it actually
saves, measured so anyone can reproduce or dispute them.

## Goals

- A Claude Code plugin other developers can install that makes Claude verify local web apps with
  short headless scripts that print compact text, and take screenshots only when layout itself is
  in question.
- A controlled benchmark comparing claude-in-chrome against the skill on identical tasks, reporting
  tokens, cost, wall time and accuracy with medians and spread.
- A session analyzer that measures what browser tools cost in real past sessions, including the
  carry cost of results re-read on later turns.

## Non-goals

- Replacing claude-in-chrome for tasks that need the user's logged-in browser, or interactive
  exploration where a human is watching.
- Windows or Linux support for the benchmark (the helper itself is portable).
- Benchmarking claude-in-chrome versions other than the one installed when it runs.
- Publishing to a plugin marketplace.

## Approach

Chosen: **a script-first skill with a small bundled helper.**

Rejected alternatives:

- **Instructions only (SKILL.md, no helper).** Simpler, but Claude re-derives launch, timeout and
  console-capture boilerplate each time, which spends output tokens and invites mistakes.
- **A text-only browser MCP server.** Low switching friction, but it keeps the step-by-step round
  trips, which are a large part of the cost, and is far more to build and maintain.

## Repository layout

```
headless-verify/
  .claude-plugin/plugin.json
  skills/verifying-web-apps-headlessly/
    SKILL.md            trigger, script-first workflow, output rules, when a screenshot is warranted
    reference.md        recipes: media playback, drag/hover, forms, console errors, layout overlap, auth'd pages
  scripts/
    verify.mjs          helper: launch headless Chrome, run checks, print compact results
  bench/
    fixture-app/        tiny static app with planted bugs, no build step
    tasks/*.md          one prompt per check, identical for both arms
    run.mjs             runs each task via `claude -p` under both arms, N runs each
    report.mjs          medians and spread into results/*.json and a markdown table
  analyze/
    session-cost.mjs    reads ~/.claude/projects/**/*.jsonl and attributes token cost to browser tools
  test/                 node --test suites
  README.md             install, usage, method, results table
  LICENSE               MIT
```

## Components

### Skill: `verifying-web-apps-headlessly`

`SKILL.md` is what Claude loads. It triggers when Claude is about to confirm that a change works
in a web app running locally (localhost, a dev server, a static file). It instructs:

1. Prefer one headless script over browser-automation tools for verification.
2. Write the script with `scripts/verify.mjs`, run it with `node`, and read its text output.
3. Print only what decides the question: pass/fail per check, the few DOM values or timings that
   matter, console errors. Never dump page HTML or full accessibility trees.
4. Take a screenshot only when the question is visual (layout, overlap, colour, alignment). Crop
   to the region in question and cap it at ~800 px wide.
5. Wait on conditions (selectors, events, `readyState`), not fixed sleeps.
6. Fall back to claude-in-chrome only for things a headless browser cannot do: the user's
   logged-in session, browser extensions, or when the user asks to watch.

`reference.md` holds recipes, each a complete runnable example: media playback (mute, seek, wait
for `seeked`, read state), hover and drag via `page.mouse`, form submission, capturing console
errors, detecting element overlap from bounding boxes, and reusing a storage state for
authenticated pages.

### Helper: `scripts/verify.mjs`

```js
import { verify } from './verify.mjs';

await verify('http://localhost:5174', async (page, check) => {
  await page.getByRole('button', { name: 'Two-person conversation' }).click();
  await check('transcript renders', () => page.locator('.turn').first().isVisible());
});
```

- Uses `playwright-core` with `channel: 'chrome'` (the installed Chrome), so there is no browser
  download and proprietary codecs such as H.264 work for media checks.
- Options: `viewport`, `timeout` (default 15 s per check), `screenshot: { path, clip, maxWidth }`.
- Output: one line per check (`✓ name` / `✗ name: reason`), then any console errors and page
  errors, then a one-line summary.
- Exit codes: `0` all checks passed, `1` a check failed, `2` could not run (Chrome missing, URL
  unreachable, script threw before checks).

### Benchmark: `bench/`

**Fixture app.** A static page served by a small Node server on a random free port. It contains
five planted defects, each with an answer key:

1. A button that ignores its first click.
2. A hover preview that shows the wrong time.
3. Video playback whose transcript highlight never updates (listeners bound before the element
   mounts).
4. A toolbar label that overflows into the neighbouring column.
5. A console error thrown on form submit.

**Tasks.** Five prompt files, one per defect, each phrased as "check whether X works at
{URL}; answer only with JSON `{"works": boolean, "cause": string}`". Prompts never hint at the
defect. Both arms get byte-identical prompts. Each task has a correct (`?variant=ok`) and a defective (`?variant=bug`) version of its widget. Runs are assigned variants by a seeded shuffle giving every task and arm an equal split, and the answer key is `works === (variant === 'ok')`, so always answering `false` scores 50%, not 100%.

**Arms.** Same model, fresh `claude -p` session per run, `--no-session-persistence`, no user
memory or project CLAUDE.md:

- *browser*: `--chrome`, Bash disallowed.
- *headless*: `--no-chrome`, Bash allowed, the plugin loaded with `--plugin-dir`.

**Runs.** 5 runs per task per arm (50 total), interleaved so neither arm benefits from a warm
prompt cache. Each run is capped with `--max-budget-usd` so a runaway run cannot drain spend.

**Per-run record.** From `--output-format json`: input, output, cache-creation and cache-read
tokens, `total_cost_usd`, duration, turns. The answer JSON is graded against the key (`works`
must match; `cause` is recorded, not graded). Runs use `--output-format stream-json --verbose`; screenshot count comes from image blocks in the streamed tool results, and usage, cost, duration and turns from the final `result` event.
Runs that error or hit the cap are recorded as failures, never dropped.

**Report.** Per task and overall, for each arm: median and interquartile range of total tokens,
cost, duration, and accuracy (correct/total), plus percentage saved. Accuracy is always shown
beside savings. Raw per-run data is written to `results/<date>-<model>.json`; the README table is
generated from it.

**Prerequisites and consent.** Chrome with the claude-in-chrome extension connected, the `claude`
CLI, Node 20+. `run.mjs` prints an estimated cost from a small calibration run and asks for
confirmation before the full run. `--runs N` and `--tasks a,b` allow cheaper partial runs.

### Session analyzer: `analyze/session-cost.mjs`

`node analyze/session-cost.mjs [path/to/session.jsonl | --all] [--since YYYY-MM-DD] [--json] [--fixed]`

- Pairs each `tool_use` with its `tool_result` by id.
- Estimates each result's direct size: text at a chars-per-token ratio fitted per session;
  images at `width × height / 750` tokens from their decoded dimensions, the published
  approximation for Claude image input.
- **Fitted ratios** (changed 2026-09-16; the original design used a fixed ~4 chars/token, which
  came out about 50% below recorded usage on tool-output-heavy sessions). Per turn with arriving
  content, recorded growth (context(k) − context(k−1) − output(k−1)) is modelled as tool-result
  chars / tool ratio + other context chars / context ratio + image tokens, fitted by least squares
  with non-negative coefficients. A class with fewer than 5 non-zero observations or a
  non-positive fit is held at 4 chars/token. (Changed 2026-09-17:) before fitting and scoring,
  turns are excluded and counted per reason: context resets (recorded context below the previous
  turn's, or an explicit `compact_boundary` marker), the turn after each reset, and growth ≤ 0.
  No per-turn overhead term (tried and reverted 2026-09-17; see docs/validation.md).
  Validation is 5-fold holdout (folds by turn index mod 5). The criterion is the median absolute
  per-turn error on held-out turns; |Σ predicted − Σ recorded| / Σ recorded is reported as
  secondary. Sessions with fewer than 20 usable turns, or `--fixed`,
  use 4 chars/token. The fixed-ratio calibration is still printed for comparison.
- Computes **carry cost**: the number of later assistant turns in the session that re-read the
  result, times its size, priced at the cache-read rate. Direct size and carry cost are reported
  separately.
- Groups by tool family (claude-in-chrome, Bash, Read, others) and reports each family's share of
  the session's billed input tokens.
- Prints the ratio method, fitted ratios, median per-turn holdout error (criterion), summed
  holdout error (secondary) and exclusion counts, plus the
  fixed-ratio estimate next to the recorded `usage` as a sanity check.
- Output: a markdown table by default, `--json` for scripts.
- Reads local files only and never sends data anywhere. Output contains tool names and counts,
  never tool-result content, so it is safe to paste into an issue.

## Error handling

- `verify.mjs`: if Chrome is not installed, fail with exit code 2 and the fix
  (`npx playwright install chromium`, then `channel: 'chromium'`). A check that times out reports
  the selector or condition it was waiting for. Console errors are printed even when every check
  passes.
- `bench/run.mjs`: before spending anything, verify the `claude` CLI exists, the fixture server
  started, and the Chrome extension is reachable; exit with a specific message otherwise.
- `analyze/session-cost.mjs`: skip and count malformed JSONL lines; report results with no
  matching call as `unknown` rather than guessing.

## Testing

All tests run with `node --test`, offline, spending no tokens.

- **Analyzer:** synthetic JSONL fixtures with known answers covering call/result pairing, image
  token estimates, carry-cost counting across turns, malformed lines and orphaned results.
- **Helper:** runs `verify.mjs` headless against the fixture app and asserts that each planted
  defect is detected and that correct behaviour passes.
- **Benchmark:** unit tests for the grader and the report's median/IQR maths.
- **Skill:** per superpowers:writing-skills, a baseline subagent run on one task without the skill,
  then with it, confirming the skill changes the approach (script instead of screenshots).

## Success criteria

- The plugin installs with `/plugin install` from the public repo and the skill triggers on a
  "check that this works on localhost" request.
- The test suite passes offline.
- A full benchmark run produces a results file and README table with both arms' medians, spread
  and accuracy.
- The analyzer's fitted estimates for this project's originating session have a median absolute
  per-turn error within 15% of recorded growth on held-out turns (5-fold), with context-reset
  turns excluded. (Changed 2026-09-17 from the summed holdout error, which an intercept term
  showed can be near zero while single turns are 50% off. Earlier, 2026-09-16, changed from an
  in-sample fixed-ratio comparison.) Status 2026-09-17: not met, 25.0%.

## Open questions

None blocking. The repository name `headless-verify` can change before first release.
