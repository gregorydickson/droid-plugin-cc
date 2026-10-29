# Changelog

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
