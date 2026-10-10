---
description: Explain the supported summary-based handoff to Droid
argument-hint: "[--source <claude-jsonl>]"
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/droid-companion.mjs" transfer "$ARGUMENTS"`

Present the error as returned. Native transcript import is unavailable; suggest /droid:rescue with a summary or a worker with --brief/--preread.
