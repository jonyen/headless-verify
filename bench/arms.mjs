// Both arms share the same isolation flags (verified against `claude --help`,
// Claude Code 2.1.274):
// - --setting-sources project: ignore user and local settings files (user-enabled
//   plugins, hooks, user MCP servers); the temp cwd has no project settings.
// - --strict-mcp-config: only MCP servers from --mcp-config (none are passed), so
//   no user/project MCP servers load. --chrome still adds claude-in-chrome; the
//   preflight probe in run.mjs aborts if it does not.
// Not used, because they would break an arm: --disable-slash-commands ("Disable
// all skills", would hide the plugin's skill), --bare (Anthropic auth only via
// ANTHROPIC_API_KEY, skips plugin sync), --safe-mode (disables plugins and MCP).
export function armArgs(arm, { model, budgetUsd, pluginDir }) {
  const common = [
    '-p',
    '--output-format', 'stream-json',
    '--verbose',
    '--no-session-persistence',
    '--setting-sources', 'project',
    '--strict-mcp-config',
    '--permission-mode', 'bypassPermissions',
    '--model', model,
    '--max-budget-usd', String(budgetUsd),
  ];
  if (arm === 'browser') return [...common, '--chrome', '--disallowedTools', 'Bash', '--'];
  if (arm === 'headless') return [...common, '--no-chrome', '--plugin-dir', pluginDir, '--'];
  throw new Error(`unknown arm ${arm}`);
}
