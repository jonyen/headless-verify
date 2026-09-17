import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { TASK_IDS, loadPrompt } from '../bench/tasks.mjs';
import { extractAnswer, grade } from '../bench/grade.mjs';
import { iqr, median, savedPct } from '../bench/stats.mjs';
import { parseStream } from '../bench/stream.mjs';
import { armArgs } from '../bench/arms.mjs';
import { schedule } from '../bench/schedule.mjs';

const fx = (name) => readFile(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');

test('prompts load for every task with the URL filled in', async () => {
  for (const id of TASK_IDS) {
    const p = await loadPrompt(id, 'http://127.0.0.1:9/s/3fa94c1e/');
    assert.match(p, /http:\/\/127\.0\.0\.1:9\/s\/3fa94c1e\//);
    assert.doesNotMatch(p, /\{URL\}|bug|broken|defect/i);
  }
});

test('extractAnswer takes the last JSON object with a boolean works', () => {
  const text = 'first {"works": true, "cause": "x"} then\n{"works": false, "cause": "y"}';
  assert.deepEqual(extractAnswer(text), { works: false, cause: 'y' });
  assert.equal(extractAnswer('no json here'), null);
  assert.equal(extractAnswer('{"works": "yes"}'), null);
  // Test with braces in the cause string
  const textWithBraces = 'Result:\n{"works": false, "cause": "handler reads obj.value where obj is {} and throws }"}';
  assert.deepEqual(extractAnswer(textWithBraces), { works: false, cause: 'handler reads obj.value where obj is {} and throws }' });
});

test('extractAnswer ignores unbalanced braces and quotes before the answer', () => {
  // Stray opening brace before answer
  assert.deepEqual(extractAnswer('use {x to fix. Then: \n{"works": true, "cause": "ok"}'), { works: true, cause: 'ok' });
  // Stray closing brace before answer
  assert.deepEqual(extractAnswer('oops } stray\n{"works": true, "cause": "ok"}'), { works: true, cause: 'ok' });
  // Unpaired quote before answer
  assert.deepEqual(extractAnswer('the button says "Save\n{"works": true, "cause": "ok"}'), { works: true, cause: 'ok' });
});

test('grade compares works against the variant', () => {
  assert.equal(grade({ works: true, cause: '' }, 'ok'), true);
  assert.equal(grade({ works: true, cause: '' }, 'bug'), false);
  assert.equal(grade(null, 'bug'), false);
});

test('median, IQR and savings', () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 3, 2]), 2.5);
  assert.deepEqual(iqr([1, 2, 3, 4, 5]), [2, 4]);
  assert.equal(savedPct(200, 50), 75);
  assert.equal(savedPct(0, 50), null);
  assert.equal(savedPct(NaN, 50), null);
  assert.equal(savedPct(Infinity, 50), null);
});

test('parseStream reads usage, cost, answer and screenshots', async () => {
  const h = parseStream(await fx('stream-headless.jsonl'));
  assert.deepEqual(h.usage, { input: 20, output: 900, cacheCreation: 14000, cacheRead: 30000 });
  assert.equal(h.costUsd, 0.21);
  assert.equal(h.turns, 3);
  assert.equal(h.screenshots, 0);
  assert.equal(h.isError, false);
  assert.deepEqual(extractAnswer(h.finalText), { works: false, cause: 'timeupdate listener is never attached' });

  const b = parseStream(await fx('stream-browser.jsonl'));
  assert.equal(b.screenshots, 2);
  assert.equal(b.isError, true);
  assert.equal(b.subtype, 'error_max_budget_usd');
});

test('arm arguments isolate the tools under test', () => {
  const common = { model: 'claude-opus-5', budgetUsd: 2, pluginDir: '/repo' };
  const browser = armArgs('browser', common);
  const headless = armArgs('headless', common);
  for (const args of [browser, headless]) {
    assert.ok(args.includes('-p'));
    assert.deepEqual(args.slice(args.indexOf('--output-format'), args.indexOf('--output-format') + 2), ['--output-format', 'stream-json']);
    assert.ok(args.includes('--verbose'));
    assert.ok(args.includes('--no-session-persistence'));
    assert.equal(args[args.indexOf('--max-budget-usd') + 1], '2');
    assert.equal(args[args.indexOf('--model') + 1], 'claude-opus-5');
    assert.equal(args.at(-1), '--');
    assert.ok(args.includes('--strict-mcp-config'));
    assert.equal(args[args.indexOf('--setting-sources') + 1], 'project');
    assert.ok(!args.includes('--disable-slash-commands'), 'would also disable the plugin skill');
  }
  const shared = (args) => args.slice(0, args.indexOf('--model') + 4);
  assert.deepEqual(shared(browser), shared(headless));
  assert.ok(browser.includes('--chrome'));
  assert.equal(browser[browser.indexOf('--disallowedTools') + 1], 'Bash');
  assert.ok(!browser.includes('--plugin-dir'));
  assert.ok(headless.includes('--no-chrome'));
  assert.equal(headless[headless.indexOf('--plugin-dir') + 1], '/repo');
});

test('schedule: equal ok/bug split, identical variants across arms, interleaved', () => {
  const s = schedule({ tasks: TASK_IDS, runs: 4, seed: 7 });
  assert.equal(s.length, TASK_IDS.length * 2 * 4);
  for (const task of TASK_IDS) {
    for (const arm of ['browser', 'headless']) {
      const mine = s.filter((r) => r.task === task && r.arm === arm);
      assert.equal(mine.filter((r) => r.variant === 'ok').length, 2);
    }
    const seq = (arm) => s.filter((r) => r.task === task && r.arm === arm).sort((a, b) => a.run - b.run).map((r) => r.variant);
    assert.deepEqual(seq('browser'), seq('headless'));
  }
  const firstTask = s.filter((r) => r.task === s[0].task).map((r) => r.arm);
  assert.deepEqual(firstTask.slice(0, 4), ['browser', 'headless', 'headless', 'browser']);
  assert.deepEqual(schedule({ tasks: TASK_IDS, runs: 4, seed: 7 }), s);
});

test('schedule: variants stay balanced across tasks for odd runs', () => {
  for (const seed of [1, 7, 42, 999, 12345]) {
    for (const runs of [1, 3, 5]) {
      const s = schedule({ tasks: TASK_IDS, runs, seed });
      for (const arm of ['browser', 'headless']) {
        const mine = s.filter((r) => r.arm === arm);
        const ok = mine.filter((r) => r.variant === 'ok').length;
        const bug = mine.length - ok;
        assert.ok(Math.abs(ok - bug) <= 1, `seed ${seed} runs ${runs} ${arm}: ${ok} ok / ${bug} bug`);
      }
      for (const task of TASK_IDS) {
        const seq = (arm) => s.filter((r) => r.task === task && r.arm === arm).sort((a, b) => a.run - b.run).map((r) => r.variant);
        assert.deepEqual(seq('browser'), seq('headless'));
        const ok = seq('browser').filter((v) => v === 'ok').length;
        assert.ok(Math.abs(ok - (runs - ok)) <= 1);
      }
      assert.deepEqual(schedule({ tasks: TASK_IDS, runs, seed }), s);
    }
    for (const runs of [2, 4, 6]) {
      const s = schedule({ tasks: TASK_IDS, runs, seed });
      for (const task of TASK_IDS) {
        assert.equal(s.filter((r) => r.task === task && r.arm === 'browser' && r.variant === 'ok').length, runs / 2);
      }
    }
  }
  const one = schedule({ tasks: TASK_IDS, runs: 1, seed: 3 }).filter((r) => r.arm === 'browser');
  assert.ok([2, 3].includes(one.filter((r) => r.variant === 'ok').length));
});
