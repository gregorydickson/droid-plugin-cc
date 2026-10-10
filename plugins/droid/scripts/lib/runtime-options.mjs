/** Provider-specific controls must never be silently treated as permissions. */
export function resolveRuntimeOptions(cwd, options = {}) {
  for (const [key, flag] of [["profile", "profile"], ["mcpConfig", "mcp-config"], ["fanout", "fanout"]]) {
    if (options[key] !== undefined && options[key] !== null) throw new Error(`--${flag} is not supported by this Droid adapter. Configure Droid separately; use independent worker jobs for delegation.`);
  }
  return {};
}
