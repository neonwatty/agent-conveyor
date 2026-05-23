# Dispatch Gap Closure

## Objective

Close the remaining dispatch-supervision gaps found after the issue audit: implement or deliberately defer the follow-up issues and rough edges that still affect operator triage, classifier precision, manager acceptance criteria seeding, dispatch watch ergonomics, command observability, continuation-review evidence, and dashboard/replay usability.

## Original Request

"make a detailed plan using $goalbuddy:goal-prep based on your gap findings"

## Intake Summary

- Input shape: `audit`
- Audience: `workerctl` operators, manager/worker pair users, and future GoalBuddy-driven supervision runs
- Authority: `requested`
- Proof type: `test`
- Completion proof: open follow-up issues #127, #128, and #129 are fixed or explicitly superseded; known rough edges are implemented or recorded as scoped follow-up decisions; full verification passes; and a final audit maps evidence back to the gap findings.
- Goal oracle: a final source-backed audit proving each named gap has either shipped behavior with tests/docs or an intentional follow-up issue with rationale and owner-visible acceptance criteria.
- Likely misfire: adding more dispatch features while leaving the operator-facing gaps unclosed, or declaring completion because the original dispatch issues are closed even though the newer dogfood findings remain open.
- Blind spots considered: dispatch may accidentally gain judgment authority, telemetry scoping could hide real failures, command-queue ergonomics could create unbounded watch runs, classifier fixes could regress real approval prompts, continuation-review hard isolation may exceed the safe local scope, and dashboard grouping may require a separate UI tranche.
- Existing plan facts: previous audits found the core dispatch issues implemented and merged; remaining open repo issues are #127, #128, and #129; additional rough edges include unbounded public dispatch watch mode, fixed command lease duration, duplicate notify-manager result key, weak command-attempt visibility, continuation-review telemetry/isolation limits, and dashboard correlation-chain grouping still called out as a follow-up.

## Goal Oracle

The oracle for this goal is:

`A final Judge/PM audit shows that issues #127, #128, and #129 plus the named dispatch rough edges are either implemented with focused tests and docs or intentionally deferred into explicit follow-up artifacts, without weakening Dispatch's no-judgment boundary.`

The PM must keep comparing task receipts to this oracle. Planning, discovery, a passing tiny slice, or a closed old issue is not enough. The goal finishes only when a final Judge/PM audit maps receipts and verification back to this oracle and records `full_outcome_complete: true`.

## Goal Kind

`audit`

## Current Tranche

The tranche is gap closure after the main dispatch rollout. The preferred execution path is:

1. Reconcile the audit findings against current code and issues #127, #128, and #129 without editing implementation files.
2. Have Judge choose the first safe parallelizable work set and pin exact file ownership for Workers.
3. Implement #129 so `pair` can seed the acceptance criteria ledger from manager acceptance configuration.
4. Implement #128 so pane classification distinguishes active approval prompts from historical transcript mentions.
5. Implement #127 so telemetry failures can be scoped by recency, active task, run, or equivalent operator triage filter.
6. Implement the small dispatch CLI/observability polish that is clearly local and low risk: bounded watch runs, configurable lease if warranted, duplicate result-key cleanup, and command-attempt visibility.
7. Make a Judge decision on continuation-review hard isolation and structured telemetry: implement the safe evidence improvement now, and create a follow-up only for hard isolation if it exceeds local safe scope.
8. Scout dashboard/replay correlation-chain grouping, then either implement the smallest usable grouping slice or create a precise follow-up issue if it belongs in a larger UI tranche.
9. Run full verification and close/update GitHub issues only after evidence is present.

## Non-Negotiable Constraints

- Do not let Dispatch decide task success, strategy, merge readiness, acceptance criteria truth, or manager decisions.
- Preserve backwards compatibility for direct nudge/session commands and existing dispatch queue behavior.
- Keep telemetry free of raw prompt/transcript content unless it is already an intentional existing audit surface.
- Prefer focused vertical slices with tests over broad refactors.
- Keep issue #127, #128, and #129 acceptance criteria traceable in receipts and commit/PR text.
- Do not declare completion merely because the older dispatch-related issues are closed.
- If hard isolation for continuation review is unsafe or too broad locally, record a decision and create a follow-up rather than faking isolation.
- Keep the GoalBuddy board as the execution truth; GitHub issues and PRs are supporting artifacts.

## Stop Rule

Stop only when a final audit proves the full original outcome is complete.

Do not stop after planning, discovery, or Judge selection if a safe Worker task can be activated.

Do not stop after a single verified Worker package when the broader owner outcome still has safe local follow-up work. Advance the board to the next highest-leverage safe Worker package and continue unless a phase, risk, rejected-verification, ambiguity, or final-completion review is due.

Do not create one Worker/Judge pair per repeated file, table, route, or helper. Put repeated same-shape work into one Worker package and review the package as a whole.

Do not stop because a slice needs owner input, credentials, production access, destructive operations, or policy decisions. Mark that exact slice blocked with a receipt, create the smallest safe follow-up or workaround task, and continue all local, non-destructive work that can still move the goal toward the full outcome.

## Slice Sizing

Safe means bounded, explicit, verified, and reversible. It does not mean tiny.

A good task is the largest safe useful slice.

Small is not the goal. Useful is the goal.

A Worker should finish the whole assigned slice. A Judge should judge the whole assigned slice. A PM should reorient the board when tasks are safe but not moving the outcome.

Tiny tasks are allowed when the failure is isolated, the risk is high, the scope is unknown, or the tiny task unlocks a larger slice. Tiny tasks are bad when they keep happening, do not change behavior, only add wrappers/contracts/proof files, or avoid the real milestone.

## Canonical Board

Machine truth lives at:

`docs/goals/dispatch-gap-closure/state.yaml`

If this charter and `state.yaml` disagree, `state.yaml` wins for task status, active task, receipts, verification freshness, and completion truth.

## Run Command

```text
/goal Follow docs/goals/dispatch-gap-closure/goal.md.
```

## PM Loop

On every `/goal` continuation:

1. Read this charter.
2. Read `state.yaml`.
3. Run the bundled GoalBuddy update checker when available and mention a newer version without blocking.
4. Re-check the intake: original request, input shape, authority, proof, blind spots, existing plan facts, and likely misfire.
5. Work only on the active board task.
6. Assign Scout, Judge, Worker, or PM according to the task.
7. Write a compact task receipt.
8. Update the board.
9. If safe local work remains, choose the next largest reversible Worker package and continue unless blocked.
10. If a problem, suggestion, or follow-up should become a repo artifact, create an approved issue/PR or ask the operator whether to create one.
11. Review at phase, risk, rejected-verification, ambiguity, or final-completion boundaries; do not review every small Worker by habit.
12. Finish only with a Judge/PM audit receipt that maps receipts and verification back to the original user outcome and records `full_outcome_complete: true`.

Issue and PR handoffs are supporting artifacts. `state.yaml` remains authoritative, and every external artifact decision must be recorded in a task receipt.
