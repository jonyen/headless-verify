#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readmeResultsBlock, renderTable, summarize, summaryPathFor } from './summarize.mjs';

const [file] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
if (!file) {
  console.error('usage: report.mjs results/<file>.json [--readme]');
  process.exit(2);
}
const { meta, records } = JSON.parse(await readFile(file, 'utf8'));
const summary = summarize(records);
const summaryPath = summaryPathFor(file);
await writeFile(summaryPath, JSON.stringify(summary, null, 2));
const table = renderTable(summary, meta, basename(summaryPath));
console.log(table);

if (process.argv.includes('--readme')) {
  const readmeUrl = new URL('../README.md', import.meta.url);
  const repoRoot = fileURLToPath(new URL('..', import.meta.url));
  const readme = await readFile(readmeUrl, 'utf8');
  const start = '<!-- results:start -->';
  const end = '<!-- results:end -->';
  if (!readme.includes(start)) throw new Error('README.md has no results markers');
  const block = readmeResultsBlock(table, file, repoRoot);
  const next = readme.replace(new RegExp(`${start}[\\s\\S]*${end}`), () => `${start}\n${block}\n${end}`);
  await writeFile(readmeUrl, next);
}
