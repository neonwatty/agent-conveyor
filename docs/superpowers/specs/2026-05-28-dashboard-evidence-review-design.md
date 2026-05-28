# Dashboard Evidence Review QA Scenario Design

## Purpose

Create a new repeatable QA lab scenario named `dashboard-evidence-review`.
The scenario should stress the manager-worker-Dispatch supervision loop in a
domain that mirrors the actual dashboard QA work, instead of another generic
business workflow.

The goal is to prove that the system handles a realistic multi-turn closeout:
the worker first fixes evidence-summarization behavior, the manager verifies the
implementation, then the manager deliberately asks "what's next?" before the
task can close.

## Scenario Shape

The worker fixes a small Python module that summarizes `workerctl audit`-shaped
JSON fixtures. The fixtures should resemble real dashboard/Dispatch evidence:

- routed `worker_task_complete` notifications
- source event IDs
- consumed manager cycle IDs
- worker receipt text
- acceptance criteria statuses
- `finish_task` commands
- task state before and after completion
- relationship evidence that may need to be recovered after the live binding is
  gone

The scenario should be small enough to reset quickly, but realistic enough that
the worker must reason about Dispatch evidence rather than only changing one
line.

## Files

Add scenario files under the lab repo:

- `scenarios/dashboard-evidence-review/files/fixtures/before_finish.json`
- `scenarios/dashboard-evidence-review/files/fixtures/after_finish.json`
- `scenarios/dashboard-evidence-review/files/src/dispatch_lab/dashboard_evidence.py`
- `scenarios/dashboard-evidence-review/files/tests/test_dashboard_evidence.py`

Add QA documentation in the product repo:

- `docs/qa/dashboard-evidence-review.md`
- update `docs/qa/README.md`

Update the lab runner so `LAB_SCENARIO=dashboard-evidence-review` can reset and
start the scenario.

## Failing Behaviors

The intentionally broken implementation should fail tests for these behaviors:

- It cannot recover worker/manager relationship evidence after the task is done
  and the active binding is no longer discoverable.
- It miscounts acceptance criteria, especially `satisfied` vs open `accepted`
  criteria.
- It treats `finish_task` as if it were proof of worker completion.
- It does not require a routed notification to be consumed by a manager cycle.
- It allows finish evidence even when `finish_task` happened before manager
  consumption of the routed worker completion.

## Acceptance Criteria

The manager configuration for this scenario should seed criteria equivalent to:

- `.venv/bin/python -m pytest -q` passes in the lab repo.
- The evidence summary distinguishes worker completion, manager consumption,
  criteria state, relationship recovery, and finish ordering.
- The diff is focused on the dashboard evidence implementation and fixtures.
- Dashboard Dispatch conversation shows worker completion routed to a manager
  cycle before `finish_task` succeeds.
- After implementation evidence is accepted, the manager sends a post-completion
  "what's next?" nudge and receives a worker reply with separate `Verification
  evidence` and `Product / QA risks` sections.

The final criterion is intentionally behavioral. It should not require hidden
code work. It verifies that the manager performs a realistic post-implementation
review instead of closing immediately after tests pass.

## Expected QA Flow

1. Operator runs `LAB_SCENARIO=dashboard-evidence-review ./lab qa-start`.
2. Dashboard opens for the printed task URL.
3. Worker fixes the evidence summarizer and reports test/diff evidence.
4. Dispatch routes the worker completion as `worker_task_complete`.
5. Manager consumes the routed notification and marks the implementation
   criteria satisfied when the receipt is sufficient.
6. Manager nudges the worker with a "what's next?" question.
7. Worker responds with two clearly separated sections:
   - `Verification evidence`
   - `Product / QA risks`
8. Manager marks the post-completion review criterion satisfied.
9. `./lab cycle` auto-finishes through `finish-task --require-criteria-audit`.
10. Dashboard shows:
    - Dispatch active
    - worker completion routed notification
    - manager cycle consumption
    - relationship evidence
    - all criteria satisfied
    - successful `finish_task`
    - task state `done`

## Dashboard Pass Bar

The QA report should prefer dashboard evidence over CLI audit. CLI audit is a
debug fallback, not the primary proof.

The dashboard must visibly prove:

- relationship state is not `none` for the requested task
- Dispatch core is active
- at least one `worker_task_complete` notification is visible
- source event and routed notification evidence are visible
- a manager cycle consumed the routed notification
- criteria reach `0 open`
- `finish_task` appears only after the manager-consumed worker completion
- task reaches `done`

## Error Handling

If the manager tries to finish before the "what's next" reply, the criteria
audit should keep the task open because the post-completion review criterion is
still accepted/open.

If the worker volunteers "what's next" content in the first receipt, the manager
may use it only if it is clearly separated into the required sections. Otherwise
the manager should nudge for the structured reply.

If Dispatch routes multiple worker receipts, the dashboard and audit evidence
should make the latest relevant receipt clear enough for the QA report.

## Testing

Implementation should include:

- Python fixture tests for the evidence summarizer.
- Existing product dashboard tests for binding/criteria/Dispatch display should
  keep passing.
- A live QA smoke of `LAB_SCENARIO=dashboard-evidence-review ./lab qa-start`
  through completion.
- Cleanup/reset verification that the lab returns to a known baseline.

## Out of Scope

- Hidden tests or artificial second-stage code changes.
- Changing production dashboard behavior unless the scenario reveals a real
  dashboard bug.
- Requiring the worker to edit production `workerctl` code during the lab run.
- Requiring screenshots as the only evidence source.
