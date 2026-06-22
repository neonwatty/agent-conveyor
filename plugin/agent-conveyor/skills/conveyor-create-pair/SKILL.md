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
- After binding and before sending any real work prompt, run the
  `conveyor-smoke-app-connections` skill in required mode. If smoke fails, do
  not send the real task prompt; return the exact smoke blockers and repair
  action.
- After required smoke passes, start app-autopilot before sending real work:
  `conveyor app-autopilot start "$TASK" --dispatcher-id dispatch-local --path "$LEDGER" --json`.
  Apply the emitted Codex app automation specs when automation tools are
  available. If they are unavailable, report the pair as `manual-poll only`
  and include the manager/worker heartbeat prompts.
- Do not report a created pair as autonomous unless required smoke passed,
  `app-autopilot start` succeeded, and automation specs were either applied or
  explicitly deferred by the operator.
- Tell the operator to use `conveyor-app-wake-relay` for stale app threads;
  direct app-thread prompts are wake prompts only, not durable task truth.

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
4. Run `conveyor-smoke-app-connections` for the created task. Required smoke
   must pass before the real task starts, and the smoke skill must start
   app-autopilot before returning `real_work_allowed=true` as actionable.
5. If automation tools are available, create the manager and worker heartbeat
   automations from the `app-autopilot start` output. If automation tools are
   not available, return the automation specs and mark the setup
   `manual-poll only`.
6. Return the manager thread title/id, worker thread title/id, ledger path,
   task name, and exact status command:
   `TASK="example-task"; conveyor app-loop-status "$TASK" --path "$PWD/.codex-workers/workerctl.db" --json`.
   Include `app-autopilot status` and whether heartbeat automation specs were
   applied, deferred, or blocked.
