---
name: conveyor-check-status
description: Check Agent Conveyor manager/worker or worker-set status from the current project's per-project ledger.
---

# Conveyor Check Status

Use this skill when the operator asks for the status of an Agent Conveyor pair
or worker set from any project.

## Rules

- Operator-facing only.
- Codex app native sessions only.
- Use `.codex-workers/workerctl.db` under the current project unless the
  operator explicitly provides another path.
- Do not inspect product code or private content.
- Treat ledger claims as claims unless backed by durable receipts.
- Prefer compact status receipts with exact next action.
- If a role is stale and app thread metadata is present, recommend the
  `conveyor-app-wake-relay` skill rather than an ad hoc direct prompt.

## Commands

For a known task:

```bash
TASK="example-task"
conveyor app-loop-status "$TASK" --path "$PWD/.codex-workers/workerctl.db" --json
conveyor app-autopilot status "$TASK" --path "$PWD/.codex-workers/workerctl.db" --json
```

For an unknown task, list candidate records first:

```bash
conveyor tasks --path "$PWD/.codex-workers/workerctl.db" --json
```

Report manager and worker thread ids/titles, stale roles, inbox backlog,
heartbeat/autopilot state, dispatch health, and the exact next action.
