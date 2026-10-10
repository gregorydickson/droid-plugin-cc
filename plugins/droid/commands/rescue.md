---
description: Delegate investigation, an explicit fix request, or follow-up rescue work to the Droid rescue subagent
argument-hint: "[--background|--wait] [--resume|--fresh] [--write] [--model <model>] [--effort <none|minimal|low|medium|high|xhigh>] [what Droid should investigate, solve, or continue]"
allowed-tools: Bash(node:*), AskUserQuestion, Agent
---

Invoke the `droid:droid-rescue` subagent via the `Agent` tool (`subagent_type: "droid:droid-rescue"`), forwarding the raw user request as the prompt.
`droid:droid-rescue` is a subagent, not a skill — do not call `Skill(droid:droid-rescue)` (no such skill) or `Skill(droid:rescue)` (that re-enters this command and hangs the session). The command runs inline so the `Agent` tool stays in scope; forked general-purpose subagents do not expose it.
The final user-visible response must be Droid's output verbatim.

Raw user request:
$ARGUMENTS

Execution mode:

- If the request includes `--background`, run the `droid:droid-rescue` subagent in the background.
- If the request includes `--wait`, run the `droid:droid-rescue` subagent in the foreground.
- If neither flag is present, default to foreground.
- `--background` and `--wait` are execution flags for Claude Code. Do not forward them to `task`, and do not treat them as part of the natural-language task text.
- `--model` and `--effort` are runtime-selection flags. Preserve them for the forwarded `task` call, but do not treat them as part of the natural-language task text.
- If the request includes `--resume`, do not ask whether to continue. The user already chose.
- If the request includes `--fresh`, do not ask whether to continue. The user already chose.
- Otherwise, before starting Droid, check for a resumable rescue thread from this Claude session by running:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/droid-companion.mjs" task-resume-candidate --json
```

- If that helper reports `available: true`, use `AskUserQuestion` exactly once to ask whether to continue the current Droid thread or start a new one.
- The two choices must be:
  - `Continue current Droid thread`
  - `Start a new Droid thread`
- If the user is clearly giving a follow-up instruction such as "continue", "keep going", "resume", "apply the top fix", or "dig deeper", put `Continue current Droid thread (Recommended)` first.
- Otherwise put `Start a new Droid thread (Recommended)` first.
- If the user chooses continue, add `--resume` before routing to the subagent.
- If the user chooses a new thread, add `--fresh` before routing to the subagent.
- If the helper reports `available: false`, do not ask. Route normally.

Operating rules:

- The subagent is a thin forwarder only. It should use one `Bash` call to invoke `node "${CLAUDE_PLUGIN_ROOT}/scripts/droid-companion.mjs" task ...` and return that command's stdout as-is.
- Return the Droid companion stdout verbatim to the user.
- Do not paraphrase, summarize, rewrite, or add commentary before or after it.
- Do not ask the subagent to inspect files, monitor progress, poll `/droid:status`, fetch `/droid:result`, call `/droid:cancel`, summarize output, or do follow-up work of its own.
- Leave `--effort` unset unless the user explicitly asks for a specific reasoning effort.
- Leave `--resume` and `--fresh` in the forwarded request. The subagent handles that routing when it builds the `task` command.
- If the helper reports that Droid is missing or unauthenticated, stop and tell the user to run `/droid:setup`.
- If the user did not supply a request, ask what Droid should investigate or fix.

Default to read-only. Preserve an explicit `--write` flag; the runtime maps it to Factory `--auto medium`. Model IDs pass through unchanged.
