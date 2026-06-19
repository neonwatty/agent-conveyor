---
name: conveyor-create-pair
description: Create one visible Codex app manager and one visible Codex app worker for the current project using the globally installed Agent Conveyor CLI.
---

# Conveyor Create Pair

Use this skill when the operator wants a Codex-app-only manager/worker pair
from any target project. This skill is operator-facing. Do not use tmux in this
tranche.

## Rules

- Treat the current working directory as the target project.
- Use `.codex-workers/workerctl.db` under the target project unless the
  operator explicitly gives another path.
- Verify `conveyor` is available before setup:
  `command -v conveyor && conveyor plugin-status --json`.
- If `conveyor` is missing or the plugin is stale, tell the operator:
  `npm install -g agent-conveyor && conveyor install-plugin`.
- Use native Codex app thread tools when available to create visible manager
  and worker threads.
- Do not inspect product code as part of pair setup.
- Generated manager and worker prompts must require visible session sections:
  `CONVEYOR POLL`, `CONVEYOR RECEIVED`, `WORK`, `CONVEYOR SEND`, and
  `DISPATCH`.

## Default Ledger

```bash
mkdir -p .codex-workers
LEDGER="$PWD/.codex-workers/workerctl.db"
```

## Operator Flow

1. Clarify the bounded task name only if the operator has not provided one.
2. Create one manager Codex app thread and one worker Codex app thread.
3. Run `conveyor create-disposable-binding` with the created thread ids and:
   `--path "$PWD/.codex-workers/workerctl.db" --json`.
4. Return the manager thread title/id, worker thread title/id, ledger path,
   task name, and exact status command:
   `TASK="example-task"; conveyor app-loop-status "$TASK" --path "$PWD/.codex-workers/workerctl.db" --json`.
