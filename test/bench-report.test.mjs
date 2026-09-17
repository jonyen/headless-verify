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
