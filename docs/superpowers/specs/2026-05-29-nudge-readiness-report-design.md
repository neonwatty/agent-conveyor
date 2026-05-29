# Nudge Readiness Report QA Scenario Design

## Purpose

Add a focused manual QA scenario that proves the manager can ask a worker
"What's next?" after implementation evidence is available, receive a structured
worker-side assessment, compare it with the manager-side assessment, and finish
only after that comparison is auditable in the dashboard and backend audit.

The scenario stays within the current lab organization:

- Product QA runbook:
  `docs/qa/nudge-readiness-report.md`
- Lab fixture:
  `/Users/neonwatty/Desktop/workerctl-dispatch-lab/scenarios/nudge-readiness-report/files`
- Lab entry point:
  `LAB_SCENARIO=nudge-readiness-report ./lab qa-start`

## Scenario Shape

The lab fixture is a small release readiness reporter. The worker receives a
failing pytest suite for a compact Python module and CLI-style reporting surface.
The intended behavior is deterministic and manager-verifiable:

- group release checks into verified, unverified, and blocked buckets
- compute a risk level from blockers, missing verification, and severity
- produce a recommended next action
- emit a concise text or Markdown report that a manager can inspect

The worker fixes the implementation, runs `.venv/bin/python -m pytest -q`,
inspects the diff, and sends an implementation receipt. The manager must not
finish immediately after the first passing receipt. Instead, it sends a
post-implementation "What's next?" nudge asking for the worker's independent
next-step/risk assessment.

The worker reply must use separate sections:

- `Verification evidence`
- `Worker next-step assessment`
- `Product / QA risks`

The manager then compares the worker-side assessment against its own view of
the acceptance criteria and visible evidence before finishing.

## Acceptance Criteria

The new QA run should require these accepted criteria:

1. `.venv/bin/python -m pytest -q` passes in the lab repo.
2. The readiness reporter produces deterministic blockers, verified checks,
   unverified checks, risk level, and recommended next action.
3. The implementation diff is focused on the readiness reporter fixture.
4. Dashboard Dispatch conversation shows a worker implementation receipt
   consumed by a manager cycle before any finish attempt succeeds.
5. After implementation evidence is accepted, the manager sends a "What's next?"
   nudge and receives a later worker reply with separate `Verification evidence`,
   `Worker next-step assessment`, and `Product / QA risks` sections.
6. The manager records or communicates a comparison between the worker-side
   assessment and the manager-side assessment before `finish_task` succeeds.

## Dashboard Evidence

The product runbook should require visual dashboard evidence, not only pane
text:

- Dispatch core is active.
- Relationship state is active or observed.
- The first `worker_task_complete` notification contains implementation/test
  evidence.
- A manager cycle consumes the first routed worker completion.
- A manager nudge appears after the implementation receipt is consumed.
- A later worker reply appears after the nudge and includes the three required
  sections.
- A later manager cycle consumes the worker's post-nudge reply.
- The manager-side comparison is visible in manager output, dashboard receipt
  text, or audit evidence.
- Accepted criteria close before finish.
- `finish_task` succeeds only after the post-nudge reply and manager comparison
  are consumed.
- Task state becomes `done`.

## Backend Audit Evidence

The CLI audit checks should require:

- at least two `worker_task_complete` routed notifications, one for
  implementation evidence and one for post-nudge review evidence
- `source_event_id` and `consumed_manager_cycle_id` on routed notifications
- consumed manager cycle for the implementation receipt before the nudge
- consumed manager cycle for the post-nudge receipt before `finish_task`
- an audit-visible nudge command or manager nudge event between those receipts
- accepted criteria summary with no open accepted criteria
- succeeded `finish_task` command after the comparison evidence
- final task state `done`

## Lab Implementation Plan

The lab change should follow existing scenario patterns:

- add `scenarios/nudge-readiness-report/files/src/dispatch_lab/readiness.py`
- add `scenarios/nudge-readiness-report/files/src/dispatch_lab/__init__.py`
- add `scenarios/nudge-readiness-report/files/tests/test_readiness.py`
- update `lab` scenario validation/start case with task prompt, manager
  objective, and acceptance criteria
- update lab `README.md` with scenario usage

The worker prompt should explicitly say not to include a what-next review unless
the manager asks for it. That preserves the ordering proof: implementation
receipt first, manager nudge second, worker review third, manager comparison
fourth, finish last.

## Product Documentation Plan

Add `docs/qa/nudge-readiness-report.md` mirroring the existing QA runbooks. It
should include:

- scenario name and start command
- expected acceptance criteria
- Chrome/dashboard checks
- CLI audit checks
- failure capture checklist
- cleanup command and reset recommendation

Update `docs/qa/README.md` to list the scenario as the dedicated nudge
comparison QA run.

## Risks And Guardrails

- If the worker includes the next-step assessment in the first receipt, the run
  is less useful. The prompt should forbid that unless nudged.
- If the manager finishes immediately after test evidence, the run should fail
  because it did not prove post-implementation nudge comparison.
- If dashboard text hides the post-nudge receipt, the backend audit may still be
  correct, but the QA result should record a dashboard visibility gap.
- If only one routed completion exists, the scenario did not exercise the
  comparison path.

## Success Definition

This design is successful when a live QA run can show, in both dashboard and
audit evidence, that the manager:

1. consumed implementation evidence,
2. asked "What's next?",
3. received a structured worker-side review,
4. compared that review to manager-side evidence, and
5. finished only after that comparison was consumed and accepted criteria were
   closed.
