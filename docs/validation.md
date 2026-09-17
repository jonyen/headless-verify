# Validation against the spec's success criteria

Scope: Task 9, Part A (Steps 1-3 only — offline validation). Steps 4-6 (trial benchmark, full
benchmark, push) are out of scope for this pass and were not run.

## Step 1: Offline suite

```
npm test
```

Result: **PASS** — 39/39 tests (`node --test test/*.test.mjs`), including new tests added in this
pass (see Step 2).

## Step 2: Analyzer calibration on the originating session

Command:

```
node analyze/session-cost.mjs ~/.claude/projects/<project>/<session>.jsonl
```

### Cause of the gap

An earlier run on a different transcript was 43.7% off; before any fix, this session's calibration
was **62.1% off** (worse — this session is more tool/CLI-output heavy). Investigated by comparing,
per turn, recorded context growth (`cache_creation + cache_read + input` this turn, minus the
previous turn's `output`) against (a) tool-result content and (b) everything else that arrives in a
`user` entry, using a throwaway script over `parseTranscript`'s output plus the raw JSONL (never
printing any transcript text — only chars/tokens were computed and logged).

One cause was fixed; a second was found but is **not** fixed by changing the chars-per-token
constant, per ruling R10 — the spec fixes that approximation at 4 chars/token, and a constant
chosen to clear this session's error would be fitting to the validation target, not evidence of a
generally correct ratio (the earlier grid search was non-monotonic across divisors, which itself
shows a single global constant doesn't explain the gap).

1. **Fixed: missed non-tool-result content.** 46-48 `user`-entry text blocks in this session are
   not tool results — mostly `isMeta: true` injected content (environment/system reminders,
   deferred-tool listings, skill listings) plus a handful of plain typed turns. This totals roughly
   40,000-160,000 chars across runs (the session is live and growing) that the old calibration
   silently dropped. This content still becomes context for later turns, so it is now counted as
   its own `context:user` family bucket; its raw text is never printed or stored, only its
   character count.

2. **Found, not "fixed": tool output tokenizes denser than the spec's 4 chars/token.**
   Restricting calibration to turns whose new content is *only* tool results (no `context:user`
   content, no images) and solving for the implied ratio gives **~1.5 chars/token** on this
   session, not ~4. That mix is dominated by `Bash` output: CLI stdout, file paths, JSON, table
   borders and other punctuation/whitespace-heavy text tokenizes far less efficiently than English
   prose. This is now reported as a separate, informational `impliedCharsPerToken` figure (see
   below) computed independently from the estimate — it never rescales `estimated` or `errorPct`.

### Changes made (TDD)

- `test/analyze-transcript.test.mjs`: two tests (unchanged from the first pass, kept per R10) —
  non-tool-result text in a `user` entry becomes a `context:user`-family pseudo-result attributed
  to the turn it arrives after; such content before any completed turn is dropped, not attributed
  to a negative turn.
- `analyze/transcript.mjs`: `parseTranscript` emits that `context:user` entry (name and char count
  only — `toolFamily('context:user')` passes it through unchanged).
- `analyze/cost.mjs`: `CHARS_PER_TOKEN` **reverted to 4** (the first pass had changed it to 2; R10
  rejected that as fitting the validation target rather than following the spec's fixed
  approximation). `resultTokens`'s pinned test and the two fixture-dependent tests were restored to
  their original expected numbers.
- `test/analyze-cost.test.mjs`: added two new failing-first tests for `impliedCharsPerToken` —
  one with a synthetic multi-turn fixture verifying that a turn whose arriving content mixes a tool
  result with `context:user` content is excluded from both the numerator and denominator, and one
  verifying `null` ("n/a") when no turn qualifies. Both were confirmed RED (asserting against the
  not-yet-implemented field) before implementing.
- `analyze/cost.mjs`: `costBreakdown`'s calibration now also reports `impliedCharsPerToken`
  (`impliedTextChars / impliedDenominator`, or `null`), computed only over turns whose entire
  arriving content is tool results, with the denominator being that turn's recorded growth minus
  its tool results' image-token estimate. This is purely observational and is never used to compute
  `estimated`.
- `analyze/session-cost.mjs`: prints the implied figure next to the calibration line in both the
  markdown and `--json` output (`"n/a"` in markdown when `null`).

`npm test`: **39/39 pass** (35 pre-existing + the 2 `context:user` transcript tests + 2 new
`impliedCharsPerToken` tests).

### Family table for this session (tool families, counts and token columns only)

| tool family | calls | images | direct tokens | carry tokens |
| --- | --- | --- | --- | --- |
| Bash | 140 | 0 | 42,233 | 7,848,201 |
| context:user | 48 | 0 | 42,552 | 2,603,287 |
| claude-in-chrome | 36 | 21 | 14,601 | 2,223,367 |
| Agent | 24 | 0 | 6,336 | 302,808 |
| Read | 2 | 2 | 1,032 | 185,775 |
| Write | 11 | 0 | 455 | 82,941 |
| TaskStop | 3 | 0 | 336 | 59,472 |
| AskUserQuestion | 3 | 0 | 134 | 22,226 |
| Edit | 1 | 0 | 41 | 8,651 |
| SendMessage | 6 | 0 | 246 | 6,314 |
| Skill | 3 | 0 | 36 | 3,731 |
| ToolSearch | 5 | 0 | 0 | 0 |

### Calibration (with `context:user` counted at 4 chars/token)

- Estimated 108,002 vs recorded 217,815 tokens of new context — **50.4% off**.
- Implied chars/token (tool-result-only turns): **1.53**.
- **Does not meet the spec's ≤15% criterion.**

The remaining gap is likely explained by cause 2 above: tool/CLI output (this session is dominated by
`Bash`) tokenizes at roughly 1.5 chars/token, not the 4 chars/token the spec's approximation uses,
so the estimate under-counts by close to half. Per R10 this is reported honestly rather than
papered over with a fitted constant; fixing it for real would need either a per-family ratio backed
by evidence from many sessions (not one), or a tokenizer-based estimate instead of a chars-per-token
approximation — both out of scope for this validation pass.

Note: this transcript is the live, growing session running this task, so absolute totals differ
between runs; the numbers above are from the single run quoted.

## Step 3: Plugin install smoke test

Command (single attempt, hard-capped):

```
claude --plugin-dir . -p --model haiku --max-budget-usd 0.10 --no-session-persistence \
  "What skills do you have for checking a web app on localhost? Name them only."
```

Output (skill names only):

```
- `run`
- `headless-verify:verifying-web-apps-headlessly`
- `webapp-testing`
```

The plugin's skill loaded and is listed under the correct name
(`headless-verify:verifying-web-apps-headlessly`). This probe only asked Claude to name its skills;
it did not show the skill **triggering** on a real verification request, so the spec's triggering
criterion is **not yet verified**. The benchmark's headless-arm runs will show whether it triggers.

Cost: capped at `--max-budget-usd 0.10`; with `--model haiku` and
a two-sentence prompt the actual spend is a small fraction of that cap (no separate cost line was
printed by this invocation, and per the "one attempt" instruction the command was not re-run with
different flags to extract an exact figure).

### Install command check against the installed CLI

Checked `claude plugin --help`, `claude plugin install --help`, `claude plugin marketplace --help`
and `claude plugin marketplace add --help` on the installed CLI (no plugin was actually installed
into global config; the local-path `marketplace add --scope local` dry run in a scratch directory
was blocked by the auto-mode classifier as an "Unauthorized Persistence" action before it ran, so
verification stopped at reading `--help` text, per the "don't retry repeatedly" instruction).

Findings:

- `claude plugin install <plugin>` installs **from an already-configured marketplace** only
  (`plugin` or `plugin@marketplace`). It does not accept a bare GitHub URL — the README's old
  `claude plugin install https://github.com/jonyen/headless-verify` does not match this signature.
- Getting a plugin from a git repo requires `claude plugin marketplace add <url|path|github-repo>`
  first, and that source must itself contain a marketplace manifest
  (`.claude-plugin/marketplace.json`) listing the plugin(s) to install.
- This repo has `.claude-plugin/plugin.json` but **no `.claude-plugin/marketplace.json`**, so even
  the correct two-step marketplace flow (`marketplace add` then `install
  headless-verify@headless-verify`) would not currently work against this repo. Adding that
  manifest is a code change out of scope for this validation-only task.
- The one flow that is actually usable today, and the one this validation exercised, is local
  development via `claude --plugin-dir <path-to-checkout>`.

README.md's Install section was corrected to document the `--plugin-dir` flow as the verified way
to run the plugin today, and to explain why the marketplace-based one-liner does not currently work
against the installed CLI.
