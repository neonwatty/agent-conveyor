# Shared Codex + Chrome Protocol

Use this protocol from any scenario-specific QA task.

## Preconditions

- Product repo: `/Users/neonwatty/Desktop/codex-terminal-manager`
- Lab repo: `/Users/neonwatty/Desktop/workerctl-dispatch-lab`
- Chrome automation is available to Codex.
- The operator wants Codex to drive the dashboard, not only run CLI commands.
- Both repos should start clean unless the task explicitly says otherwise.

## Setup

```bash
cd /Users/neonwatty/Desktop/codex-terminal-manager
git status --branch --short

cd /Users/neonwatty/Desktop/workerctl-dispatch-lab
git status --branch --short
```

If either repo has unexpected dirty files, stop and report them before starting
a destructive lab reset.

## Start The Run

From the lab repo:

```bash
LAB_SCENARIO=<scenario> ./lab qa-start
```

Capture:

- `RUN_ID`
- `TASK`
- `WORKER`
- `MANAGER`
- `DASHBOARD_URL`

Open `DASHBOARD_URL` in Chrome.

## Browser Inspection Loop

In Chrome, inspect the dashboard after each cycle.

Expected dashboard signals:

- Dispatch banner is active.
- Dispatcher id is visible.
- Heartbeat is recent.
- Worker and manager sessions are visible.
- Dispatch conversation lane is present.
- `worker_task_complete` appears after the worker finishes.
- The worker receipt includes test evidence.
- The manager cycle consumes the routed notification.
- `finish_task` appears only after manager-cycle consumption.
- Task state becomes `done`.

If the dashboard does not show enough detail, use CLI audit as the source of
truth and report the visual gap as a product follow-up.

## Cycle Loop

Run cycles from the lab repo:

```bash
./lab cycle
```

After each cycle:

1. Inspect Chrome for new Dispatch and task state evidence.
2. If worker is still busy and making progress, wait.
3. If worker completed, run one more cycle so the manager can consume the routed
   notification.
4. If criteria are not satisfied, continue observing or request a fix through
   the manager path.

Do not finish the QA run until Dispatch consumption is proven.

## Audit Commands

Use these after the worker completes:

```bash
./lab status
conveyor audit "$TASK" --json
conveyor telemetry --actor dispatch --event-type dispatch_watch_heartbeat --newest --limit 1 --json
```

The audit must show:

- `routed_notifications` with `signal_type: worker_task_complete`
- a `source_event_id`
- `consumed_manager_cycle_id`
- a successful `finish_task` command after consumption
- task state `done`
- criteria summary with no open accepted criteria

## Cleanup

Always clean up after the run:

```bash
./lab cleanup
LAB_SCENARIO=complex-refactor ./lab reset --force
git status --short
```

If the scenario is expected to leave implementation changes for inspection, do
not reset without operator approval.
