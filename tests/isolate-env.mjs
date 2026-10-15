import process from "node:process";

// A Claude Code session exports these into every shell. Inherited, they point the
// tests' job state at the live plugin data directory and bind jobs to that session.
for (const name of [
  "CLAUDE_PLUGIN_DATA",
  "CLAUDE_PLUGIN_ROOT",
  "CLAUDE_ENV_FILE",
  "CLAUDE_PROJECT_DIR",
  "DROID_COMPANION_SESSION_ID",
  "DROID_COMPANION_TRANSCRIPT_PATH",
  "DROID_DEFAULT_MODEL",
  "DROID_DEFAULT_EFFORT"
]) {
  delete process.env[name];
}
