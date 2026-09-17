# headless-verify

A Claude Code plugin that makes Claude check local web apps with short headless scripts that
print a few lines of text, instead of step-by-step browser automation with screenshots. It
includes a benchmark and a session analyzer that measure how many tokens that saves.

## Install

For local development, or until this repo publishes a marketplace manifest (see below), run it
straight from a checkout:

```sh
git clone https://github.com/jonyen/headless-verify
claude --plugin-dir headless-verify -p "check that this works on localhost"
```

`claude plugin install <plugin>` only installs from a marketplace you've already added
(`plugin` or `plugin@marketplace`) — it does not take a bare GitHub URL. Installing straight
from this repo would first need `claude plugin marketplace add https://github.com/jonyen/headless-verify`,
which in turn needs a `.claude-plugin/marketplace.json` here; this repo does not ship one yet, so
that two-step marketplace install does not currently work. `--plugin-dir` is the verified path
(see `docs/validation.md`).

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
node analyze/session-cost.mjs --all --since 2026-09-01   # add --fixed for 4 chars/token
```

Reports calls, images, direct tokens and carry tokens (results re-read on later turns) per tool
family, plus a calibration line comparing its estimates with the usage recorded in the
transcript. It reads local files only and never prints tool-result content.

Token estimates come from a per-session fit to the transcript's own recorded usage: separate
chars/token ratios for tool-result text and other context text, plus a fixed per-turn overhead.
The overhead is reported as its own row, not charged to any tool. The fit is checked on held-out
turns with 5-fold cross-validation. Sessions with fewer than 20 usable turns fall back to a fixed
4 chars/token with no overhead; `--fixed` forces that. The summed holdout error is low (0.2% on the
originating session), but that is largely a side effect of the overhead term: the median turn is
still predicted about 50% off, and in some sessions the fitted overhead is implausibly large. Treat
per-family numbers as rough; see [docs/validation.md](docs/validation.md).

## Run the benchmark

```sh
npm install
node bench/run.mjs --runs 5        # asks before spending; --runs 1 for a cheap trial
node bench/report.mjs results/<date>-<time>-<model>.json --readme
```

Five tasks against a bundled fixture app, each with a working and a broken version of each
widget, served at URLs that don't reveal which. Every run is a fresh `claude -p` session. The
*browser* arm has claude-in-chrome and no Bash; the *headless* arm has Bash and this plugin and
no claude-in-chrome. Both arms run with `--permission-mode bypassPermissions` (needed for
unattended runs) inside a throwaway temp working directory, with only project setting sources and
`--strict-mcp-config`. The headless arm loads a staged, plugin-only copy of this repo from a temp
directory, so it cannot browse the benchmark's own sources; runs whose tool inputs mention them
anyway are counted as leak suspects in the results. Both arms can still read the served page's
source, so part of any saving may come from reading code rather than running it. Runs are
interleaved, capped with `--max-budget-usd` and a wall-clock `--timeout-min` (default 10), and
failures and timeouts count against their arm. `report.mjs` writes per-arm IQRs next to the
results file as `<file>.summary.json`. See
[the design spec](docs/superpowers/specs/2026-09-16-headless-verify-design.md) for the method.

## Develop

```sh
npm test    # offline, spends no tokens
```

MIT © Jonathan Yen
