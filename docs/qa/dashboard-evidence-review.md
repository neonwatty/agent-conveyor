# Codex + Chrome QA: Dashboard Evidence Review

Use this task to run the dashboard evidence review Dispatch QA test.

Shared protocol: [shared-codex-chrome-protocol.md](shared-codex-chrome-protocol.md)

## Scenario

- `LAB_SCENARIO=dashboard-evidence-review`
- Lab repo: `/Users/neonwatty/Desktop/workerctl-dispatch-lab`
- Expected worker focus: summarize dashboard evidence for realistic
  `workerctl audit`-shaped fixtures, including worker completion, manager
  consumption, criteria state, relationship recovery, and finish ordering.

## Start

```bash
cd /Users/neonwatty/Desktop/workerctl-dispatch-lab
LAB_SCENARIO=dashboard-evidence-review ./lab qa-start
```

Open the printed `DASHBOARD_URL` in Chrome.

## Expected Acceptance Criteria

- `.venv/bin/python -m pytest -q` passes in the lab repo.
- The summary distinguishes worker completion, manager consumption, criteria
  state, relationship recovery, and finish ordering.
- `git diff` is focused on the implementation and fixtures for dashboard
  evidence review, and avoids broad unrelated rewrites.
- Dashboard Dispatch conversation shows a worker receipt consumed by a manager
  cycle before `finish_task` succeeds.
- The manager sends a what-next nudge, and the later worker reply has separate
  `Verification evidence` and `Product / QA risks` sections.

## Chrome Checks

- Dispatch banner shows active.
- Relationship state is visible and is not `none`.
- Worker receipt includes `.venv/bin/python -m pytest -q` pass evidence.
- Dispatch conversation lane shows `worker_task_complete`.
- A manager cycle consumes the routed worker completion notification.
- A later what-next worker receipt is visible after the manager nudge.
- The what-next worker receipt includes separate `Verification evidence` and
  `Product / QA risks` sections.
- All accepted criteria are satisfied.
- `finish_task` succeeds only after manager consumption and what-next review.
- Task state becomes `done`.

## CLI Checks

Run cycles until completion:

```bash
./lab cycle
```

Then audit:

```bash
/Users/neonwatty/Desktop/codex-terminal-manager/scripts/workerctl audit "$TASK" --json
/Users/neonwatty/Desktop/codex-terminal-manager/scripts/workerctl telemetry --actor dispatch --event-type dispatch_watch_heartbeat --newest --limit 1 --json
```

Required audit evidence:

- `routed_notifications` contains `worker_task_complete`.
- `source_event_id` is present.
- relationship state is present and is not `none`.
- `consumed_dispatch_notifications` is at least `1`.
- `consumed_manager_cycle_id` is present.
- manager cycle consumption happens before `finish_task`.
- `finish_task` command state is `succeeded`, with command id recorded.
- what-next manager nudge is present.
- later worker receipt includes separate `Verification evidence` and
  `Product / QA risks` sections.
- all accepted criteria are satisfied.
- task state is `done`.

## Cleanup

```bash
./lab cleanup
LAB_SCENARIO=complex-refactor ./lab reset --force
git status --short
```

Report using [evidence-template.md](evidence-template.md).
