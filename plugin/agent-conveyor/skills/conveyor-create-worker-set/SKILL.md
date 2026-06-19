---
name: conveyor-create-worker-set
description: Create one visible Codex app manager and multiple visible Codex app workers for the current project using Agent Conveyor.
---

# Conveyor Create Worker Set

Use this skill when the operator wants one Codex app manager supervising
multiple Codex app workers. This skill creates the set and bindings; it does
not run a campaign, Ralph loop, ship-it loop, or tmux workflow.

## Rules

- Operator-facing only.
- Codex app native sessions only.
- Use the current working directory as the target project.
- Use `.codex-workers/workerctl.db` under the target project by default.
- Create concise worker role names when the operator does not provide them.
- Do not inspect product code during setup.

## Default Ledger

```bash
mkdir -p .codex-workers
LEDGER="$PWD/.codex-workers/workerctl.db"
```

## Operator Flow

1. Determine worker count and role labels.
2. Create one manager Codex app thread.
3. Create one worker Codex app thread per role.
4. For each worker role, create one Conveyor task and app-session binding:

```bash
TASK="example-worker-role-task"
WORKER_NAME="example-worker-role"
WORKER_THREAD_ID="created-worker-thread-id"
WORKER_THREAD_TITLE="Created Worker Thread"
MANAGER_NAME="example-manager"
MANAGER_THREAD_ID="created-manager-thread-id"
MANAGER_THREAD_TITLE="Created Manager Thread"
conveyor create-disposable-binding "$TASK" \
  --worker "$WORKER_NAME" \
  --manager "$MANAGER_NAME" \
  --worker-codex-app-thread-id "$WORKER_THREAD_ID" \
  --worker-codex-app-thread-title "$WORKER_THREAD_TITLE" \
  --manager-codex-app-thread-id "$MANAGER_THREAD_ID" \
  --manager-codex-app-thread-title "$MANAGER_THREAD_TITLE" \
  --path "$LEDGER" \
  --json
```

5. Return a setup receipt listing every task, worker role, thread id/title,
   manager thread id/title, ledger path, and status command.
