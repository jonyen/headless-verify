#!/usr/bin/env node
// Runs the benchmark: each task × arm × run through `claude -p`, graded, written to results/.

import { execFileSync, spawn } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
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
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', () => {});
    child.on('close', () => resolve(out));
  });
}

async function once(item, fixture, cwd) {
  const url = fixture.urlFor(item.variant);
  const prompt = await loadPrompt(item.task, url);
  const parsed = parseStream(await runClaude(armArgs(item.arm, { model, budgetUsd, pluginDir: repo }), prompt, cwd));
  const answer = parsed.isError ? null : extractAnswer(parsed.finalText);
  return { ...item, ...parsed, answer, correct: grade(answer, item.variant) };
}

const version = claudeVersion();
const fixture = await startFixture();
const work = await mkdtemp(join(tmpdir(), 'headless-verify-bench-'));

// Preflight: the browser arm must actually have claude-in-chrome.
const probe = parseStream(
  await runClaude(
    armArgs('browser', { model, budgetUsd: 0.5, pluginDir: repo }),
    'List the names of your tools that start with mcp__claude-in-chrome, then stop.',
    work,
  ),
);
if (!/mcp__claude-in-chrome/.test(probe.finalText)) {
  console.error('claude-in-chrome is not available to `claude -p --chrome`. Connect the extension and retry.');
  await fixture.close();
  process.exit(2);
}

const plan = schedule({ tasks, runs, seed });
const calibration = await once(plan.find((p) => p.arm === 'browser'), fixture, work);
const calibrationH = await once(plan.find((p) => p.arm === 'headless'), fixture, work);
const estimate = ((calibration.costUsd + calibrationH.costUsd) / 2) * plan.length;
console.log(`${plan.length} runs planned (${tasks.length} tasks × 2 arms × ${runs}); estimated cost ≈ $${estimate.toFixed(2)} (budget cap $${budgetUsd}/run)`);

if (!yes) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question('Proceed? [y/N] ');
  rl.close();
  if (answer.trim().toLowerCase() !== 'y') {
    await fixture.close();
    process.exit(0);
  }
}

const records = [];
for (const [i, item] of plan.entries()) {
  const record = await once(item, fixture, work);
  records.push(record);
  console.log(`[${i + 1}/${plan.length}] ${item.task} ${item.arm} ${item.variant}: ${record.correct ? 'correct' : 'wrong'} · $${record.costUsd.toFixed(3)}${record.isError ? ` · ${record.subtype}` : ''}`);
}
await fixture.close();

const date = new Date().toISOString().slice(0, 10);
await mkdir(join(repo, 'results'), { recursive: true });
const path = join(repo, 'results', `${date}-${model}.json`);
await writeFile(path, JSON.stringify({ meta: { date, model, runs, seed, budgetUsd, claudeVersion: version }, records }, null, 2));
console.log(`wrote ${path}\nnext: node bench/report.mjs ${path} --readme`);
