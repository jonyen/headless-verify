import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readmeResultsBlock, renderTable, summarize, summaryPathFor } from '../bench/summarize.mjs';

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
  const table = renderTable(summarize(records), { model: 'claude-opus-5', runs: 2, date: '2026-09-16' }, '2026-09-16-120000-claude-opus-5.summary.json');
  assert.match(table, /\| load \|/);
  assert.match(table, /\| \*\*overall\*\* \|/);
  assert.match(table, /100% → 50%/);
  assert.match(table, /77\.3%/);
});

const extra = [
  ...records,
  { ...rec('load', 'browser', 900_000, 9.0, false), isError: true, subtype: 'no_result' },
  { ...rec('load', 'headless', 900_000, 9.0, false), isError: true, subtype: 'timeout', leakSuspect: true },
  { ...rec('load', 'headless', 40_000, 0.4, false), isError: true, subtype: 'error_max_budget_usd' },
];

test('summarize counts n, failures and leak suspects; no_result/timeout stay out of medians', () => {
  const s = summarize(extra);
  const { browser, headless } = s.byTask.load;
  assert.equal(browser.n, 3);
  assert.equal(browser.failures, 1);
  assert.equal(browser.leakSuspect, 0);
  assert.equal(browser.tokens.median, 110_000);
  assert.equal(browser.accuracy, 2 / 3);
  assert.equal(headless.n, 4);
  assert.equal(headless.failures, 2);
  assert.equal(headless.leakSuspect, 1);
  // budget-capped run still has real usage and stays in the medians; timeout does not.
  assert.equal(headless.tokens.median, 30_000);
  assert.equal(headless.accuracy, 1 / 4);
  assert.equal(s.overall.headless.leakSuspect, 1);
});

test('renderTable shows n, failures, leak suspects and names the summary file', () => {
  const table = renderTable(summarize(extra), { model: 'm', runs: 2, date: 'd' }, 'x.summary.json');
  assert.match(table, /IQR in `x\.summary\.json`/);
  assert.match(table, /\| n \|/);
  assert.match(table, /\| load \| 3 → 4 \| 1 → 2 \|/);
  assert.match(table, /[Ll]eak-suspect runs: browser 0, headless 1/);
});

test('savings render n/a when the browser median is zero', () => {
  const zero = [
    { ...rec('load', 'browser', 0, 0, true), durationMs: 0 },
    rec('load', 'headless', 10, 0.1, true),
  ];
  const s = summarize(zero);
  assert.equal(s.overall.savedTokensPct, null);
  assert.match(renderTable(s, { model: 'm', runs: 1, date: 'd' }, 'x.summary.json'), /n\/a/);
});

test('summary path sits next to the results file; README link is repo-relative', () => {
  assert.equal(summaryPathFor('/r/results/2026-09-16-101500-m.json'), '/r/results/2026-09-16-101500-m.summary.json');
  const block = readmeResultsBlock('TABLE', '/repo/results/a.json', '/repo');
  assert.match(block, /Raw data: \[`results\/a\.json`\]\(results\/a\.json\)/);
  assert.doesNotMatch(block, /\/repo/);
});

test('report.mjs writes <results>.summary.json with the summarize() output', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hv-report-test-'));
  try {
    const file = join(dir, '2026-09-16-101500-m.json');
    await writeFile(file, JSON.stringify({ meta: { model: 'm', runs: 2, date: 'd' }, records }));
    const script = fileURLToPath(new URL('../bench/report.mjs', import.meta.url));
    const out = execFileSync(process.execPath, [script, file], { encoding: 'utf8' });
    assert.match(out, /IQR in `2026-09-16-101500-m\.summary\.json`/);
    const written = JSON.parse(await readFile(join(dir, '2026-09-16-101500-m.summary.json'), 'utf8'));
    assert.deepEqual(written, JSON.parse(JSON.stringify(summarize(records))));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
