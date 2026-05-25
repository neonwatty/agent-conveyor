# Dispatch Loop Lab Design

## Goal

Create a resettable sibling repository for manual QA of the real
worker/manager/Dispatch loop through the dashboard. The lab should let us run
the same experiment repeatedly without using the product repository as the
worker's edit target.

The lab repository will live at:

```text
/Users/neonwatty/Desktop/workerctl-dispatch-lab
```

## Scope

The first version is intentionally small. It proves one complete real
integration loop:

1. Reset the lab to a known failing baseline.
2. Start a real `workerctl pair` with real tmux/Codex sessions.
3. Start or view the dashboard with Dispatch ensured.
4. Have the worker fix a tiny failing pytest.
5. Have the manager verify the test and inspect evidence.
6. Confirm Dispatch appears active and useful in the dashboard.
7. Clean up and reset for another run.

Out of scope for the first version:

- Multiple scenarios.
- Synthetic/fake Dispatch simulation.
- A large harness or long-lived service.
- Product-code changes beyond what is necessary to run the lab.

## Lab Project

The lab repository will be a tiny Python project:

```text
workerctl-dispatch-lab/
  README.md
  lab
  pyproject.toml
  src/dispatch_lab/calculator.py
  tests/test_calculator.py
```

The committed baseline intentionally contains one failing pytest. The worker's
job is to repair the implementation. The manager's job is to verify the fix
with pytest and record useful evidence.

The default test should be simple enough that failures are obvious, for
example:

```python
def test_adds_two_numbers():
    assert add(2, 3) == 5
```

with an intentionally wrong implementation in `calculator.py`.

## Lab Script

The `lab` executable is the operator interface. It should be plain and easy to
read. Required commands:

- `./lab reset` resets the repo to the failing baseline and removes run
  artifacts created by the lab.
- `./lab start` starts a real `workerctl pair` for a unique run.
- `./lab dashboard` starts `workerctl dashboard --ensure-dispatch` for the
  active lab task.
- `./lab cycle` runs one manager cycle for the active task.
- `./lab status` prints the active run id, task, worker, manager, dashboard
  URL, and useful `workerctl` status commands.
- `./lab cleanup` stops lab sessions and reconciles local workerctl state.

The script should store the active run metadata in a small ignored file such as
`.lab/run.env`.

## Naming

Each run gets unique, readable names:

```text
run:     dispatch-lab-YYYYMMDD-HHMMSS
task:    dispatch-lab-YYYYMMDD-HHMMSS
worker:  dispatch-lab-YYYYMMDD-HHMMSS-worker
manager: dispatch-lab-YYYYMMDD-HHMMSS-manager
```

The dispatcher id for dashboard QA should be:

```text
qa-dispatch-dashboard
```

## Worker And Manager Instructions

`./lab start` should seed the pair with a small task goal:

- Worker fixes the failing pytest in the lab repo.
- Worker should run pytest before claiming completion.
- Manager should verify pytest passes, inspect the diff, and only accept
  evidence-backed completion.

The manager mode should be strict enough to catch superficial worker claims but
not so elaborate that each run becomes slow.

## Dashboard Expectations

The dashboard is the visual confirmation surface. During the lab, it should
show:

- Dispatch core banner is active.
- Dispatcher id is visible.
- Heartbeat age, iteration, processed count, and live/dry-run state are visible.
- Worker/manager terminals are clean for the current run.
- Dispatch conversation lane shows routed completion and manager-cycle evidence
  after the worker completes and the manager cycles.
- Stale or missing Dispatch is visually obvious.

## Reset Behavior

`./lab reset` should make repeated experiments boring:

- Return the lab repo to the failing baseline.
- Remove `.lab/` run metadata and test caches.
- Avoid touching the product repository.
- Leave previous workerctl records inspectable unless `./lab cleanup` is used.

`./lab cleanup` should be the command that mutates workerctl runtime state:

- Stop lab worker/manager sessions where possible.
- Run reconcile to mark stale/dead lab sessions gone.
- Print remaining active sessions if cleanup is incomplete.

## Verification

The lab is ready when we can complete this sequence twice:

```bash
./lab reset
./lab start
./lab dashboard
./lab cycle
# worker fixes test through the real session
./lab cycle
./lab status
./lab cleanup
./lab reset
```

Success means:

- `pytest` starts failing after reset.
- The worker can make it pass.
- The manager sees and verifies the evidence.
- Dispatch is active without a separate manual Dispatch command.
- The dashboard shows useful Dispatch routing evidence.
- A second reset returns to the original failing state.

## Risks

- Real Codex sessions are slower and less deterministic than a simulation.
- Cleanup may leave stale workerctl records if tmux sessions die unexpectedly.
- The dashboard depends on local browser and extension health for visual QA.

These risks are acceptable because the purpose of the lab is to test the real
integration loop, not a mocked substitute.
