---
description: Start a Droid mission, an orchestrator that plans a goal and runs worker and validator sessions to finish it
argument-hint: '[--model <model>] [--effort <level>] [--worker-model <model>] [--worker-effort <level>] [--validator-model <model>] [--validator-effort <level>] [--instructions <file>] [--worktree <path>] [--lock-cmd <command> --unlock-cmd <command>] <goal>'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

Start a Droid mission for the goal the user gave.

Raw slash-command arguments:
`$ARGUMENTS`

A mission is one `droid exec --mission` run. Droid's orchestrator plans the goal, then starts worker sessions to build it and validator sessions to check it. It can run for many minutes, so this command always starts it as a background job and returns a job id at once.

Run this once, in the foreground. `--background` detaches the companion's own worker, so do NOT wrap the call in `Bash(..., run_in_background: true)`:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/droid-companion.mjs" mission --background "$ARGUMENTS"
```

- Return the command stdout verbatim. Do not paraphrase, summarize, or add commentary.
- Never pass `--background` twice. If the user typed it, forward their arguments without adding another.
- If the user gave no goal, ask what the mission should achieve before running anything.
- Do not poll. The user follows the job with `/droid:status <job-id>`, reads the outcome with `/droid:result <job-id>`, and stops it with `/droid:cancel <job-id>`.
- If the command reports that Droid is missing, unauthenticated, or older than 1.1.0, stop and tell the user to run `/droid:setup`.

What a mission does and does not accept:

- A mission runs at `--auto high` with Droid's full toolset and no tool fence. It can edit files, run any command, and commit and push. Start one only in a repository where that is acceptable.
- `--model` and `--effort` set the orchestrator. `--worker-model`, `--worker-effort`, `--validator-model` and `--validator-effort` set the worker and validator sessions. Each one left unset falls back to the orchestrator's model and effort, so `--model glm-5.3` alone gives a mission that runs on glm-5.3 throughout. Without any `--model`, the configured default model applies (`/droid:setup --default-model`), then the Droid CLI's own default.
- Missions cannot run under the lane lock wrapper. When `DROID_BINARY` points at `droid-lock.sh`, the command refuses, because the wrapper refuses `--mission`.
- A mission runs one unnamed turn that does not pause for questions. It refuses `--name`, `--fanout`, `--brief`, `--preread`, `--fork`, `--persistent`, `--pause-and-ask`, `--read-only`, `--run-commands`, `--write`, `--steerable` and `--spec`.
- A finished mission cannot be resumed or forked; start a new mission instead.
- `/droid:cancel` stops the orchestrator and every worker and validator it started.
