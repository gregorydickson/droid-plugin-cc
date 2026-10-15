# Changelog

## Unreleased

- `/droid:models` (`models [--json]`) parses `droid exec --help` and lists each model's ID, name, supported reasoning efforts and default effort, plus the CLI default model.
- `DROID_DEFAULT_MODEL` and `DROID_DEFAULT_EFFORT` apply to task, review, adversarial-review, worker, compare and verify-claims runs when `--model`/`--effort` are omitted. Explicit flags win; resume keeps the stored session model. `/droid:setup` shows the defaults in effect.
- Effort docs now list every accepted level (`off` through `max`) and note that support varies per model.
- Continued (stream-json) turns keep Factory credits as `factoryCredits`. Droid reports usage cumulatively per session, so a job now stores the session total as `sessionUsage` and its own `usage` as that total minus the session's previous job's total (per key, never below zero). A schema repair no longer double-counts the first turn, and a resumed job no longer claims the whole session. `/droid:result` and `/droid:status` render each job's tokens and credits, and status totals credits across listed jobs.

## 0.1.1

Fix: a continued turn (`sessions resume`, `answer`, `--resume-last`, schema repair) no longer passes `--session-id` with one-shot `--output-format stream-jsonrpc`, which droid rejects. Continued turns stream `--output-format stream-json`, where `--auto`, `--only-tools`, `-m` and `-r` still apply.

## 0.1.0

Initial Factory Droid port: one child per job, JSON-RPC streaming output, local schema validation and repair, durable job controls, worktree jobs, and Claude Code hooks.
