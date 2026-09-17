import { test } from 'node:test';
import assert from 'node:assert/strict';
import { estimateResumeCost, itemsToRun, mergeRecords, resumeConsent } from '../bench/resume.mjs';

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

test('resumeConsent names the item count and the estimate', () => {
  const msg = resumeConsent(1.23, 4);
  assert.match(msg, /4 blocked runs/);
  assert.match(msg, /\$1\.23/);
  assert.match(resumeConsent(0.5, 1), /1 blocked run\b/);
});
