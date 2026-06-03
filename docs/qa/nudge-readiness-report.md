# Codex + Chrome QA: Nudge Readiness Report

Use this task to test the manager's post-implementation "What's next?" nudge,
the worker-side next-step assessment, and the manager-side comparison before
finish.

Shared protocol: [shared-codex-chrome-protocol.md](shared-codex-chrome-protocol.md)

## Scenario

- `LAB_SCENARIO=nudge-readiness-report`
- Lab repo: `/Users/neonwatty/Desktop/workerctl-dispatch-lab`
- Expected worker focus: finish a release readiness reporter that summarizes
  blockers, verified checks, unverified checks, risk level, and recommended
  next action.

## Start

```bash
cd /Users/neonwatty/Desktop/workerctl-dispatch-lab
LAB_SCENARIO=nudge-readiness-report ./lab qa-start
```

Open the printed `DASHBOARD_URL` in Chrome.

## Expected Acceptance Criteria

- `.venv/bin/python -m pytest -q` passes in the lab repo.
- The readiness reporter produces deterministic blockers, verified checks,
  unverified checks, risk level, and recommended next action.
- `git diff` is focused on the readiness reporter fixture.
- Dashboard Dispatch conversation shows a worker implementation receipt
  consumed by a manager cycle before `finish_task` succeeds.
- After implementation evidence is accepted, the manager sends a what-next
  nudge and receives a worker reply with separate `Verification evidence`,
  `Worker next-step assessment`, and `Product / QA risks` sections.
- The manager compares the worker-side assessment against manager-side evidence
  before `finish_task` succeeds.

## Chrome Checks

- Dispatch banner shows active.
- Relationship state is visible and is not `none`.
- First worker receipt includes `.venv/bin/python -m pytest -q` pass evidence.
- Dispatch conversation lane shows the first `worker_task_complete`.
- A manager cycle consumes the first routed worker completion notification.
- A later manager what-next nudge is visible after implementation evidence is
  consumed.
- A later worker receipt is visible after the nudge.
- The later worker receipt includes separate `Verification evidence`,
  `Worker next-step assessment`, and `Product / QA risks` sections.
- A later manager cycle consumes the post-nudge worker receipt.
- Manager comparison between worker-side and manager-side assessment is visible
  in manager output, dashboard receipt text, or audit evidence.
- All accepted criteria are satisfied.
- `finish_task` succeeds only after post-nudge receipt consumption and manager
  comparison.
- Task state becomes `done`.

## CLI Checks

Run cycles until completion:

```bash
./lab cycle
```

Then audit:

```bash
conveyor audit "$TASK" --json
conveyor telemetry --actor dispatch --event-type dispatch_watch_heartbeat --newest --limit 1 --json
```

Required audit evidence:

- `routed_notifications` contains at least two `worker_task_complete` entries.
- The first completion contains implementation/test evidence.
- The later completion contains the post-nudge worker review sections.
- Both relevant completions include `source_event_id`.
- Both relevant completions include `consumed_manager_cycle_id`.
- The manager nudge event or nudge command appears between the implementation
  receipt and the post-nudge worker receipt.
- The post-nudge receipt is consumed before `finish_task`.
- Manager comparison evidence appears before `finish_task`.
- All accepted criteria are satisfied.
- `finish_task` command state is `succeeded`, with command id recorded.
- Task state is `done`.

## Failure Capture

If the run fails, capture:

- run id
- dashboard URL
- relevant `./lab cycle` output
- `conveyor audit "$TASK" --json` summary
- dashboard visible state
- exact missing or wrong behavior

## Cleanup

```bash
./lab cleanup
LAB_SCENARIO=complex-refactor ./lab reset --force
git status --short
```

Report using [evidence-template.md](evidence-template.md).
