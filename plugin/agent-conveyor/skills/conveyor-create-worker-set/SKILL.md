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
- After binding each worker task and before sending any real work prompt, run
  `conveyor-smoke-app-connections` in required mode for every worker task. The
  set passes only when every required worker smoke passes. If any smoke fails,
  do not send real task prompts to any worker; return exact blockers and repair
  actions.
- Tell the operator to use `conveyor-app-wake-relay` for stale app threads;
  only Dispatch inboxes and Conveyor receipts are durable task truth.

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

5. Run `conveyor-smoke-app-connections` once per worker task. Aggregate the
   resulting `app-smoke status` receipts. Required smoke must pass for every
   worker before the real task starts.
6. Return a setup receipt listing every task, worker role, thread id/title,
   manager thread id/title, ledger path, smoke id/status, and status command.
