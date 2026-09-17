import { iqr, median, savedPct } from './stats.mjs';

const totalTokens = (r) => r.usage.input + r.usage.output + r.usage.cacheCreation + r.usage.cacheRead;

function armStats(records) {
  const tokens = records.map(totalTokens);
  const cost = records.map((r) => r.costUsd);
  const duration = records.map((r) => r.durationMs / 1000);
  const correct = records.filter((r) => r.correct).length;
  return {
    n: records.length,
    correct,
    accuracy: records.length ? correct / records.length : 0,
    tokens: { median: median(tokens), iqr: iqr(tokens) },
    costUsd: { median: median(cost), iqr: iqr(cost) },
    durationS: { median: median(duration), iqr: iqr(duration) },
    screenshots: { median: median(records.map((r) => r.screenshots)) },
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

const k = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(Math.round(n)));
const usd = (n) => `$${n.toFixed(2)}`;
const pct = (n) => `${n.toFixed(1)}%`;
const acc = (a) => `${Math.round(a * 100)}%`;

export function renderTable(summary, meta) {
  const lines = [
    `Model \`${meta.model}\`, ${meta.runs} runs per task per arm, ${meta.date}. Medians; IQR in the results file.`,
    '',
    '| task | tokens (browser → headless) | saved | cost | saved | time | screenshots | accuracy |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
  ];
  const row = (name, p) =>
    `| ${name} | ${k(p.browser.tokens.median)} → ${k(p.headless.tokens.median)} | ${pct(p.savedTokensPct)} | ` +
    `${usd(p.browser.costUsd.median)} → ${usd(p.headless.costUsd.median)} | ${pct(p.savedCostPct)} | ` +
    `${Math.round(p.browser.durationS.median)}s → ${Math.round(p.headless.durationS.median)}s | ` +
    `${p.browser.screenshots.median} → ${p.headless.screenshots.median} | ` +
    `${acc(p.browser.accuracy)} → ${acc(p.headless.accuracy)} |`;
  for (const [task, p] of Object.entries(summary.byTask)) lines.push(row(task, p));
  lines.push(row('**overall**', summary.overall));
  return lines.join('\n');
}
