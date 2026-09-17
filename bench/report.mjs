#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { renderTable, summarize } from './summarize.mjs';

const [file] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
if (!file) {
  console.error('usage: report.mjs results/<file>.json [--readme]');
  process.exit(2);
}
const { meta, records } = JSON.parse(await readFile(file, 'utf8'));
const table = renderTable(summarize(records), meta);
console.log(table);

if (process.argv.includes('--readme')) {
  const readmeUrl = new URL('../README.md', import.meta.url);
  const readme = await readFile(readmeUrl, 'utf8');
  const start = '<!-- results:start -->';
  const end = '<!-- results:end -->';
  if (!readme.includes(start)) throw new Error('README.md has no results markers');
  const next = readme.replace(new RegExp(`${start}[\\s\\S]*${end}`), `${start}\n${table}\n\nRaw data: [\`${file}\`](${file})\n${end}`);
  await writeFile(readmeUrl, next);
}
