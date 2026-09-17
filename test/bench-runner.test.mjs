import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runProcess, runRecord, preflightConsent, resultsFileName, PREFLIGHT_BUDGET_USD } from '../bench/runner.mjs';

const node = process.execPath;
const resultLine = JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'done {"works": false}', total_cost_usd: 0.1, usage: {} });

test('runProcess returns output of a child that finishes in time', async () => {
  const r = await runProcess(node, ['-e', `console.log(${JSON.stringify(resultLine)})`], { timeoutMs: 10_000 });
  assert.equal(r.timedOut, false);
  assert.match(r.stdout, /"type":"result"/);
});

test('runProcess kills a child that exceeds the timeout', async () => {
  const started = Date.now();
  const r = await runProcess(node, ['-e', 'process.stderr.write("working\\n"); setInterval(() => {}, 1000)'], { timeoutMs: 300 });
  assert.equal(r.timedOut, true);
  assert.ok(Date.now() - started < 8_000);
  assert.match(r.stderr, /working/);
});

test('runProcess escalates to SIGKILL when SIGTERM is ignored', async () => {
  const r = await runProcess(node, ['-e', 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)'], { timeoutMs: 200, killGraceMs: 200 });
  assert.equal(r.timedOut, true);
});

test('runRecord marks timeouts as errors with the stderr tail', () => {
  const item = { task: 'load', arm: 'headless', variant: 'bug', run: 0 };
  const timedOut = runRecord(item, { stdout: resultLine, stderr: 'x'.repeat(3000) + 'END', timedOut: true });
  assert.equal(timedOut.isError, true);
  assert.equal(timedOut.subtype, 'timeout');
  assert.equal(timedOut.answer, null);
  assert.equal(timedOut.correct, false);
  assert.equal(timedOut.stderrTail.length, 2000);
  assert.ok(timedOut.stderrTail.endsWith('END'));

  const ok = runRecord(item, { stdout: resultLine, stderr: '', timedOut: false });
  assert.equal(ok.isError, false);
  assert.equal(ok.correct, true);
  assert.equal(ok.stderrTail, undefined);
});

test('first consent message states preflight cap plus two calibration caps', () => {
  assert.equal(PREFLIGHT_BUDGET_USD, 0.5);
  const msg = preflightConsent(2);
  assert.match(msg, /\$4\.50/);
  assert.match(msg, /\$0\.50/);
  assert.match(msg, /\$2\.00 each/);
});

test('results file name includes the time of day', () => {
  assert.equal(resultsFileName(new Date('2026-09-16T08:05:09Z'), 'claude-opus-5'), '2026-09-16-080509-claude-opus-5.json');
});
