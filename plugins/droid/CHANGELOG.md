# Changelog

## 0.2.0

- Version floor: Droid CLI 1.1.0. `mission`, `--fork`, `--spec` and `--steerable` refuse with `requires Droid CLI >= 1.1.0` on an older CLI. Only `--tag`, the system-prompt file and the widened read-only toolbox fall back: the tag is dropped, the developer instructions go back into the user prompt, and read-only jobs keep `Read,LS,Grep,Glob,Execute` (Droid rejects an `--only-tools` list naming a tool it does not know). `/droid:setup --json` reports the read-only list the installed CLI gets under `toolFence.readOnly`. `/droid:setup` reports the installed version.
- `/droid:mission <goal>` runs a Droid mission (orchestrator, workers and validators) as a tracked background job at `--auto high`. `--worker-model` and `--validator-model` (and their efforts) fall back to the orchestrator's model and effort; see `docs/missions.md`.
- Read-only jobs now get a wider toolbox: the web tools, `Skill`, `ToolSearch`, `TodoWrite` and the subagent tools join `Read,LS,Grep,Glob,Execute`. `--no-web` and `--no-subagents` drop those groups, and the stop-time review gate runs with `--no-web`. `--run-commands` and schema repair keep the narrow five.
- Live steering decision: GO. `task --steerable --background` holds one `droid exec` child open on stdin, and `send JOB MESSAGE` (or `--file`, or `--end`) adds a user turn to it. Model, effort, autonomy and the tool list all go over JSON-RPC and are confirmed by droid, so a steered job keeps the same fence as a one-shot turn. `mission` and the stop hook never use it; `docs/live-steering.md` records the measurements.
- `task --fork JOB|NAME` branches a new linked job from an existing job or named session.
- Defaults and aliases: `--model` accepts Droid's latest-model aliases and version wildcards, `/droid:models` lists the aliases and the defaults in effect, and `/droid:setup` labels each default with its real source.
- Developer instructions go to the model through `--append-system-prompt-file` instead of the user prompt (not on schema-repair turns).
- `task --spec` with `--spec-model` and `--spec-effort` maps to Droid spec mode.
- `/droid:setup` runs `droid doctor` and reports login and host health.
- The plugin tags every task, review, adversarial-review and mission job with its job id and kind in Factory session metadata (`--tag`). It is not a user option, and it is skipped for `--steerable` jobs and CLIs older than 1.1.0.
- `sessions find` finds tracked jobs and sessions by id, name, title or Droid session id.

## 0.1.2

- `--run-commands` for `task`, `review` and `adversarial-review` runs `droid exec --auto medium --only-tools Read,LS,Grep,Glob,Execute`, so tests and other medium-risk commands no longer end a read-only run with `no_approver_available`. No file-editing tools are offered, but it is not a write fence: the companion snapshots the workspace and reports any file that changed during the run as `readOnlyViolation` in the result envelope, and prints a `Read-only violation` line in result and status output. It cannot be combined with `--write`, carries over to resumed turns, and schema-repair turns stay read-only. `--write` is unchanged.
- `--mcp-tool SERVER[/TOOL]` (repeatable, validated) enables MCP tools by Droid's `MCP:<server>[/<tool>]` selector: it extends the `--only-tools` list of read-only and `--run-commands` jobs, and goes to `--add-tools` on `--write` jobs. Read-only jobs still get no MCP tools by default, and `--mcp-config` stays unsupported. Selectors only reach servers configured in Droid, so they do nothing for jobs fenced with an empty `mcp.json`.
- Live `send` steering stays unsupported; `docs/live-steering.md` records why (with `--input-format stream-jsonrpc`, the CLI ignores the `--auto` and `--only-tools` permission flags) and what has to be verified first.
- `/droid:models` (`models [--json]`) parses `droid exec --help` and lists each model's ID, name, supported reasoning efforts and default effort, plus the CLI default model.
- `DROID_DEFAULT_MODEL` and `DROID_DEFAULT_EFFORT` apply to task, review, adversarial-review, worker, compare and verify-claims runs when `--model`/`--effort` are omitted. Explicit flags win; resume keeps the stored session model. `/droid:setup` shows the defaults in effect.
- Effort docs now list every accepted level (`off` through `max`) and note that support varies per model.
- Continued (stream-json) turns keep Factory credits as `factoryCredits`. Droid reports usage cumulatively per session, so a job now stores the session total as `sessionUsage` and its own `usage` as that total minus the session's previous job's total (per key, never below zero). A schema repair no longer double-counts the first turn, and a resumed job no longer claims the whole session. `/droid:result` and `/droid:status` render each job's tokens and credits, and status totals credits across listed jobs.

## 0.1.1

Fix: a continued turn (`sessions resume`, `answer`, `--resume-last`, schema repair) no longer passes `--session-id` with one-shot `--output-format stream-jsonrpc`, which droid rejects. Continued turns stream `--output-format stream-json`, where `--auto`, `--only-tools`, `-m` and `-r` still apply.

## 0.1.0

Initial Factory Droid port: one child per job, JSON-RPC streaming output, local schema validation and repair, durable job controls, worktree jobs, and Claude Code hooks.
