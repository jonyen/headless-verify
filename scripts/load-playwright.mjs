// Resolve playwright-core. Inside this repo it is a normal dependency; when the
// plugin is installed without node_modules, install it once into a cache dir.

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const VERSION = '^1.63.0';

export async function loadPlaywright() {
  try {
    return await import('playwright-core');
  } catch {
    const cache = process.env.HEADLESS_VERIFY_CACHE ?? join(homedir(), '.cache', 'headless-verify');
    const entry = join(cache, 'node_modules', 'playwright-core', 'index.mjs');
    if (!existsSync(entry)) {
      process.stderr.write(`installing playwright-core into ${cache} (one time)\n`);
      execFileSync('npm', ['install', '--prefix', cache, '--no-save', `playwright-core@${VERSION}`], {
        stdio: ['ignore', 'ignore', 'inherit'],
      });
    }
    return import(pathToFileURL(entry).href);
  }
}
