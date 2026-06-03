# Codex + Chrome QA: Simple Calculator

Use this task to run the smallest end-to-end dashboard Dispatch smoke test.

Shared protocol: [shared-codex-chrome-protocol.md](shared-codex-chrome-protocol.md)

## Scenario

- `LAB_SCENARIO=simple-calculator`
- Lab repo: `/Users/neonwatty/Desktop/workerctl-dispatch-lab`
- Expected worker focus: fix the calculator pytest with the smallest code
  change.

## Start

```bash
cd /Users/neonwatty/Desktop/workerctl-dispatch-lab
LAB_SCENARIO=simple-calculator ./lab qa-start
```

Open the printed `DASHBOARD_URL` in Chrome.

## Expected Acceptance Criteria

- `.venv/bin/python -m pytest -q` passes in the lab repo.
- `git diff` shows only the minimal calculator fix unless the worker explains
  otherwise.

Because this is the smallest smoke scenario, the manager config may not seed a
Dispatch-specific criterion. The QA pass still must verify Dispatch routing via
dashboard and `conveyor audit`.

## Chrome Checks

- Dispatch banner shows active.
- Worker and manager sessions are visible.
- Worker final receipt reports pytest passed.
- Dispatch lane shows `worker_task_complete`.
- The routed notification has a source event id.
- A manager cycle consumes the notification before `finish_task`.
- Task becomes `done`.

## CLI Checks

```bash
./lab cycle
conveyor audit "$TASK" --json
```

Required audit evidence:

- `signal_type` is `worker_task_complete`.
- `source_event_id` is present.
- `consumed_manager_cycle_id` is present.
- task state is `done`.

## Cleanup

```bash
./lab cleanup
LAB_SCENARIO=complex-refactor ./lab reset --force
git status --short
```

Report using [evidence-template.md](evidence-template.md).
