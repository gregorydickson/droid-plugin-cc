---
description: List the Factory models this Droid CLI offers, with each model's supported reasoning efforts
argument-hint: '[--json]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/droid-companion.mjs" models "$ARGUMENTS"`

Present the full command output to the user as a Markdown table. Do not drop rows or summarize it.
- Preserve the model IDs exactly; they are the values `--model` accepts.
- Keep the CLI default model and any plugin defaults (`DROID_DEFAULT_MODEL`, `DROID_DEFAULT_EFFORT`) shown above the table.
- Reasoning efforts vary per model; a model marked "not supported" ignores `--effort`.
