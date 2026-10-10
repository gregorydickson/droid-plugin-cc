# Droid for Claude Code

Delegate work to the Factory AI CLI from Claude Code, with durable background jobs, structured workers, reviews, resume, cancellation, worktree isolation, and an optional stop-time review gate.

Ported from gregorydickson/codex-plugin-cc at ff417c0, a fork of openai/codex-plugin-cc. See LICENSE and NOTICE for attribution.

## Install

Requires Node.js 18.18+ and an authenticated [Factory Droid CLI](https://docs.factory.ai/cli/getting-started/overview) on PATH. Authenticate with `/login` in Droid or `FACTORY_API_KEY`. `DROID_BINARY` can select an absolute binary path (or a Node `.mjs`/`.cjs` wrapper).

```sh
claude plugin marketplace add /absolute/path/to/droid-plugin-cc
claude plugin install droid@droid-fork
```

The marketplace manifest names this checkout `droid-fork`. Run `/droid:setup` after installation. Setup checks CLI availability; the first run checks authentication.

## Commands

| Command | Purpose |
| --- | --- |
| `/droid:rescue <task>` | Delegate a task; read-only by default |
| `/droid:rescue --write <task>` | Authorize development changes |
| `/droid:rescue --resume <prompt>` | Continue the last tracked task in this Claude session |
| `/droid:review [--base ref]` | Standard review of working-tree or branch changes |
| `/droid:adversarial-review [focus]` | Review using the adversarial prompt |
| `/droid:status [job-id]` | Inspect progress |
| `/droid:result [job-id]` | Collect durable output |
| `/droid:cancel [job-id]` | Stop the job and its Droid process tree |
| `/droid:setup --enable-review-gate` | Enable the stop-time review gate |
| `/droid:setup --disable-review-gate` | Disable the gate |
| `/droid:transfer` | Explain transcript-import limits and the summary-based alternative |

Rescue supports `--background`, `--wait`, `--fresh`, `--model ID`, and `--effort LEVEL`. Both review commands are always read-only. The plugin supplies the git diff; Droid can read repository files for context. Large diffs are passed in a prompt file, subject to the CLI's context limit.

## Permissions and execution

The companion starts `droid exec --output-format stream-jsonrpc` once per job. It reads structured progress and completion events and stores the returned session ID. There is no shared broker. The session history belongs to Droid; job records and rendered results belong to the plugin.

Read-only calls omit `--auto` and explicitly allow only `Read,LS,Grep,Glob`. This prevents tool-driven edits and shell execution even if local defaults change. `--write` maps to `--auto medium`: local development operations, including package installs and local git operations, may be allowed. This is an autonomy policy, not an OS filesystem sandbox. The plugin never passes `--skip-permissions-unsafe`.

`--model` maps to `-m`, and `--effort` to `-r`; Factory validates model support. Resume passes the stored session ID with `--session-id`. Cancellation terminates the child's process group and publishes a cancelled job. SessionEnd cancels ephemeral jobs belonging to that Claude session; named or persistent jobs survive.

## Structured workers

The `droid-worker` agent accepts a caller-provided JSON schema and returns an envelope containing `jobId`, `status`, `schemaValid`, `result`, `usage`, `changedFiles`, and `inputs`, plus diagnostics. Accept a result only when status is `completed` and schemaValid is `true`.

```sh
node plugins/droid/scripts/droid-companion.mjs task \
  --background --brief brief.md --output-schema schema.json --json
node plugins/droid/scripts/droid-companion.mjs status task-ID --wait --json
node plugins/droid/scripts/droid-companion.mjs result task-ID --json
```

The schema is included in the prompt and checked with Ajv. Invalid output gets exactly one read-only repair attempt in the same session, then fails visibly. This adapter does not use provider-side schema enforcement.

Workers retain named sessions, pause-and-ask/answer, result files, notification sockets, lifecycle commands, and caller context. See [worker details](plugins/droid/docs/workers.md).

`--worktree PATH` selects an existing git worktree root. The plugin keeps its existing worktree validation, snapshots, locks, and changed-file accounting instead of using `droid -w`, so durable job ownership and recovery use the same path on every resume. Create the worktree before launching the worker.

## Limits

The previous provider's native reviewer is replaced by a read-only review prompt. Native Claude transcript import, provider profiles/TOML MCP overrides, exact subagent fanout accounting, and live turn steering are unavailable in this adapter. Unsupported profile, MCP-config, and fanout flags fail explicitly. Use a brief/preread for handoff context, independent worker jobs for parallel work, and another resumed turn for follow-ups. `send` reports that live steering is unavailable.

Only tracked job sessions can be resumed; the plugin does not search Droid's global session history. Droid may retain session history for reviews as well as tasks; plugin cleanup does not delete that Factory history. Usage comes from completion events and may be absent on failures. The adapter does not collect private reasoning or child-agent transcripts. Read-only jobs cannot run tests or shell commands; the host supplies review diffs.

## Development

```sh
npm ci
npm run build
npm test
DROID_SMOKE=1 npm test
```

Runtime Ajv dependencies are bundled for plugin installations. Tests isolate inherited `CLAUDE_PLUGIN_DATA` and use fake Droid executables. The optional smoke test invokes the installed CLI on a tiny read-only prompt and requires working authentication. [Protocol notes](docs/droid-protocol.md) distinguish observed behavior from unverified success paths.
