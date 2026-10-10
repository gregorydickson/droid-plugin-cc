# Droid workers

Call `droid-worker` with a brief and JSON schema. The worker returns the collected JSON envelope, never an invented success. Check both `status == "completed"` and `schemaValid == true`.

The companion accepts these task options:

- `--output-schema FILE`, `--result-file FILE` (supports `{jobId}`), `--notify-socket PATH`.
- `--brief FILE`, repeated `--instructions FILE`, repeated `--preread FILE`.
- `--name NAME`, `--persistent`, `--pause-and-ask`.
- `--worktree PATH`, `--lock-cmd COMMAND`, `--unlock-cmd COMMAND`.
- `--on-start`, `--on-progress`, `--on-stop-report`, `--on-end`, `--on-fail` commands.
- `--write`, `--model ID`, `--effort LEVEL`, `--background`, `--json`.

Shell lifecycle commands are caller code and require caller authorization. Runtime events include job IDs and stable delivery IDs for idempotent recovery. Job files retain private configuration; public status/results omit executable hook contents.

Read-only is the default. `--write` maps to Factory's `--auto medium`, not a filesystem sandbox. A supplied worktree must already exist; the companion validates its root and snapshots changes inside the caller's lock. Unlock and result-publication failures cannot become successful completions.

`task --resume-last` and `sessions resume NAME PROMPT` continue the stored Droid session ID. Write intent, schema, instructions, worktree, and lifecycle controls are inherited. Brief and preread input from the previous slice is not sent again. `sessions list` lists retained jobs; `sessions stop NAME` cancels one.

With `--pause-and-ask`, a structured stop report contains `state: "awaiting-answer"`, `question`, `draftAnswer`, `facts`, and `itemsHeld`. The caller can answer with `answer JOB_ID TEXT` (or `--file FILE`). This resumes the stored session and retains the original schema. A pause releases the worktree lock; resumed accounting excludes unrelated writes during the pause.

Output-schema enforcement is local Ajv validation with one read-only repair turn. Invalid results include raw output and validation diagnostics. The envelope exposes `jobId`, `status`, `schemaValid`, `result`, `usage`, `changedFiles`, and `inputs`, plus session and delivery metadata.

`--profile`, `--mcp-config`, and `--fanout` are rejected: this adapter cannot preserve their earlier enforcement contracts. Configure Droid separately. Use multiple independent worker jobs when parallel results are needed. Live `send` steering is unsupported; cancel or resume with another prompt. Native transcript import is unsupported; supply a summary or context files.

Each job owns its own Droid child process group. Cancelling it terminates that group; no broker is needed. SessionEnd cleans up unnamed, nonpersistent jobs for that Claude session, while the watchdog recovers crashed workers and publishes durable failure results.
