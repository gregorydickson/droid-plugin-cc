---
description: Check the local Droid CLI and optionally toggle the stop-time review gate
argument-hint: '[--enable-review-gate|--disable-review-gate]'
allowed-tools: Bash(node:*)
---

Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/droid-companion.mjs" setup --json $ARGUMENTS` and present the output.
If Droid is missing, direct the user to https://docs.factory.ai/cli/getting-started/overview.
Setup checks the executable; authentication is verified on execution. Authenticate using `/login` in the interactive Droid CLI or `FACTORY_API_KEY`. Do not modify Factory settings.
