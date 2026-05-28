# Codex + Chrome QA: Support Triage

Use this task to run the support-ticket triage dashboard Dispatch QA test.

Shared protocol: [shared-codex-chrome-protocol.md](shared-codex-chrome-protocol.md)

## Scenario

- `LAB_SCENARIO=support-triage`
- Lab repo: `/Users/neonwatty/Desktop/workerctl-dispatch-lab`
- Expected worker focus: fix severity aliases, escalation, routing, SLA dates,
  and manager-facing summary evidence.

## Start

```bash
cd /Users/neonwatty/Desktop/workerctl-dispatch-lab
LAB_SCENARIO=support-triage ./lab qa-start
```

Open the printed `DASHBOARD_URL` in Chrome.

## Expected Acceptance Criteria

- `.venv/bin/python -m pytest -q` passes in the lab repo.
- The fix handles severity aliases, enterprise escalation, team routing,
  business-day SLA dates, and manager-verifiable summary evidence.
- `git diff` is focused on the support triage implementation and avoids broad
  unrelated rewrites.
- Dashboard Dispatch conversation shows a worker receipt consumed by a manager
  cycle before `finish_task` succeeds.

## Chrome Checks

- Dispatch banner shows active.
- Dispatch conversation lane is visible.
- Worker receipt includes final pytest pass evidence.
- Dispatch lane shows `worker_task_complete`.
- Source event id is visible, or available in CLI audit.
- Manager cycle consumes the routed completion.
- Criteria satisfaction happens before or during final manager decision.
- `finish_task` succeeds after manager-cycle consumption.
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

- `signal_type` is `worker_task_complete`.
- `source_event_id` is present.
- `consumed_manager_cycle_id` is present.
- `finish_task` succeeded after consumption.
- all four accepted criteria are satisfied.
- task state is `done`.

## Cleanup

```bash
./lab cleanup
LAB_SCENARIO=complex-refactor ./lab reset --force
git status --short
```

Report using [evidence-template.md](evidence-template.md).
