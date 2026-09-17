// Small, testable pieces of run.mjs: spawning with a wall-clock timeout, turning
// a finished (or killed) run into a record, and the consent/file-name text.

import { spawn } from 'node:child_process';
import { extractAnswer, grade } from './grade.mjs';
import { parseStream } from './stream.mjs';

export const PREFLIGHT_BUDGET_USD = 0.5;

export function runProcess(cmd, args, { cwd, timeoutMs, killGraceMs = 5000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let killTimer;
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    const timer = timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill('SIGTERM');
          killTimer = setTimeout(() => child.kill('SIGKILL'), killGraceMs);
        }, timeoutMs)
      : undefined;
    child.on('close', () => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      resolve({ stdout, stderr, timedOut });
    });
  });
}

export function runRecord(item, { stdout, stderr, timedOut }) {
  const parsed = parseStream(stdout);
  if (timedOut) {
    parsed.isError = true;
    parsed.subtype = 'timeout';
  }
  const answer = parsed.isError ? null : extractAnswer(parsed.finalText);
  const record = { ...item, ...parsed, answer, correct: grade(answer, item.variant) };
  if (parsed.isError) record.stderrTail = stderr.slice(-2000);
  return record;
}

export function preflightConsent(budgetUsd) {
  const max = PREFLIGHT_BUDGET_USD + 2 * budgetUsd;
  return (
    `Preflight check (cap $${PREFLIGHT_BUDGET_USD.toFixed(2)}) and 2 calibration runs ` +
    `(cap $${budgetUsd.toFixed(2)} each) will spend up to $${max.toFixed(2)}. Continue? [y/N] `
  );
}

export function resultsFileName(now, model) {
  const iso = now.toISOString();
  return `${iso.slice(0, 10)}-${iso.slice(11, 19).replaceAll(':', '')}-${model}.json`;
}
