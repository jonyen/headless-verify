import { basename, relative, resolve, sep } from 'node:path';
import { iqr, median, savedPct } from './stats.mjs';
import { isRateLimited } from './stream.mjs';

const totalTokens = (r) => r.usage.input + r.usage.output + r.usage.cacheCreation + r.usage.cacheRead;

// Runs that never produced a result (no result event, or killed by the
// per-run timeout) carry no meaningful usage: they count in n, failures and
// accuracy, but not in the token/cost/duration medians.
const NO_USAGE = new Set(['no_result', 'timeout']);

// Records written by a fixed run.mjs already carry subtype 'rate_limited'.
// Results files written before that fix don't, so fall back to re-deriving
// it from the record's own finalText/isError/costUsd/turns.
const wasRateLimited = (r) => r.subtype === 'rate_limited' || isRateLimited(r.finalText, { isError: r.isError, costUsd: r.costUsd, turns: r.turns });

// Runs blocked by the account's usage/rate limit are infrastructure failures,
// not model failures: they never ran the task at all. They're excluded from
// n, accuracy, correct and every resource median, and counted separately.
function armStats(records) {
  const graded = records.filter((r) => !wasRateLimited(r));
  const rateLimited = records.length - graded.length;
  const measured = graded.filter((r) => !NO_USAGE.has(r.subtype));
  const tokens = measured.map(totalTokens);
  const cost = measured.map((r) => r.costUsd);
  const duration = measured.map((r) => r.durationMs / 1000);
  const correct = graded.filter((r) => r.correct).length;
  return {
    n: graded.length,
    rateLimited,
    failures: graded.filter((r) => r.isError).length,
    leakSuspect: graded.filter((r) => r.leakSuspect).length,
    correct,
    accuracy: graded.length ? correct / graded.length : 0,
    tokens: { median: median(tokens), iqr: iqr(tokens) },
    costUsd: { median: median(cost), iqr: iqr(cost) },
    durationS: { median: median(duration), iqr: iqr(duration) },
    screenshots: { median: median(measured.map((r) => r.screenshots)) },
  };
}

function pair(records) {
  const browser = armStats(records.filter((r) => r.arm === 'browser'));
  const headless = armStats(records.filter((r) => r.arm === 'headless'));
  return {
    browser,
    headless,
    savedTokensPct: savedPct(browser.tokens.median, headless.tokens.median),
    savedCostPct: savedPct(browser.costUsd.median, headless.costUsd.median),
    savedDurationPct: savedPct(browser.durationS.median, headless.durationS.median),
  };
}

export function summarize(records) {
  const tasks = [...new Set(records.map((r) => r.task))];
  return {
    overall: pair(records),
    byTask: Object.fromEntries(tasks.map((t) => [t, pair(records.filter((r) => r.task === t))])),
  };
}

const finite = (fn) => (n) => (n == null || !Number.isFinite(n) ? 'n/a' : fn(n));
const k = finite((n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(Math.round(n))));
const usd = finite((n) => `$${n.toFixed(2)}`);
const pct = finite((n) => `${n.toFixed(1)}%`);
const secs = finite((n) => `${Math.round(n)}s`);
const num = finite((n) => String(n));
const acc = (a) => `${Math.round(a * 100)}%`;

export function renderTable(summary, meta, summaryFile) {
  const { browser, headless } = summary.overall;
  const lines = [
    `Model \`${meta.model}\`, ${meta.runs} runs per task per arm, ${meta.date}. Medians (runs with no result or timed out excluded); ` +
      `rate-limited runs (blocked by the account's usage limit) excluded from n and accuracy; IQR in \`${summaryFile}\`.`,
    '',
    '| task | n | rate-limited | failed | tokens (browser → headless) | saved | cost | saved | time | screenshots | accuracy |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
  ];
  const row = (name, p) =>
    `| ${name} | ${p.browser.n} → ${p.headless.n} | ${p.browser.rateLimited} → ${p.headless.rateLimited} | ` +
    `${p.browser.failures} → ${p.headless.failures} | ` +
    `${k(p.browser.tokens.median)} → ${k(p.headless.tokens.median)} | ${pct(p.savedTokensPct)} | ` +
    `${usd(p.browser.costUsd.median)} → ${usd(p.headless.costUsd.median)} | ${pct(p.savedCostPct)} | ` +
    `${secs(p.browser.durationS.median)} → ${secs(p.headless.durationS.median)} | ` +
    `${num(p.browser.screenshots.median)} → ${num(p.headless.screenshots.median)} | ` +
    `${acc(p.browser.accuracy)} → ${acc(p.headless.accuracy)} |`;
  for (const [task, p] of Object.entries(summary.byTask)) lines.push(row(task, p));
  lines.push(row('**overall**', summary.overall));
  lines.push(
    '',
    `Leak-suspect runs: browser ${browser.leakSuspect}, headless ${headless.leakSuspect} (a tool input mentioned the benchmark's own files).`,
  );
  return lines.join('\n');
}

export const summaryPathFor = (resultsPath) => resultsPath.replace(/\.json$/, '') + '.summary.json';

export function readmeResultsBlock(table, resultsPath, repoRoot) {
  const rel = relative(repoRoot, resolve(resultsPath)).split(sep).join('/');
  return `${table}\n\nRaw data: [\`${rel}\`](${rel}) · summary with IQR: [\`${basename(summaryPathFor(rel))}\`](${summaryPathFor(rel)})`;
}
