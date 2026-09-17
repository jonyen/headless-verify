#!/usr/bin/env node
// Usage: node analyze/session-cost.mjs <session.jsonl | --all> [--since YYYY-MM-DD] [--json] [--fixed]
// Reads Claude Code transcripts locally and reports token cost by tool family.
// Per session, chars-per-token ratios are fitted from the transcript's recorded usage and
// validated by the median per-turn error on held-out turns (analyze/fit.mjs), after excluding
// context resets and non-positive growth; sessions with too little data, or --fixed, use the
// spec's fixed 4 chars/token. Output never includes tool-result content.

import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseTranscript } from './transcript.mjs';
import { costBreakdown, FIXED_RATIOS } from './cost.mjs';
import { buildObservations, fitRatios } from './fit.mjs';

const args = process.argv.slice(2);
const json = args.includes('--json');
const forceFixed = args.includes('--fixed');
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
  console.error('usage: session-cost.mjs <session.jsonl | --all> [--since YYYY-MM-DD] [--json] [--fixed]');
  process.exit(2);
}

const files = args.includes('--all') ? await allTranscripts() : [target];
let malformed = 0;
// Carry cost must not cross session boundaries.
const reports = [];
const fits = [];
for (const file of files) {
  const transcript = parseTranscript(await readFile(file, 'utf8'));
  malformed += transcript.malformed;
  const observations = buildObservations(transcript);
  const fit = fitRatios(observations);
  if (forceFixed) {
    const { observations: n, dropped, excluded, compactMarkers } = fit;
    Object.assign(fit, { ...fitRatios([]), observations: n, dropped, excluded, compactMarkers, reason: '--fixed' });
    delete fit.fittedClasses;
    delete fit.holdoutTurns;
  }
  fits.push(fit);
  const ratios = fit.method === 'fitted' ? fit : FIXED_RATIOS;
  reports.push(costBreakdown(transcript, { ratios }));
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

// Ratio summary: the single session's fit, or counts and pooled holdout numbers across sessions.
const pick = (f) => ({
  method: f.method,
  toolCharsPerToken: f.toolCharsPerToken,
  contextCharsPerToken: f.contextCharsPerToken,
  criterion: f.criterion,
  medianTurnHoldoutErrorPct: f.medianTurnHoldoutErrorPct,
  summedHoldoutErrorPct: f.summedHoldoutErrorPct,
  observations: f.observations,
  dropped: f.dropped,
  excluded: f.excluded,
  compactMarkers: f.compactMarkers,
  ...(f.fittedClasses ? { fittedClasses: f.fittedClasses } : {}),
  ...(f.reason ? { reason: f.reason } : {}),
});
const fitted = fits.filter((f) => f.method === 'fitted');
const med = (xs) => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const pooledPredicted = fitted.reduce((s, f) => s + f.holdoutPredicted, 0);
const pooledRecorded = fitted.reduce((s, f) => s + f.holdoutRecorded, 0);
const ratios =
  files.length === 1
    ? pick(fits[0])
    : {
        fittedSessions: fitted.length,
        fixedSessions: fits.length - fitted.length,
        criterion: 'medianSessionMedianTurnHoldoutErrorPct',
        medianSessionMedianTurnHoldoutErrorPct: med(fitted.map((f) => f.medianTurnHoldoutErrorPct)),
        sessionsMeeting15Pct: fitted.filter((f) => f.medianTurnHoldoutErrorPct <= 15).length,
        pooledSummedHoldoutErrorPct: pooledRecorded ? (Math.abs(pooledPredicted - pooledRecorded) / pooledRecorded) * 100 : null,
        medianToolCharsPerToken: med(fitted.map((f) => f.toolCharsPerToken)),
        medianContextCharsPerToken: med(fitted.map((f) => f.contextCharsPerToken)),
        observations: fits.reduce((s, f) => s + f.observations, 0),
        dropped: fits.reduce((s, f) => s + f.dropped, 0),
        excluded: Object.fromEntries(['contextDrop', 'afterDrop', 'nonPositiveGrowth'].map((k) => [k, fits.reduce((s, f) => s + f.excluded[k], 0)])),
        compactMarkers: fits.reduce((s, f) => s + f.compactMarkers, 0),
        perSession: files.map((file, i) => ({ session: file.split('/').pop().replace(/\.jsonl$/, ''), ...pick(fits[i]) })),
      };

if (json) {
  console.log(JSON.stringify({ sessions: files.length, malformed, billedInput: combined.billedInput, families, ratios, calibration: { estimated: combined.estimated, recorded: combined.recorded, errorPct, impliedCharsPerToken } }, null, 2));
} else {
  const fmt = (n) => Math.round(n).toLocaleString('en-US');
  console.log(`Sessions: ${files.length} · billed input tokens: ${fmt(combined.billedInput)}${malformed ? ` · skipped ${malformed} malformed lines` : ''}\n`);
  console.log('| tool family | calls | images | direct tokens | carry tokens | share of input |');
  console.log('| --- | --- | --- | --- | --- | --- |');
  for (const f of families) {
    console.log(`| ${f.family} | ${f.calls} | ${f.images} | ${fmt(f.directTokens)} | ${fmt(f.carryTokens)} | ${(f.shareOfInput * 100).toFixed(1)}% |`);
  }
  const impliedStr = impliedCharsPerToken === null ? 'n/a' : impliedCharsPerToken.toFixed(2);
  const pct = (x) => (x === null ? 'n/a' : `${x.toFixed(1)}%`);
  const r2 = (x) => (x === null ? 'n/a' : x.toFixed(2));
  const exc = (f) => `observations ${f.observations} · excluded: context drop ${f.excluded.contextDrop}, after drop ${f.excluded.afterDrop}, growth ≤ 0: ${f.excluded.nonPositiveGrowth}${f.compactMarkers ? ` (${f.compactMarkers} compact markers)` : ''}`;
  if (files.length === 1) {
    const f = ratios;
    const head = f.method === 'fitted' ? 'fitted' : `fixed (${f.reason})`;
    console.log(`\nRatios: ${head} · tool ${r2(f.toolCharsPerToken)} chars/token · context ${r2(f.contextCharsPerToken)} chars/token · median per-turn holdout error ${pct(f.medianTurnHoldoutErrorPct)} (criterion) · summed holdout error ${pct(f.summedHoldoutErrorPct)} (secondary) · ${exc(f)}`);
  } else {
    console.log(`\nRatios: fitted in ${ratios.fittedSessions} sessions, fixed in ${ratios.fixedSessions}${forceFixed ? ' (--fixed)' : ''} · median tool ${r2(ratios.medianToolCharsPerToken)} / context ${r2(ratios.medianContextCharsPerToken)} chars/token · median of per-session median per-turn holdout error ${pct(ratios.medianSessionMedianTurnHoldoutErrorPct)} (criterion) · ${ratios.sessionsMeeting15Pct} of ${ratios.fittedSessions} fitted sessions ≤15% · pooled summed holdout error ${pct(ratios.pooledSummedHoldoutErrorPct)} (secondary) · ${exc(ratios)}`);
  }
  console.log('Summed holdout error is secondary: totals can match while individual turns are far off.');
  console.log(`Fixed-ratio calibration: estimated ${fmt(combined.estimated)} vs recorded ${fmt(combined.recorded)} tokens of new context (${errorPct.toFixed(1)}% off) · implied chars/token (tool-result-only turns): ${impliedStr}`);
}
