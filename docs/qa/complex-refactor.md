# Codex + Chrome QA: Complex Refactor

Use this task to run the order-pricing multi-rule dashboard Dispatch QA test.

Shared protocol: [shared-codex-chrome-protocol.md](shared-codex-chrome-protocol.md)

## Scenario

- `LAB_SCENARIO=complex-refactor`
- Lab repo: `/Users/neonwatty/Desktop/workerctl-dispatch-lab`
- Expected worker focus: fix order pricing behavior while keeping the diff
  focused.

## Start

```bash
cd /Users/neonwatty/Desktop/workerctl-dispatch-lab
LAB_SCENARIO=complex-refactor ./lab qa-start
```

Open the printed `DASHBOARD_URL` in Chrome.

## Expected Acceptance Criteria

- `.venv/bin/python -m pytest -q` passes in the lab repo.
- The fix handles quantity-aware subtotals, normalized coupon codes, free
  standard shipping after discount, and taxable subtotal discounting.
- `git diff` is focused on the order-pricing implementation/tests and avoids
  broad unrelated rewrites.

The dashboard QA pass must additionally prove Dispatch routing even if the
manager criteria do not explicitly include a Dispatch criterion.

## Chrome Checks

- Dispatch banner shows active for the run.
- Worker and manager panes are registered to the task.
- Worker receipt includes final pytest pass evidence.
- Dispatch lane shows `worker_task_complete`.
- Source event id and routed notification id are visible, or available in CLI
  audit if the dashboard omits one.
- Manager cycle consumes the routed worker completion.
- `finish_task` succeeds only after the consumed manager cycle.
- All accepted criteria are satisfied.
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
- `consumed_dispatch_notifications` is at least `1`.
- `consumed_manager_cycle_id` is present.
- criteria summary has no open accepted criteria.
- task state is `done`.

## Cleanup

```bash
./lab cleanup
LAB_SCENARIO=complex-refactor ./lab reset --force
git status --short
```

Report using [evidence-template.md](evidence-template.md).
