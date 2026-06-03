# Codex + Chrome QA: Subscription Billing

Use this task to run the subscription billing dashboard Dispatch QA test.

Shared protocol: [shared-codex-chrome-protocol.md](shared-codex-chrome-protocol.md)

## Scenario

- `LAB_SCENARIO=subscription-billing`
- Lab repo: `/Users/neonwatty/Desktop/workerctl-dispatch-lab`
- Expected worker focus: fix subscription billing behavior for plan pricing,
  seats, credits/refunds, proration, entitlement windows, and audit summaries.

## Start

```bash
cd /Users/neonwatty/Desktop/workerctl-dispatch-lab
LAB_SCENARIO=subscription-billing ./lab qa-start
```

Open the printed `DASHBOARD_URL` in Chrome.

## Expected Acceptance Criteria

- `.venv/bin/python -m pytest -q` passes in the lab repo.
- The fix handles plan pricing, seat quantities, prorated upgrades,
  credits/refunds, entitlement windows, and manager-verifiable audit summary
  fields.
- `git diff` is focused on the subscription billing implementation and avoids
  broad unrelated rewrites.
- Dashboard Dispatch conversation shows a worker receipt consumed by a manager
  cycle before `finish_task` succeeds.

## Chrome Checks

- Dispatch banner shows active.
- Dispatcher id is visible and heartbeat is recent.
- Worker and manager sessions are visible for the printed task id.
- Dispatch conversation lane shows `worker_task_complete`.
- The worker receipt includes `.venv/bin/python -m pytest -q` pass evidence.
- The receipt lists billing behavior evidence for pricing, seats,
  credits/refunds, proration, entitlement end, and audit summary fields.
- A manager cycle consumes the routed worker completion notification.
- `finish_task` succeeds only after that manager-cycle consumption.
- All four accepted criteria are satisfied.
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

- `routed_notifications` contains `worker_task_complete`.
- `source_event_id` is present.
- `consumed_dispatch_notifications` is at least `1`.
- `consumed_manager_cycle_id` is present.
- `finish_task` succeeded after consumption.
- all four accepted criteria are satisfied.
- task state is `done`.

## Known Good Reference

The first successful subscription-billing QA run recorded:

- run id: `dispatch-lab-20260528-040313`
- source event id: `3940`
- routed notification id: `21`
- manager cycle id: `261`
- accepted criteria satisfied: `4`
- worker pytest evidence: `6 passed in 0.01s`
- lab scenario commit: `de91847`

Do not reuse these values as proof for a new run. They are only a reference for
what the evidence shape should look like.

## Cleanup

```bash
./lab cleanup
LAB_SCENARIO=complex-refactor ./lab reset --force
git status --short
```

Report using [evidence-template.md](evidence-template.md).
