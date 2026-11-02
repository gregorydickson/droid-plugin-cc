# Live steering (`send`): input protocol

Status: built. `task --steerable --background` runs a job on a held-open input session and `send <job> <message>` adds a user turn to it; the design is under "Design" below. This note also records how `droid exec --input-format stream-jsonrpc` is driven, what can be set over it, and the go/no-go decision the design was built on.

Captured against droid 1.1.0 on glm-5.3. The transcript is `tests/fixtures/droid-input-session-1.1.0.ndjson` (paths and account identifiers scrubbed; `$CWD` stands for the session's repo). `tests/steering-protocol.test.mjs` checks the table and the decision against that transcript, and with `DROID_SMOKE=1` replays the setting requests against real Droid.

## Why the settings have to go over JSON-RPC

With `--input-format stream-jsonrpc`, droid validates `-m`, `--auto`, `-r`, `--only-tools`, `--add-tools`, `--remove-tools`, `-s`/`--session-id`, `--tag` and `--session-title` but ignores them, and warns on stderr (`droid exec --help`, "Stream JSON-RPC Mode"). A steered job therefore sets model, effort, autonomy and its tool list through JSON-RPC requests, or it runs with whatever the user's Factory settings say. A session initialized with only a `cwd` took the user's defaults, which on the capture machine were autonomy `high`; the defaults are not read-only.

## What can be set

| Setting | Settable | Request | Confirmed by |
|---|---|---|---|
| model | yes | `droid.initialize_session` or `droid.update_session_settings` with `modelId` | `settings.modelId` in the initialize result, and in the `settings_updated` notification whose `requestId` is the update's `id` |
| effort | yes | the same requests with `reasoningEffort` | `settings.reasoningEffort` |
| autonomy | yes | the same requests with `autonomyLevel` (`off`, `low`, `medium`, `high`) | `settings.autonomyLevel`, plus the derived `settings.autonomyMode` (`off` is `normal`, `low` is `auto-low`) |
| tool list | yes | the same requests with `restrictToolIds` (also `enabledToolIds`, `disabledToolIds`, `additionalToolIds`) | `settings.restrictToolIds`, and `droid.list_tools`, whose `result.tools[].currentlyAllowed` is true for exactly the listed tools |
| `--settings` | yes | `droid exec --settings <file> --input-format stream-jsonrpc …` with `{"sessionDefaultSettings": {"model", "reasoningEffort", "autonomyLevel"}}`, then `droid.initialize_session` with no settings | the initialize result's `settings` carry the file's values instead of the user's defaults |

The tool list takes effect, not only the echo: with autonomy `low` and `restrictToolIds` set to `Read`, `LS`, `Grep` and `Glob`, a request to `Create` `probe.txt` was answered "no Create tool" and no file was written. With autonomy `low` and `Create` added to the list, the same request created the file.

Autonomy is a fence of its own. At autonomy `off`, `droid.list_tools` leaves out the edit tools even when `restrictToolIds` names them, and `Create` is refused whatever the list says. `restrictToolIds` accepts either a tool's `llmId` (`Create`) or its `id` (`create-cli`); a name droid does not know is left out of the list in force, so the list to trust is the one `droid.list_tools` reports, not the one requested.

## The requests

Every line on stdin and stdout is one JSON object. Requests carry the envelope `{"jsonrpc": "2.0", "factoryApiVersion": "1.0.0", "factoryProtocolVersion": "1.257.0", "type": "request", "id": "<uuid>", "method": "…", "params": {…}}`. Responses carry the same `id` and a `result` (or `error`). Everything else is a `droid.session_notification` whose `params.notification.type` names the event.

Start the session, with the full fence:

```json
{"method": "droid.initialize_session", "params": {"machineId": "probe", "cwd": "$CWD", "modelId": "glm-5.3", "reasoningEffort": "low", "interactionMode": "auto", "autonomyLevel": "off", "restrictToolIds": ["Read", "LS", "Grep", "Glob"]}}
```

The result has `sessionId`, `settings` (every field above), `session.messages` and `availableModels` (`id` and `supportedReasoningEfforts` per model).

Change one or more settings; fields not named keep their value:

```json
{"method": "droid.update_session_settings", "params": {"modelId": "glm-5.3-flash"}}
{"method": "droid.update_session_settings", "params": {"reasoningEffort": "high"}}
{"method": "droid.update_session_settings", "params": {"autonomyLevel": "low"}}
{"method": "droid.update_session_settings", "params": {"restrictToolIds": ["Read", "LS"]}}
```

The response is an empty `result`. The confirmation is the `settings_updated` notification with `requestId` equal to the request's `id`, carrying the full settings after the change. Droid also emits `settings_updated` notifications without a `requestId` while it applies a change; only the one with the `requestId` is the confirmation.

List the tools the session will allow:

```json
{"method": "droid.list_tools", "params": {}}
```

Send a message, and interrupt the running turn:

```json
{"method": "droid.add_user_message", "params": {"text": "…", "queuePlacement": "end_of_turn"}}
{"method": "droid.interrupt_session", "params": {}}
```

Other methods in the CLI bundle include `droid.close_session`, `droid.resolve_queued_user_message`, `droid.load_session`, `droid.fork_session`, `droid.compact_session` and, from droid to the client, `droid.request_permission`. They were not exercised.

## Turns

- **Completion.** A turn ends with an `agent_turn_completed` notification: `reason` (`completed` or `cancelled`), `turnId` (the id of the user message that started the turn), `tokenUsage` for the turn and `cumulativeTokenUsage` for the session.
- **A message sent mid-turn is queued, not an interrupt.** With the default `queuePlacement` (`end_of_turn`), the message is added after the current tool results and the model answers it inside the same turn; only one `agent_turn_completed` arrives, with the first message's `turnId`. With `end_of_loop`, the model finishes its reply to the first message and then answers the second, still inside one turn.
- **A message sent after completion** starts a new turn, with that message's id as `turnId`.
- **Interrupt.** `droid.interrupt_session` during a turn ends it with `agent_turn_completed` `reason: "cancelled"`. The interrupt's response arrives after that notification. The next `add_user_message` runs a normal turn.
- **End of session.** Closing stdin ends the process with exit code 0, about a second later.

## Design

**Starting a steered job.** `task --steerable` keeps a job's Droid session open so it can be sent more messages. It needs `--background` (the session outlives the command that started it) and droid 1.1.0 or newer, and is offered for every sandbox: read-only, `--run-commands` and `--write`. It is opt-in; `mission` refuses `--steerable`, and the stop-time review gate never uses it. A resumed, forked or answered turn cannot reopen a session over the input protocol, so it runs as an ordinary one-shot turn.

**The child.** The background worker starts one `droid exec --input-format stream-jsonrpc --output-format stream-jsonrpc --cwd <repo>` and sends `droid.initialize_session` with the model, effort, autonomy and tool list a one-shot turn of the same sandbox would pass as flags: read-only is autonomy `off` over the read-only tools, `--run-commands` is autonomy `medium` over `Read`, `LS`, `Grep`, `Glob` and `Execute`, and `--write` is autonomy `medium` over droid's default toolset. The worker compares what it asked for with the `settings` droid echoes. A model or effort droid did not apply fails the job before any user turn. An autonomy or tool list droid did not apply lets the job run with the session's value and records a `steeringWarning` on the job naming what was ignored.

**The socket.** Once the session is ready, the worker listens on a unix socket and records its path as `socketPath` on the job. The path is `<jobs dir>/<jobId>.sock`, or `droid-<hash>.sock` in the temp dir when that would not fit in a socket path. Each line written to it is `{"text": "…"}` (the next user turn) or `{"end": true}`, and each is answered by one line, `{"ok": true}` or `{"ok": false, "error": "…"}`. The socket goes away when the job ends.

**Turns.** Each message becomes its own user turn. A message sent while a turn is running waits until that turn completes; droid would otherwise fold it into the running turn (see "Turns" above). The job's result is the last turn's answer, with the session's total token usage. A job with an output schema checks the last answer against it and repairs it once.

**Ending.** The session ends, and the job finishes, when a turn completes and nothing arrives for `DROID_STEER_IDLE_MS` milliseconds (default 120000), when `send <job> --end` is received (queued turns still run first), or when the job is cancelled. Cancel kills the droid child and its descendants and removes the socket.

**`send`.** `send <job|name> <message>` (or `--file <path>`, or `--end`) writes one line to the job's socket and prints `sent to <jobId>` once the worker accepts it. It exits 1 with the reason, writing nothing to droid, when the job is unknown, not running, awaiting an answer (use `answer`), not started with `--steerable`, or its socket is gone, and when the message is empty. If the job carries a `steeringWarning`, `send` repeats it on stderr and in `--json` output.

**Proof.** `tests/steering.test.mjs` covers the design against a fake droid. With `DROID_SMOKE=1` it also runs real droid on glm-5.3: a token sent to a steered job comes back as the job's result; a steered `--run-commands` job and a steered read-only job each refuse a request to `Create` a file, and leave none, while a steered `--write` job given the same request creates it; and the job records carry no `steeringWarning` for a fence this decision marks settable, or one naming each fence it marks not settable.

## Decision

All four settings (model, effort, autonomy and the tool list) can be set over JSON-RPC and are confirmed by droid, so a steered job keeps the same model, effort, autonomy and tool fence as a one-shot turn, provided the worker sends them in `droid.initialize_session` and checks the confirmation. Per the rollout decision, `--steerable` is opt-in, `mission` and the stop hook never use it, and no sandbox is refused.

Decision: GO
