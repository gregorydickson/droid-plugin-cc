# Live steering (`send`): design note

Status: not built. `send <job> <message>` still reports that live steering is unavailable. This note records why, and what building it would take.

## How a job runs today

Each turn is one `droid exec` child: a fresh turn is a one-shot `--output-format stream-jsonrpc` exec, and a continued turn (resume, answer, schema repair) is a one-shot `--output-format stream-json` exec with `--session-id`. The child's stdin is `ignore`. The prompt goes in through `-f <file>`, and the turn ends when Droid emits its completion event. The detached worker (`task-worker`) owns that child and exposes nothing to other processes except the job record on disk.

## What steering needs

Droid supports multi-turn input with `--input-format stream-jsonrpc` (or `stream-json`). Forwarding a `send` into a running job would need three things:

1. **A different transport for the child.** The child has to be started with `--input-format stream-jsonrpc` and stdin kept open, and the worker has to send the initial prompt and every later message as JSON-RPC requests. With `--input-format stream-jsonrpc`, droid ignores `-m`, `--auto`, `-r`, `--only-tools`, `--add-tools`, `--remove-tools`, `--session-id` and `--tag` (it validates them and warns on stderr; see droid 0.251.0 `exec --help`). The permission limit (read-only toolset, `--run-commands`, `--write` autonomy) and the model and effort would therefore have to be re-established through JSON-RPC session-settings requests. That request schema is not documented in `exec --help` and has not been verified against the live CLI. Until it is, steered jobs could run without the read-only limit, which this plugin treats as a hard rule.
2. **A channel into the detached worker.** `send` runs as a separate CLI process. It would need a per-job endpoint, for example a unix socket under the job's state directory, that the worker listens on. That endpoint needs ownership checks, cleanup when the job ends, and a way to deal with workers that started before the endpoint existed and so have none.
3. **Turn and completion semantics.** A steered session has several turns inside one job. Usage accounting (session-inclusive totals), changed-file segments, schema validation and repair, pause-and-ask, cancellation and the "job completed" transition all assume one turn per child today. Each of these needs a rule for the case where a `send` arrives mid-turn, after completion, or during a schema repair.

## Why it was not built in this change

Items 1 and 2 together are a transport redesign, not a contained change. The parts that are a security risk (the permission limit carried over JSON-RPC) depend on a protocol surface that has not been verified. The current way to steer a job is cancel-and-resume (`cancel`, then `sessions resume NAME PROMPT` or `task --resume-last`). It keeps every limit, because each resumed turn is a new one-shot exec where the CLI flags apply.

## What to verify before building it

- Capture a live `--input-format stream-jsonrpc` session and record the requests that set autonomy, the tool allow-list, model and reasoning effort, and the response that confirms them.
- Check that a session started this way refuses a non-read-only command when the read-only settings are sent over JSON-RPC, the way the current one-shot read-only fence does.
- Only then add the worker socket, and a `send` command that fails closed when the job has no socket or is not running.
