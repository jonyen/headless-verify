#!/usr/bin/env node
// Runs the benchmark: each task × arm × run through `claude -p`, graded, written to results/.
// `--resume <results file>` re-runs only the runs that were blocked (rate_limited, no_result
// or timeout) in a previous results file; see itemsToRun/mergeRecords in resume.mjs.

import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { armArgs } from './arms.mjs';
import { PREFLIGHT_BUDGET_USD, preflightConsent, resultsFileName, runProcess, runRecord } from './runner.mjs';
import { estimateResumeCost, itemsToRun, mergeRecords, resolveResumeSettings, resumeConsent } from './resume.mjs';
import { schedule } from './schedule.mjs';
import { startFixture } from './server.mjs';
import { stagePlugin } from './stage.mjs';
import { parseStream } from './stream.mjs';
import { TASK_IDS, loadPrompt } from './tasks.mjs';

const repo = fileURLToPath(new URL('..', import.meta.url));
const flag = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
};
// Whether `--name` was actually typed on the command line, as opposed to
// falling back to its default. Used on --resume, where an explicit flag that
// conflicts with the results file's own settings must be refused rather than
// silently mixed in (see resolveResumeSettings).
const wasPassed = (name) => process.argv.includes(`--${name}`);

const resumeFile = flag('resume', undefined);
const runs = Number(flag('runs', '5'));
const tasks = flag('tasks', TASK_IDS.join(',')).split(',');
const model = flag('model', 'claude-opus-5');
const budgetUsd = Number(flag('budget', '2'));
const seed = Number(flag('seed', String(Date.now() % 100000)));
const timeoutMinFlag = Number(flag('timeout-min', '10'));
const timeoutMs = timeoutMinFlag * 60_000;
const yes = process.argv.includes('--yes');

function claudeVersion() {
  try {
    return execFileSync('claude', ['--version'], { encoding: 'utf8' }).trim();
  } catch {
    console.error('`claude` CLI not found on PATH');
    process.exit(2);
  }
}

const runClaude = (args, prompt, cwd, runTimeoutMs) => runProcess('claude', [...args, prompt], { cwd, timeoutMs: runTimeoutMs });

async function once(item, fixture, cwd, pluginDir, settings) {
  const url = fixture.urlFor(item.variant);
  const prompt = await loadPrompt(item.task, url);
  const result = await runClaude(
    armArgs(item.arm, { model: settings.model, budgetUsd: settings.budgetUsd, pluginDir }),
    prompt,
    cwd,
    settings.timeoutMs,
  );
  return runRecord(item, result);
}

async function confirm(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(question);
  rl.close();
  return answer.trim().toLowerCase() === 'y';
}

function resultsPath(now) {
  const name = resultsFileName(now, model);
  return join(repo, 'results', name);
}

// Runs `items` in order through `once()`, logging each as it completes. Stops
// immediately (without running the rest) the moment a run comes back
// rate_limited: burning the remaining schedule into more blocked runs just
// wastes the wait for the limit to reset. Returns the records collected so
// far and whether the run was cut short this way.
async function runItems(items, fixture, work, pluginDir, settings, { label, total, offset = 0 }) {
  const records = [];
  for (const [i, item] of items.entries()) {
    const record = await once(item, fixture, work, pluginDir, settings);
    records.push(record);
    const n = offset + i + 1;
    console.log(
      `[${n}/${total}] ${item.task} ${item.arm} ${item.variant}: ${record.correct ? 'correct' : 'wrong'} · $${record.costUsd.toFixed(3)}${record.isError ? ` · ${record.subtype}` : ''}${record.leakSuspect ? ' · LEAK SUSPECT' : ''}`,
    );
    if (record.subtype === 'rate_limited') {
      console.log(`[${label}] hit the account's usage limit; stopping here instead of burning the rest of the schedule into more blocked runs.`);
      return { records, stoppedEarly: true };
    }
  }
  return { records, stoppedEarly: false };
}

async function preflight(work, pluginDir, settings) {
  const { stdout: preflightOut } = await runClaude(
    armArgs('browser', { model: settings.model, budgetUsd: PREFLIGHT_BUDGET_USD, pluginDir }),
    'List the names of your tools that start with mcp__claude-in-chrome, then stop.',
    work,
    settings.timeoutMs,
  );
  const probe = parseStream(preflightOut);
  if (!/mcp__claude-in-chrome/.test(probe.finalText)) {
    console.error('claude-in-chrome is not available to `claude -p --chrome`. Connect the extension and retry.');
    process.exitCode = 2;
    return false;
  }
  return true;
}

async function runResume(fixture, work, pluginDir) {
  const path = resumeFile;
  const { meta, records } = JSON.parse(await readFile(path, 'utf8'));
  const resumeTasks = meta.tasks ?? TASK_IDS;

  // Refuse a conflicting explicit flag instead of silently mixing settings;
  // an override that matches the file's own value is accepted as a no-op.
  const overrides = {
    model: wasPassed('model') ? model : undefined,
    budgetUsd: wasPassed('budget') ? budgetUsd : undefined,
    timeoutMin: wasPassed('timeout-min') ? timeoutMinFlag : undefined,
  };
  let settingsMeta;
  try {
    settingsMeta = resolveResumeSettings(meta, overrides);
  } catch (err) {
    console.error(err.message);
    process.exitCode = 2;
    return;
  }
  const settings = { model: settingsMeta.model, budgetUsd: settingsMeta.budgetUsd, timeoutMs: settingsMeta.timeoutMin * 60_000 };

  const plan = schedule({ tasks: resumeTasks, runs: meta.runs, seed: meta.seed });
  const toRun = itemsToRun(plan, records);

  if (toRun.length === 0) {
    console.log(`nothing to resume in ${path}: no rate_limited, no_result or timeout records.`);
    return;
  }

  const estimate = estimateResumeCost(records, toRun.length);
  console.log(`${toRun.length} of ${plan.length} runs still need to run; estimated cost ≈ $${estimate.toFixed(2)} (budget cap $${settings.budgetUsd}/run)`);

  if (!yes) {
    const proceed = await confirm(
      resumeConsent({ itemsCount: toRun.length, budgetUsd: settings.budgetUsd, preflightBudgetUsd: PREFLIGHT_BUDGET_USD, estimateUsd: estimate }),
    );
    if (!proceed) {
      process.exitCode = 0;
      return;
    }
  }

  // Resume skips calibration entirely (this file already has real cost data
  // to estimate from); the preflight availability probe still runs.
  const ok = await preflight(work, pluginDir, settings);
  if (!ok) return;

  const { records: fresh, stoppedEarly } = await runItems(toRun, fixture, work, pluginDir, settings, {
    label: 'resume',
    total: toRun.length,
  });

  const merged = mergeRecords(records, fresh);
  await writeFile(path, JSON.stringify({ meta: { ...meta, tasks: resumeTasks }, records: merged }, null, 2));
  console.log(`wrote ${path}`);
  if (stoppedEarly) {
    console.log(`next: node bench/run.mjs --resume ${relative(process.cwd(), path)}`);
  } else {
    console.log(`next: node bench/report.mjs ${relative(process.cwd(), path)} --readme`);
  }
}

async function runFresh(fixture, work, pluginDir, version) {
  const settings = { model, budgetUsd, timeoutMs };

  if (!yes) {
    const proceed = await confirm(preflightConsent(budgetUsd));
    if (!proceed) {
      process.exitCode = 0;
      return;
    }
  }

  const ok = await preflight(work, pluginDir, settings);
  if (!ok) return;

  const plan = schedule({ tasks, runs, seed });
  const calibrationItem = plan.find((p) => p.arm === 'browser');
  const calibrationHItem = plan.find((p) => p.arm === 'headless');
  const calibration = await once(calibrationItem, fixture, work, pluginDir, settings);
  const calibrationH = await once(calibrationHItem, fixture, work, pluginDir, settings);
  console.log(`[calibration] ${calibrationItem.task} browser ${calibrationItem.variant}: ${calibration.correct ? 'correct' : 'wrong'} · $${calibration.costUsd.toFixed(3)}`);
  console.log(`[calibration] ${calibrationHItem.task} headless ${calibrationHItem.variant}: ${calibrationH.correct ? 'correct' : 'wrong'} · $${calibrationH.costUsd.toFixed(3)}`);
  const records = [calibration, calibrationH];

  const now = new Date();
  const date = now.toISOString().slice(0, 10);
  const path = resultsPath(now);
  const meta = { date, model, runs, seed, budgetUsd, timeoutMin: timeoutMs / 60_000, claudeVersion: version, tasks };

  const writeResults = async (allRecords) => {
    await mkdir(join(repo, 'results'), { recursive: true });
    await writeFile(path, JSON.stringify({ meta, records: allRecords }, null, 2));
  };

  // A rate-limited calibration run stops the benchmark before it even starts
  // the main schedule; still write what we have so `--resume` can pick it up.
  for (const c of [calibration, calibrationH]) {
    if (c.subtype === 'rate_limited') {
      await writeResults(records);
      console.log(`wrote ${path}\n[calibration] hit the account's usage limit; stopping here.\nnext: node bench/run.mjs --resume ${relative(process.cwd(), path)}`);
      return;
    }
  }

  const remaining = plan.length - 2;
  const estimate = ((calibration.costUsd + calibrationH.costUsd) / 2) * remaining;
  console.log(
    `${plan.length} runs planned (${tasks.length} tasks × 2 arms × ${runs}); ${remaining} remaining after calibration; estimated cost ≈ $${estimate.toFixed(2)} (budget cap $${budgetUsd}/run)`,
  );

  if (!yes) {
    const proceed = await confirm('Proceed? [y/N] ');
    if (!proceed) {
      process.exitCode = 0;
      return;
    }
  }

  const remainingItems = plan.filter((item) => item !== calibrationItem && item !== calibrationHItem);
  const { records: rest, stoppedEarly } = await runItems(remainingItems, fixture, work, pluginDir, settings, {
    label: 'run',
    total: plan.length,
    offset: 2,
  });
  records.push(...rest);

  await writeResults(records);
  if (stoppedEarly) {
    console.log(`wrote ${path}\nnext: node bench/run.mjs --resume ${relative(process.cwd(), path)}`);
  } else {
    console.log(`wrote ${path}\nnext: node bench/report.mjs ${relative(process.cwd(), path)} --readme`);
  }
}

async function main() {
  const version = claudeVersion(); // fails fast (exit 2) if `claude` isn't on PATH, for both fresh and resume runs.
  const fixture = await startFixture();
  const work = await mkdtemp(join(tmpdir(), 'hv-work-'));
  // The headless arm gets a plugin-only copy, never the repo root: the repo holds
  // the answer key (bench/variants.mjs), the spec and the fixture tests.
  const pluginDir = await mkdtemp(join(tmpdir(), 'hv-plugin-'));

  try {
    await stagePlugin(repo, pluginDir);
    if (resumeFile) {
      await runResume(fixture, work, pluginDir);
    } else {
      await runFresh(fixture, work, pluginDir, version);
    }
  } finally {
    await fixture.close();
    await rm(work, { recursive: true, force: true });
    await rm(pluginDir, { recursive: true, force: true });
  }
}

await main();
