---
description: Check the local Droid CLI and optionally toggle the stop-time review gate
argument-hint: '[--enable-review-gate|--disable-review-gate] [--default-model <id>] [--default-effort <level>] [--clear-default-model]'
allowed-tools: Bash(node:*)
---

Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/droid-companion.mjs" setup --json $ARGUMENTS` and present the output.
If Droid is missing, direct the user to https://docs.factory.ai/cli/getting-started/overview.
Setup runs `droid doctor` and reports it as "host Droid health". `loggedIn` is true or false when doctor reported an auth check, and `verified` says whether it did; otherwise `loggedIn` is null and `verified` is false. Authenticate using `/login` in the interactive Droid CLI or `FACTORY_API_KEY`. Do not modify Factory settings.
Defaults:
- `--default-model <id>` and `--default-effort <level>` store the model and effort that `task`, `review` and `adversarial-review` use when `--model`/`--effort` are omitted. For glm-5.3, whose default effort is `max`, suggest `--default-effort high`.
- `--clear-default-model` removes the stored default model. It cannot be combined with `--default-model`.
- Defaults apply to all workspaces using this plugin data dir.
