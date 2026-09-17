#!/usr/bin/env node
// Runs the benchmark: each task × arm × run through `claude -p`, graded, written to results/.

import { execFileSync, spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { armArgs } from './arms.mjs';
import { extractAnswer, grade } from './grade.mjs';
import { schedule } from './schedule.mjs';
import { startFixture } from './server.mjs';
import { parseStream } from './stream.mjs';
import { TASK_IDS, loadPrompt } from './tasks.mjs';

const repo = fileURLToPath(new URL('..', import.meta.url));
const flag = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
};
const runs = Number(flag('runs', '5'));
const tasks = flag('tasks', TASK_IDS.join(',')).split(',');
const model = flag('model', 'claude-opus-5');
const budgetUsd = Number(flag('budget', '2'));
const seed = Number(flag('seed', String(Date.now() % 100000)));
const yes = process.argv.includes('--yes');

function claudeVersion() {
  try {
    return execFileSync('claude', ['--version'], { encoding: 'utf8' }).trim();
  } catch {
    console.error('`claude` CLI not found on PATH');
    process.exit(2);
  }
}

function runClaude(args, prompt, cwd) {
  return new Promise((resolve) => {
    const child = spawn('claude', [...args, prompt], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', () => resolve({ stdout, stderr }));
  });
}

async function once(item, fixture, cwd) {
  const url = fixture.urlFor(item.variant);
  const prompt = await loadPrompt(item.task, url);
  const { stdout, stderr } = await runClaude(armArgs(item.arm, { model, budgetUsd, pluginDir: repo }), prompt, cwd);
  const parsed = parseStream(stdout);
  const answer = parsed.isError ? null : extractAnswer(parsed.finalText);
  const record = { ...item, ...parsed, answer, correct: grade(answer, item.variant) };
  if (parsed.isError) record.stderrTail = stderr.slice(-2000);
  return record;
}

async function confirm(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(question);
  rl.close();
  return answer.trim().toLowerCase() === 'y';
}

async function main() {
  const version = claudeVersion();
  const fixture = await startFixture();
  const work = await mkdtemp(join(tmpdir(), 'headless-verify-bench-'));

  try {
    if (!yes) {
      const preflightCap = 3 * budgetUsd;
      const proceed = await confirm(
        `Preflight check and 2 calibration runs will spend up to $${preflightCap.toFixed(2)} (cap $${budgetUsd} each). Continue? [y/N] `,
      );
      if (!proceed) {
        process.exitCode = 0;
        return;
      }
    }

    // Preflight: the browser arm must actually have claude-in-chrome.
    const { stdout: preflightOut } = await runClaude(
      armArgs('browser', { model, budgetUsd: 0.5, pluginDir: repo }),
      'List the names of your tools that start with mcp__claude-in-chrome, then stop.',
      work,
    );
    const probe = parseStream(preflightOut);
    if (!/mcp__claude-in-chrome/.test(probe.finalText)) {
      console.error('claude-in-chrome is not available to `claude -p --chrome`. Connect the extension and retry.');
      process.exitCode = 2;
      return;
    }

    const plan = schedule({ tasks, runs, seed });
    const calibrationItem = plan.find((p) => p.arm === 'browser');
    const calibrationHItem = plan.find((p) => p.arm === 'headless');
    const calibration = await once(calibrationItem, fixture, work);
    const calibrationH = await once(calibrationHItem, fixture, work);
    console.log(`[calibration] ${calibrationItem.task} browser ${calibrationItem.variant}: ${calibration.correct ? 'correct' : 'wrong'} · $${calibration.costUsd.toFixed(3)}`);
    console.log(`[calibration] ${calibrationHItem.task} headless ${calibrationHItem.variant}: ${calibrationH.correct ? 'correct' : 'wrong'} · $${calibrationH.costUsd.toFixed(3)}`);
    const records = [calibration, calibrationH];

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

    for (const [i, item] of plan.entries()) {
      if (item === calibrationItem || item === calibrationHItem) continue;
      const record = await once(item, fixture, work);
      records.push(record);
      console.log(`[${i + 1}/${plan.length}] ${item.task} ${item.arm} ${item.variant}: ${record.correct ? 'correct' : 'wrong'} · $${record.costUsd.toFixed(3)}${record.isError ? ` · ${record.subtype}` : ''}`);
    }

    const date = new Date().toISOString().slice(0, 10);
    await mkdir(join(repo, 'results'), { recursive: true });
    const path = join(repo, 'results', `${date}-${model}.json`);
    await writeFile(path, JSON.stringify({ meta: { date, model, runs, seed, budgetUsd, claudeVersion: version }, records }, null, 2));
    console.log(`wrote ${path}\nnext: node bench/report.mjs ${path} --readme`);
  } finally {
    await fixture.close();
    await rm(work, { recursive: true, force: true });
  }
}

await main();
