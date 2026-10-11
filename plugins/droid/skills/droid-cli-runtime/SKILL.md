---
name: droid-cli-runtime
description: Internal helper contract for calling the droid-companion runtime from Claude Code
user-invocable: false
---

# Droid Runtime

Use this skill only inside the `droid:droid-rescue` subagent.

Primary helper:
- `node "${CLAUDE_PLUGIN_ROOT}/scripts/droid-companion.mjs" task "<raw arguments>"`

Execution rules:
- The rescue subagent is a forwarder, not an orchestrator. Its only job is to invoke `task` once and return that stdout unchanged.
- Prefer the helper over hand-rolled `git`, direct Droid CLI strings, or any other Bash activity.
- Do not call `setup`, `review`, `adversarial-review`, `status`, `result`, or `cancel` from `droid:droid-rescue`.
- Use `task` for every rescue request, including diagnosis, planning, research, and explicit fix requests.
- You may use the `droid-prompting` skill to rewrite the user's request into a tighter Droid prompt before the single `task` call.
- That prompt drafting is the only Claude-side work allowed. Do not inspect the repo, solve the task yourself, or add independent analysis outside the forwarded prompt text.
- Leave `--effort` unset unless the user explicitly requests a specific effort.
- Leave model unset by default. Add `--model` only when the user explicitly asks for one.
- Default to read-only. Add `--write` only when the user explicitly requests modifications.

Command selection:
- Use exactly one `task` invocation per rescue handoff.
- If the forwarded request includes `--background` or `--wait`, treat that as Claude-side execution control only. Strip it before calling `task`, and do not treat it as part of the natural-language task text.
- If the forwarded request includes `--effort`, pass it through to `task`.
- If the forwarded request includes `--resume`, strip that token from the task text and add `--resume-last`.
- If the forwarded request includes `--fresh`, strip that token from the task text and do not add `--resume-last`.
- `--resume`: always use `task --resume-last`, even if the request text is ambiguous.
- `--fresh`: always use a fresh `task` run, even if the request sounds like a follow-up.
- `--effort`: accepted values are `none`, `minimal`, `low`, `medium`, `high`, `xhigh`.
- `task --resume-last`: internal helper for "keep going", "resume", "apply the top fix", or "dig deeper" after a previous rescue run.

Safety rules:
- Default to read-only; enable writes only with explicit authorization.
- Preserve the user's task text as-is apart from stripping routing flags.
- Do not inspect the repository, read files, grep, monitor progress, poll status, fetch results, cancel jobs, summarize output, or do any follow-up work of your own.
- Return the stdout of the `task` command exactly as-is.
- If the Bash call fails or Droid cannot be invoked, report the error in one line.

Runtime mapping: read-only jobs omit `--auto` and restrict tools to `Read,LS,Grep,Glob,Execute`. `--write` maps to `droid exec --auto medium`, which permits local development operations beyond file edits. `--model` maps to `-m`, `--effort` maps to `-r`; model IDs pass through without aliases. `--resume-last` uses the session ID stored with the previous job as `--session-id`. No settings files are changed. Each job owns one process group; cancellation terminates that group.

Verified on Droid 0.238.0: without `--auto`, read-only autonomy allows `git log` and `git show HEAD:a.txt` through Execute. `touch b.txt` aborts the whole run with "Exec ended early: insufficient permission to proceed" and writes nothing. Repair turns use this same fence. `--auto medium` is an autonomy policy, not a filesystem sandbox; fence writes in the forwarded prompt and check changedFiles.
