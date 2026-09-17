import { test } from 'node:test';
import assert from 'node:assert/strict';
import { estimateResumeCost, itemsToRun, mergeRecords, resolveResumeSettings, resumeConsent } from '../bench/resume.mjs';

const item = (task, arm, variant, run) => ({ task, arm, variant, run });
const record = (task, arm, variant, run, subtype, extra = {}) => ({ task, arm, variant, run, subtype, costUsd: 0.1, ...extra });

test('itemsToRun includes plan items with no matching record', () => {
  const plan = [item('load', 'browser', 'ok', 0), item('load', 'headless', 'ok', 0)];
  const records = [record('load', 'browser', 'ok', 0, 'success')];
  const toRun = itemsToRun(plan, records);
  assert.deepEqual(toRun, [item('load', 'headless', 'ok', 0)]);
});

test('itemsToRun includes rate_limited, no_result and timeout records but not success', () => {
  const plan = [
    item('load', 'browser', 'ok', 0),
    item('load', 'browser', 'bug', 1),
    item('preview', 'headless', 'ok', 0),
    item('preview', 'headless', 'bug', 1),
  ];
  const records = [
    record('load', 'browser', 'ok', 0, 'rate_limited'),
    record('load', 'browser', 'bug', 1, 'no_result'),
    record('preview', 'headless', 'ok', 0, 'timeout'),
    record('preview', 'headless', 'bug', 1, 'success'),
  ];
  const toRun = itemsToRun(plan, records);
  assert.deepEqual(toRun, plan.slice(0, 3));
});

test('itemsToRun includes a legacy record never tagged rate_limited (subtype success, isError zero-cost one-turn limit text)', () => {
  const plan = [item('preview', 'browser', 'bug', 3), item('preview', 'headless', 'bug', 3)];
  const legacy = {
    task: 'preview', arm: 'browser', variant: 'bug', run: 3,
    subtype: 'success', isError: true, costUsd: 0, turns: 1,
    finalText: "You've hit your session limit · resets 11:30pm (America/New_York)",
  };
  const records = [legacy, record('preview', 'headless', 'bug', 3, 'success')];
  const toRun = itemsToRun(plan, records);
  assert.deepEqual(toRun, [item('preview', 'browser', 'bug', 3)]);
});

test('itemsToRun preserves plan order', () => {
  const plan = [item('a', 'browser', 'ok', 0), item('b', 'browser', 'ok', 0), item('c', 'browser', 'ok', 0)];
  const records = [];
  assert.deepEqual(itemsToRun(plan, records), plan);
});

test('mergeRecords replaces matching records and keeps the rest', () => {
  const records = [
    record('load', 'browser', 'ok', 0, 'success', { costUsd: 0.5 }),
    record('load', 'headless', 'ok', 0, 'rate_limited', { costUsd: 0 }),
  ];
  const fresh = [record('load', 'headless', 'ok', 0, 'success', { costUsd: 0.2 })];
  const merged = mergeRecords(records, fresh);
  assert.equal(merged.length, 2);
  assert.equal(merged[0].subtype, 'success');
  assert.equal(merged[0].costUsd, 0.5);
  assert.equal(merged[1].subtype, 'success');
  assert.equal(merged[1].costUsd, 0.2);
});

test('mergeRecords appends new records that have no match in the old set', () => {
  const records = [record('load', 'browser', 'ok', 0, 'success')];
  const fresh = [record('preview', 'browser', 'ok', 0, 'success')];
  const merged = mergeRecords(records, fresh);
  assert.equal(merged.length, 2);
  assert.deepEqual(merged[1], fresh[0]);
});

test('mergeRecords is order-preserving for unmatched records', () => {
  const records = [
    record('a', 'browser', 'ok', 0, 'success'),
    record('b', 'browser', 'ok', 0, 'rate_limited'),
    record('c', 'browser', 'ok', 0, 'success'),
  ];
  const fresh = [record('b', 'browser', 'ok', 0, 'success')];
  const merged = mergeRecords(records, fresh);
  assert.deepEqual(merged.map((r) => r.task), ['a', 'b', 'c']);
  assert.equal(merged[1].subtype, 'success');
});

test('estimateResumeCost multiplies the median cost of existing records by the item count', () => {
  const records = [record('a', 'b', 'ok', 0, 'success', { costUsd: 0.1 }), record('a', 'b', 'ok', 1, 'success', { costUsd: 0.3 })];
  assert.equal(estimateResumeCost(records, 4), 0.8); // median 0.2 * 4
});

test('estimateResumeCost ignores zero-cost (rate-limited) records and returns 0 with no usable costs', () => {
  const records = [record('a', 'b', 'ok', 0, 'rate_limited', { costUsd: 0 })];
  assert.equal(estimateResumeCost(records, 3), 0);
});

test('resumeConsent describes the preflight cap and per-run cap, not calibration', () => {
  const msg = resumeConsent({ itemsCount: 4, budgetUsd: 2, preflightBudgetUsd: 0.5, estimateUsd: 0.8 });
  assert.match(msg, /\$0\.50/); // preflight cap
  assert.match(msg, /4/);
  assert.match(msg, /\$2\.00 each/);
  assert.match(msg, /\$0\.80/); // estimate from existing median cost
  assert.doesNotMatch(msg, /calibration/i);
});

test('resumeConsent pluralizes a single run correctly', () => {
  const msg = resumeConsent({ itemsCount: 1, budgetUsd: 2, preflightBudgetUsd: 0.5, estimateUsd: 2 });
  assert.match(msg, /1 blocked run\b/);
});

const meta = { model: 'claude-opus-5', budgetUsd: 2, timeoutMin: 10 };

test('resolveResumeSettings uses the results file settings when nothing is overridden', () => {
  assert.deepEqual(resolveResumeSettings(meta, {}), { model: 'claude-opus-5', budgetUsd: 2, timeoutMin: 10 });
});

test('resolveResumeSettings accepts an override that matches the file', () => {
  assert.deepEqual(resolveResumeSettings(meta, { model: 'claude-opus-5' }), { model: 'claude-opus-5', budgetUsd: 2, timeoutMin: 10 });
});

test('resolveResumeSettings refuses a conflicting --model override', () => {
  assert.throws(() => resolveResumeSettings(meta, { model: 'claude-sonnet-5' }), /--model claude-sonnet-5.*claude-opus-5|claude-opus-5.*claude-sonnet-5/s);
});

test('resolveResumeSettings refuses a conflicting --budget override', () => {
  assert.throws(() => resolveResumeSettings(meta, { budgetUsd: 5 }), /--budget|budget/i);
});

test('resolveResumeSettings refuses a conflicting --timeout-min override', () => {
  assert.throws(() => resolveResumeSettings(meta, { timeoutMin: 3 }), /--timeout-min|timeout/i);
});
