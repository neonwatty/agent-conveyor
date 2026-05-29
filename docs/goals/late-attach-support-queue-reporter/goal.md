# Late-Attach Support Queue Reporter

## Objective

Run a measured late-manager-attach dogfood experiment using a small standalone Python CLI repo. The experiment should prove that a manager can be assigned after a worker has already started a feature task, recover context, manage through Dispatch, require evidence, and finish only after auditable completion routing is consumed.

## Original Request

Cook up a small CLI/reporting feature task, likely in an associated repo, that can start in a worker session and later have a manager attached for trustworthy management.

## Intake Summary

- Input shape: `specific`
- Audience: the operator validating workerctl manager/dispatcher trust behavior
- Authority: `approved`
- Proof type: `demo`
- Completion proof: a completed late-attach run with support-reporter tests passing, dashboard evidence visible, worker completion routed and consumed by the manager, accepted criteria closed, `finish_task` succeeded after consumption, and cleanup/reset leaving repos clean.
- Goal oracle: live support-reporter verification plus `workerctl audit` and dashboard evidence for the late-attach manager run.
- Likely misfire: building a pleasant toy CLI while failing to prove the manager actually attached midstream, consumed Dispatch evidence, and made a trustworthy finish decision.
- Blind spots considered: manager might accept pane text without audit proof, the worker might finish before manager attachment, criteria might be too vague to audit, or cleanup might leave stale sessions.
- Existing plan facts: use Python + pytest, a half-built support queue reporter, a standalone repo, a late manager attachment, Dispatch/dashboard inspection, and measurable acceptance criteria.

## Goal Oracle

The oracle for this goal is:

`A late-attach workerctl run where the support queue reporter feature is completed with passing tests and scoped changes, and the dashboard plus workerctl audit prove manager attachment after worker progress, Dispatch active, worker_task_complete routed with source_event_id, manager-cycle consumption before finish_task, no open accepted criteria, task done, and clean cleanup.`

The PM must keep comparing task receipts to this oracle. Planning, scaffolding, a passing CLI test suite, or a clean-looking dashboard is not enough by itself. The goal finishes only when a final Judge/PM audit maps receipts and verification back to this oracle and records `full_outcome_complete: true`.

## Goal Kind

`specific`

## Current Tranche

Create the standalone support reporter repo, start a worker on the feature before management is attached, attach a strict manager after observable worker progress, drive the managed loop to completion, and capture the dashboard/audit evidence needed to judge whether late attachment is trustworthy.

## Non-Negotiable Constraints

- Keep the support-reporter task small: Python CLI, pytest, fixture data, no external services.
- The worker must begin before the manager is attached.
- The manager must recover context from durable evidence, not from private assumptions.
- Worker interaction after manager attachment must go through audited workerctl/Dispatch paths.
- Pane text alone is insufficient; dashboard and/or `workerctl audit` must prove routing and finish ordering.
- The task must not finish until accepted criteria are closed and the manager has consumed the routed `worker_task_complete` notification.
- Cleanup must stop current-run sessions and leave the relevant repos in a clear git state.

## Support Reporter Feature Acceptance

The standalone repo should exercise a small but meaningful feature:

- `support-report` reads support tickets from JSON.
- It reports counts by severity and status.
- It identifies SLA-risk tickets using documented rules.
- It summarizes team/owner routing.
- It lists unresolved blockers or escalation reasons.
- It emits deterministic manager-useful output.
- Tests cover edge cases such as missing owner, blocked escalations, mixed status, and stable ordering.

## Late-Attach Acceptance

The dogfood run passes only when evidence shows:

- the worker had observable progress before manager attachment;
- the manager was registered/bound after that progress;
- the manager established or confirmed measurable criteria;
- Dispatch core was active and relationship state was visible or auditable;
- `worker_task_complete` was routed with a `source_event_id`;
- a manager cycle consumed the routed notification;
- `finish_task` succeeded only after that consumption;
- accepted criteria were all satisfied;
- the task reached `done`;
- cleanup left no current-run tmux/dashboard leftovers.

## Stop Rule

Stop only when a final audit proves the full original outcome is complete.

Do not stop after scaffolding the repo, starting the worker, attaching the manager, or seeing tests pass. Those are intermediate receipts. The goal is complete only when the late-attach trust chain has been proven.

## Canonical Board

Machine truth lives at:

`docs/goals/late-attach-support-queue-reporter/state.yaml`

If this charter and `state.yaml` disagree, `state.yaml` wins for task status, active task, receipts, verification freshness, and completion truth.

## Run Command

```text
/goal Follow docs/goals/late-attach-support-queue-reporter/goal.md.
```

