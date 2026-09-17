#!/usr/bin/env node
// Usage: node analyze/session-cost.mjs <session.jsonl | --all> [--since YYYY-MM-DD] [--json]
// Reads Claude Code transcripts locally and reports token cost by tool family.
// Output never includes tool-result content.

import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseTranscript } from './transcript.mjs';
import { costBreakdown } from './cost.mjs';

const args = process.argv.slice(2);
const json = args.includes('--json');
const sinceIdx = args.indexOf('--since');
const since = sinceIdx >= 0 ? new Date(args[sinceIdx + 1]) : null;
const target = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--since');

async function allTranscripts() {
  const root = join(homedir(), '.claude', 'projects');
  const files = [];
  for (const dir of await readdir(root)) {
    for (const name of await readdir(join(root, dir)).catch(() => [])) {
      if (!name.endsWith('.jsonl')) continue;
      const path = join(root, dir, name);
      if (since && (await stat(path)).mtime < since) continue;
      files.push(path);
    }
  }
  return files;
}

if (!target && !args.includes('--all')) {
  console.error('usage: session-cost.mjs <session.jsonl | --all> [--since YYYY-MM-DD] [--json]');
  process.exit(2);
}

const files = args.includes('--all') ? await allTranscripts() : [target];
let malformed = 0;
// Carry cost must not cross session boundaries.
const reports = [];
for (const file of files) {
  const transcript = parseTranscript(await readFile(file, 'utf8'));
  malformed += transcript.malformed;
  reports.push(costBreakdown(transcript));
}
const combined = reports.reduce(
  (acc, r) => {
    for (const f of r.families) {
      const row = acc.families.get(f.family) ?? { family: f.family, calls: 0, images: 0, directTokens: 0, carryTokens: 0 };
      row.calls += f.calls;
      row.images += f.images;
      row.directTokens += f.directTokens;
      row.carryTokens += f.carryTokens;
      acc.families.set(f.family, row);
    }
    acc.billedInput += r.totals.billedInput;
    acc.estimated += r.calibration.estimated;
    acc.recorded += r.calibration.recorded;
    acc.impliedTextChars += r.calibration.impliedTextChars;
    acc.impliedDenominator += r.calibration.impliedDenominator;
    return acc;
  },
  { families: new Map(), billedInput: 0, estimated: 0, recorded: 0, impliedTextChars: 0, impliedDenominator: 0 },
);
const families = [...combined.families.values()]
  .map((f) => ({ ...f, shareOfInput: combined.billedInput ? (f.directTokens + f.carryTokens) / combined.billedInput : 0 }))
  .sort((a, b) => b.directTokens + b.carryTokens - (a.directTokens + a.carryTokens));
const errorPct = combined.recorded ? (Math.abs(combined.estimated - combined.recorded) / combined.recorded) * 100 : 0;
// Empirical ratio for tool-result-only turns; reported alongside the calibration, never fed
// back into `estimated`.
const impliedCharsPerToken = combined.impliedDenominator > 0 ? combined.impliedTextChars / combined.impliedDenominator : null;

if (json) {
  console.log(JSON.stringify({ sessions: files.length, malformed, billedInput: combined.billedInput, families, calibration: { estimated: combined.estimated, recorded: combined.recorded, errorPct, impliedCharsPerToken } }, null, 2));
} else {
  const fmt = (n) => Math.round(n).toLocaleString('en-US');
  console.log(`Sessions: ${files.length} · billed input tokens: ${fmt(combined.billedInput)}${malformed ? ` · skipped ${malformed} malformed lines` : ''}\n`);
  console.log('| tool family | calls | images | direct tokens | carry tokens | share of input |');
  console.log('| --- | --- | --- | --- | --- | --- |');
  for (const f of families) {
    console.log(`| ${f.family} | ${f.calls} | ${f.images} | ${fmt(f.directTokens)} | ${fmt(f.carryTokens)} | ${(f.shareOfInput * 100).toFixed(1)}% |`);
  }
  const impliedStr = impliedCharsPerToken === null ? 'n/a' : impliedCharsPerToken.toFixed(2);
  console.log(`\nCalibration: estimated ${fmt(combined.estimated)} vs recorded ${fmt(combined.recorded)} tokens of new context (${errorPct.toFixed(1)}% off) · implied chars/token (tool-result-only turns): ${impliedStr}`);
}
