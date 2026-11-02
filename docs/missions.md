# Droid missions: completion and worker lineage

Probed on 2026-11-01 with Droid `1.1.0`, logged in, model `glm-5.3` for the orchestrator, workers and validators. Every run used a fresh temporary git repository with one commit and no remote, and this command:

```
droid exec --mission --auto high -m glm-5.3 -r high --worker-model glm-5.3 --validator-model glm-5.3 \
  --output-format <format> --cwd <repo> -f <prompt>
```

`tests/mission-protocol.test.mjs` reproduces each finding below. It runs only with `DROID_SMOKE_MISSION=1`, because every run spends Factory credits:

```
DROID_SMOKE_MISSION=1 node --import ./tests/isolate-env.mjs --test tests/mission-protocol.test.mjs
```

Set `DROID_MISSION_REPORT=<dir>` to save what each run observed as JSON. Set `DROID_MISSION_REPLAY=<dir>` to check this file against saved reports without starting a mission.

## Observed events per output format

### `--output-format stream-jsonrpc` (one-shot)

Droid rejects the flag combination before it starts a session. It exits with status 1, writes nothing to stdout, and prints this to stderr:

```
Invalid flags: --mission is not supported with one-shot --output-format stream-jsonrpc. Use --output-format stream-json, or drive the session with --input-format stream-jsonrpc.
```

The plugin's fresh turns use exactly this one-shot mode (`buildDroidExecArgs` in `plugins/droid/scripts/lib/droid.mjs`). A mission therefore cannot reuse the fresh-turn arguments unchanged. The controlled mode (`--input-format stream-jsonrpc`) was not probed for the orchestrator. It is the mode Droid itself uses for its worker processes (see the lineage table).

### `--output-format stream-json`

Goal: "Create hello.txt containing the word hi, then stop." The run exited 0 after about 19 seconds, and `hello.txt` contained `hi`. Stdout was NDJSON with no non-JSON lines. Every event carried the same `session_id`, and that session's settings tag it `mission-session` with `role: "orchestrator"` and a `missionId` equal to the session id.

Event types seen, in order of first appearance:

| Event (`type` or `type/subtype`) | Notes |
|:---|:---|
| `system/init` | First line. Carries `session_id`. |
| `message` | User echo and assistant messages. |
| `reasoning` | Reasoning blocks. |
| `tool_call` | The orchestrator called `Create` itself. |
| `tool_result` | Result of that tool call. |
| `completion` | Appeared once, as the last line before exit 0. |

The orchestrator ignored its "do not implement code yourself" instruction and created `hello.txt` with one tool call, so this run started no workers. The test therefore shows that `completion` ends a mission the orchestrator finishes alone. It does not show how many `completion` events a mission emits once workers run.

### Mission length and the stall limit

On 2026-11-02, `glm-5.3` ran the same goal as a full mission rather than doing it alone. The orchestrator loaded its skills, called `ProposeMission`, wrote the mission files with `Create`, and called `StartMissionRun` twice. Droid's `progress_log.jsonl` shows one worker creating `hello.txt` and committing it, then the auto-injected `scrutiny-validator` and `user-testing-validator`. Each of those ran as a further `glm-5.3` worker and spawned a review subagent with `Task`. The run exited 0 with `completion` after 441 seconds. An earlier run on the same goal was killed at the test's former 540-second limit while it was still emitting `tool_call` events. `gpt-6.1-sol` finished the same goal alone, with no workers.

Every session in that run kept writing. Across all session logs for the mission's cwd plus the mission's `progress_log.jsonl` and `worker-transcripts.jsonl`, the longest quiet spell was about 37 seconds. The orchestrator's stdout, by contrast, was silent for about 150 seconds during each `StartMissionRun`. Nothing looped and nothing waited on a permission prompt. The length comes from Droid's validator stages at `glm-5.3` latency, not from the plugin's arguments: droid 1.1.0 has no flag that skips the validators, and the test runs droid directly with the plugin's mission argv.

So the test no longer stops a mission at a fixed length. It stops a mission as stalled when nothing the mission owns has been written for 180 seconds: no stdout line, no session log for its cwd, and no file in `~/.factory/missions/<orchestrator-session-id>/`. A 25-minute ceiling stops only a mission that keeps writing without finishing. The detector was checked offline against fake droids. A silent one was stopped as stalled. One whose stdout stayed quiet for 30 seconds while it kept writing its session log ran to completion. With activity read from stdout alone, that second one was wrongly stopped as stalled.

In the cancel run below (also `stream-json`), the orchestrator wrote its mission files with `Create`, then called `StartMissionRun`. No `completion` arrived before the SIGTERM at about 182 seconds.

## Worker lineage

Cancel run goal: "Run this as a mission with exactly one feature, implemented by exactly one worker. You may write the mission's planning files, but you must not run the sleep or create hello.txt yourself. The worker must first run the shell command `sleep 600`, then create hello.txt containing the word hi." The test sampled `ps -axo pid,ppid,pgid,command` every 2 seconds. It recorded the exec's descendants, any new process naming the mission session id, and any new `droid` or `factoryd` binary.

| Process | Parent | Process group | Role |
|:---|:---|:---|:---|
| `droid exec --mission … --output-format stream-json` | test runner | its own (the exec's group) | Orchestrator. Its session is the mission id. |
| `droid exec --input-format stream-jsonrpc --output-format stream-jsonrpc` | the orchestrator exec | the exec's group | Worker. Its session settings tag it `mission-worker` with `role: "worker"` and the orchestrator's `missionId`. |
| `gt mcp`, `exocortex` and their children | orchestrator, and separately the worker | the exec's group | MCP servers that each Droid process starts. |
| `caffeinate -i -w <droid pid>`, graphite `background` helpers | orchestrator, worker or MCP server | their own groups | Short-lived helpers that leave the group. Not workers. |

The goal first used on 2026-11-01 began "Do not create or edit any file yourself." That contradicts the mission protocol, because the orchestrator must write the mission files before `StartMissionRun` can spawn a worker. On 2026-11-02, `gpt-6.1-sol` obeyed it and stopped without starting a worker: "Blocked: the mission runner requires setup files before launching a worker. Creating them would violate your instruction." The current goal forbids the orchestrator only the work itself.

No `factoryd` process appeared, and no process outside the exec's tree named the mission session id. The worker's command line does not include the mission id. Its session is visible only through `~/.factory/sessions/<cwd-with-dashes>/<worker-session-id>.settings.json`. Droid also keeps the mission's plan under `~/.factory/missions/<orchestrator-session-id>/`: `state.json`, `features.json`, and `progress_log.jsonl`, which records `mission_run_started`, `worker_selected_feature` and `worker_started` with the `workerSessionId`.

## Cancel

The test sends SIGTERM to the exec's process group at the first 2-second sample that sees a live worker `droid` process, and never before: a worker session file alone does not count, because it can outlive its process. A mission that exits without a worker process fails the test as inconclusive. On 2026-11-02 the signal went out about 110 seconds into the run on `glm-5.3` and about 126 seconds in on `gpt-6.1-sol`, both while the worker was running. In every run the exec exited with status 143. Ten seconds later, neither the orchestrator nor any worker process was alive. The worker's session log had not been written more than 5 seconds after the signal. Signalling the exec's process group therefore stops the orchestrator and its workers. That is what the plugin's `terminateProcessTree` already does on POSIX.

The mission's own `state.json` still read `"state": "running"` after the kill. Nothing in Droid marks a killed mission as cancelled, so a reader of that file must not take `running` as proof that the mission is live.

Completion: stream-json completion
Cancel: full
