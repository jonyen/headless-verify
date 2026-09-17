# Validation against the spec's success criteria

## Update 2026-09-16: fitted chars/token ratios with held-out validation

The analyzer no longer relies only on a fixed 4 chars/token. Per session it fits two ratios
(tool-result text and `context:user` text) from the transcript's own recorded context growth and
validates them on held-out turns (`analyze/fit.mjs`):

- Observation per turn k ≥ 1 with arriving content: recorded growth
  (context(k) − context(k−1) − output(k−1)), tool-result chars, `context:user` chars, and image
  tokens from pixels (held fixed).
- Model `recorded ≈ toolChars / toolRatio + contextChars / contextRatio + imageTokens`, least
  squares on the 2×2 normal equations. A class with fewer than 5 non-zero observations, or a
  non-positive coefficient, is held at 4 chars/token and the other class is refit alone. Turns with
  recorded growth ≤ 0 (compaction, cache anomalies) are dropped and counted.
- 5-fold holdout, folds by turn index mod 5: fit on four folds, predict the fifth. **Holdout
  error** = |Σ predicted − Σ recorded| / Σ recorded over all held-out turns; the median absolute
  per-turn percentage error is reported too.
- Fewer than 20 usable observations, or no fittable class: `method: fixed`, 4 chars/token.
- `--fixed` forces the old behaviour; the fixed-ratio calibration line is still printed for
  comparison. `npm test`: 65/65 pass (9 new tests in `test/analyze-fit.test.mjs`).

The spec's 15% criterion now applies to the holdout error.

### Originating session

```
node analyze/session-cost.mjs ~/.claude/projects/<project>/<session>.jsonl
```

(Live, growing transcript; numbers are from the single run quoted.)

| | value |
| --- | --- |
| method | fitted |
| tool-result chars/token | 2.35 |
| `context:user` chars/token | 2.65 |
| holdout error | **22.0%** |
| median per-turn error | 23.7% |
| observations / dropped | 274 / 0 |
| fixed-ratio calibration (for comparison) | estimated 121,645 vs recorded 243,174, 50.0% off; implied 1.52 chars/token on tool-result-only turns |

**The 15% criterion is not met on this session** (22.0% holdout error). Fitting cuts the error
from 50.0% to 22.0%, but a two-ratio model of characters cannot explain the rest. Most turns are
small: 226 of the 274 observations bring under 2,000 characters, and on those turns recorded growth
averages 504 tokens while the fitted model leaves an average of +231 tokens unexplained. That
residual does not track the previous turn's output tokens (correlation −0.03). The likeliest
explanation is a per-turn overhead that has no characters in the transcript: message and
tool-result framing, and content the harness adds to the request without logging it. Least
squares is dominated by the few large turns, so the fitted ratios (2.35 / 2.65) come out higher
than the 1.52 implied by tool-result-only turns, and the small turns are under-predicted. Nothing
was tuned to pass. Adding an intercept (per-turn overhead) term would be a model change and needs
its own design review; it is not part of this change.

### All sessions since 2026-09-01 (aggregate only)

```
node analyze/session-cost.mjs --all --since 2026-09-01
```

| | value |
| --- | --- |
| sessions | 40 (25 fitted: 18 both classes, 7 tool only with context held at 4; 15 fixed, all for fewer than 20 usable observations) |
| observations / dropped | 5,818 / 30 |
| median ratio over fitted sessions, tool / context | 2.22 / 2.64 chars/token (context median includes the 7 sessions held at 4) |
| pooled holdout error (fitted sessions) | 14.3% |
| median per-session holdout error | 18.5% |
| median per-session median per-turn error | 26.3% |
| fitted sessions with holdout error ≤ 15% | 12 of 25 |
| fixed-ratio calibration (for comparison) | estimated 2,096,729 vs recorded 3,079,349, 31.9% off |

Pooled across sessions the holdout error is just under 15%, but that pooling lets errors in
opposite directions cancel. Fewer than half of fitted sessions (12 of 25) meet 15% on their own, so
this does not show the criterion is met per session.

## History: fixed 4 chars/token validation (before the update above)

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
