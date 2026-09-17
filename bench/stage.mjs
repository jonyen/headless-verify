// Stages a plugin-only copy of this repo for the headless arm, so the agent
// under test learns only a temp path and cannot browse bench/, docs/, test/ or
// analyze/ (which name the fixture's defects). playwright-core is copied (not
// symlinked) so no path inside the staged tree points back at the repo.

import { cp } from 'node:fs/promises';
import { join } from 'node:path';

export const STAGED = ['.claude-plugin', 'skills', 'scripts'];

export async function stagePlugin(repoRoot, dest) {
  for (const dir of STAGED) {
    await cp(join(repoRoot, dir), join(dest, dir), { recursive: true });
  }
  await cp(join(repoRoot, 'node_modules', 'playwright-core'), join(dest, 'node_modules', 'playwright-core'), {
    recursive: true,
    dereference: true,
  });
  return dest;
}
