export function armArgs(arm, { model, budgetUsd, pluginDir }) {
  const common = [
    '-p',
    '--output-format', 'stream-json',
    '--verbose',
    '--no-session-persistence',
    '--setting-sources', 'project',
    '--permission-mode', 'bypassPermissions',
    '--model', model,
    '--max-budget-usd', String(budgetUsd),
  ];
  if (arm === 'browser') return [...common, '--chrome', '--disallowedTools', 'Bash', '--'];
  if (arm === 'headless') return [...common, '--no-chrome', '--plugin-dir', pluginDir, '--'];
  throw new Error(`unknown arm ${arm}`);
}
