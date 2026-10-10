---
description: Cancel an active background Droid job in this repository
argument-hint: '[job-id]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/droid-companion.mjs" cancel "$ARGUMENTS"`
