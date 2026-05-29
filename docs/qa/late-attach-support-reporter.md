# Codex + Chrome QA: Late Attach Support Reporter

Use this task to test assigning a manager after a worker has already made
partial progress on a small CLI/reporting feature.

Shared protocol: [shared-codex-chrome-protocol.md](shared-codex-chrome-protocol.md)

## Scenario

- `LAB_SCENARIO=late-attach-support-reporter`
- Lab repo: `/Users/neonwatty/Desktop/workerctl-dispatch-lab`
- Expected worker focus: finish a support queue reporter CLI/reporting module
  after the worker has already started work without a manager.

## Start

```bash
cd /Users/neonwatty/Desktop/workerctl-dispatch-lab
LAB_SCENARIO=late-attach-support-reporter ./lab qa-start
```

Open the printed `DASHBOARD_URL` in Chrome. This scenario intentionally starts
the worker before the manager. After the worker shows visible partial progress,
attach the manager:

```bash
./lab attach-manager
```

## Expected Acceptance Criteria

- `.venv/bin/python -m pytest -q` passes in the lab repo.
- The manager is attached after worker progress exists and starts with concrete
  task/goal/worker context, not `<unbound-task>` placeholders.
- The reporter produces deterministic status counts, assignee backlog totals,
  severity totals, escalation lists, and a concise Markdown summary.
- Dashboard Dispatch conversation shows a worker receipt consumed by a manager
  cycle before `finish_task` succeeds.
- Cleanup can stop session-table worker and manager sessions after the task is
  done.

## Chrome Checks

- Dispatch banner shows active.
- Dispatcher id is visible and heartbeat is recent.
- Worker and manager sessions are visible for the printed task id.
- Relationship is active or observed after manager attach.
- Dispatch conversation lane shows `worker_task_complete`.
- The worker receipt includes `.venv/bin/python -m pytest -q` pass evidence.
- A manager cycle consumes the routed worker completion notification.
- `finish_task` succeeds only after manager-cycle consumption.
- Accepted criteria are satisfied.
- Task state becomes `done`.

## CLI Checks

Run cycles until completion after manager attach:

```bash
./lab cycle
```

Then audit:

```bash
/Users/neonwatty/Desktop/codex-terminal-manager/scripts/workerctl audit "$TASK" --json
/Users/neonwatty/Desktop/codex-terminal-manager/scripts/workerctl telemetry --actor dispatch --event-type dispatch_watch_heartbeat --newest --limit 1 --json
```

Required audit evidence:

- manager bootstrap/start evidence contains the real task name, goal, and worker
  name.
- `routed_notifications` contains `worker_task_complete`.
- `source_event_id` is present.
- `consumed_dispatch_notifications` is at least `1`.
- `consumed_manager_cycle_id` is present.
- `finish_task` succeeded after consumption.
- accepted criteria are satisfied.
- task state is `done`.

## Cleanup

```bash
./lab cleanup
LAB_SCENARIO=complex-refactor ./lab reset --force
git status --short
```

Report using [evidence-template.md](evidence-template.md).
