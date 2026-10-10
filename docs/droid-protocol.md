# Droid protocol used by this plugin

Probed locally on 2026-10-10 with Droid `0.238.0`; messages advertised Factory API `1.0.0`, protocol `1.257.0`.

## Chosen transport

One `droid exec --output-format stream-jsonrpc --cwd DIR -f PROMPT_FILE` child per turn. No `--input-format`: this is the CLI's one-shot RPC-output mode. Unlike controlled RPC sessions, this mode applies CLI `-m`, `-r`, and `--session-id`. The local probe confirmed `-m gpt-6-luna -r low` in emitted settings. Help documents `--session-id` and `--auto medium`; successful authenticated resume remains unverified by these unauthenticated probes; fake transport tests cover the flag mapping.

The child streams newline-delimited JSON objects. The adapter never parses human-readable stdout. Session history persists in Droid; the plugin stores the session ID for the next child, so a shared process/broker is unnecessary. Cancellation terminates the child's process group. The existing git-worktree selection and recovery machinery stays in the plugin.

## Observed messages

All examples omit telemetry metadata and unrelated fields.

```json
{"jsonrpc":"2.0","type":"response","factoryApiVersion":"1.0.0","factoryProtocolVersion":"1.257.0","id":"request-id","result":{"sessionId":"uuid","settings":{"modelId":"gpt-6-luna","reasoningEffort":"low"}}}
{"jsonrpc":"2.0","type":"notification","method":"droid.session_notification","params":{"sessionId":"uuid","notification":{"type":"droid_working_state_changed","newState":"thinking"}}}
{"jsonrpc":"2.0","type":"notification","method":"droid.session_notification","params":{"sessionId":"uuid","notification":{"type":"error","message":"No access token available","errorType":"Error"}}}
{"jsonrpc":"2.0","type":"notification","method":"droid.session_notification","params":{"sessionId":"uuid","notification":{"type":"agent_turn_completed","reason":"model_authentication_failed","turnId":"uuid","tokenUsage":{"inputTokens":0,"outputTokens":0,"cacheCreationTokens":0,"cacheReadTokens":0,"thinkingTokens":0,"factoryCredits":0}}}}
```

Also observed `settings_updated`, `mcp_status_changed`, and `create_message` notifications. An idle notification alone is not completion. Authentication failure produced a completion event, so completion alone is not success either.

The installed binary's protocol schema defines `assistant_text_delta` with `messageId`, `blockIndex`, and `textDelta`; `assistant_message_retracted` removes a message. The adapter assembles the latest root-session assistant message, orders its text blocks, and ignores child-session notifications. `agent_turn_completed.reason == "completed"` plus process exit 0 is required for success. Its `tokenUsage` is per-turn; cumulative usage is not charged again on resume. These successful text/usage paths are exercised by the fake binary; no authenticated model response was obtained in this sandbox.

Malformed JSON, RPC errors, model errors, missing session ID/completion, and nonzero exit fail visibly. Unknown notifications are ignored. Raw stdout is never treated as the answer.

## Probes and limits

Ran both `droid --help` and `droid exec --help`, a tiny `stream-json` prompt, a tiny one-shot `stream-jsonrpc` prompt, and controlled RPC initialization. Generic `initialize` requests were rejected. Controlled RPC accepted `droid.initialize_session` only with the Factory envelope (`type`, API/protocol versions, string id) and `machineId`/`cwd` params. Controlled mode requires request-level settings; its CLI flags do not configure the session. ACP was attempted but not adopted.

Normal execution hit sandbox EPERM writing Droid logs. Probes then used `FACTORY_HOME_OVERRIDE` pointing inside the checkout; no user settings were changed. Initialization succeeded there, but authentication was unavailable. The opt-in smoke test consequently cannot establish authenticated completion here. Run `DROID_SMOKE=1 npm test` in an authenticated environment with normal runtime-directory access.

One-shot initialization reported `autonomyLevel: low` without `--auto`. To preserve the plugin's read-only contract, those calls additionally use `--only-tools Read,LS,Grep,Glob`; host-collected diffs remove the need for git shell execution. Write jobs pass `--auto medium`. No unsafe-permission flag is used.

This adapter uses prompt-level schema instructions and local Ajv validation with one read-only repair retry. The CLI help exposes no schema flag. The installed controlled-RPC schema does include `structuredOutputFormat`; the plugin does not depend on that unverified enforcement path.

Reference: [Factory headless execution documentation](https://docs.factory.com/droid-exec/overview). Local observations above take precedence where help, documentation, and runtime behavior differ.
