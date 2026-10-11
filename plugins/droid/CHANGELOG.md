# Changelog

## 0.1.1

Fix: a continued turn (`sessions resume`, `answer`, `--resume-last`, schema repair) no longer passes `--session-id` with one-shot `--output-format stream-jsonrpc`, which droid rejects. Continued turns stream `--output-format stream-json`, where `--auto`, `--only-tools`, `-m` and `-r` still apply.

## 0.1.0

Initial Factory Droid port: one child per job, JSON-RPC streaming output, local schema validation and repair, durable job controls, worktree jobs, and Claude Code hooks.
