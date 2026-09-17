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

Five tasks against a bundled fixture app, each with a working and a broken version of each
widget, served at URLs that don't reveal which. Every run is a fresh `claude -p` session. The
*browser* arm has claude-in-chrome and no Bash; the *headless* arm has Bash and this plugin and
no claude-in-chrome. Runs are interleaved, capped with `--max-budget-usd`, and failures count
against their arm. See
[the design spec](docs/superpowers/specs/2026-09-16-headless-verify-design.md) for the method.

## Develop

```sh
npm test    # offline, spends no tokens
```

MIT © Jonathan Yen
