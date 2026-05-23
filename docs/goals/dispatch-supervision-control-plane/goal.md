# Dispatch Supervision Control Plane

## Objective

Implement the planned supervision-control improvements from GitHub issues #113-#117 in a safe, sequenced way: structured permissions, acknowledgement records, dispatch completion routing, epilogue gates, and the dual "what's next" review loop.

## Original Request

"I've added some additional issues related to this one. Can you pull all of them and let's take a look at them to talk about implementation?" followed by "make a detailed plan using $goalbuddy:goal-prep".

## Intake Summary

- Input shape: `existing_plan`
- Audience: the `workerctl` operator and future manager/worker supervision runs
- Authority: `requested`
- Proof type: `test`
- Completion proof: issues #113-#117 are implemented or explicitly split with receipts, tests pass, and a final audit maps the resulting behavior back to the issues' acceptance criteria.
- Goal oracle: run focused `workerctl` unit/CLI tests plus a final source-backed audit that checks each issue acceptance criterion against implemented behavior, schema, CLI, replay/audit visibility, and safety boundaries.
- Likely misfire: treating the issue set as a planning/doc task, or implementing the broad Dispatch queue/watch model before the lower-risk config, ack, and completion-routing foundations exist.
- Blind spots considered: schema migration compatibility, flat-permission backwards compatibility, non-idempotent tmux side effects, dispatch accidentally making manager decisions, subagent-review anchoring, expensive model-pass defaults, and dashboard/replay chains without `correlation_id`.
- Existing plan facts: preserve issues #113-#117; prefer sequencing #115 -> #114 -> #113 Phase 1 -> #116 minimal -> #117 -> later #113 queue/watch phases; keep `dispatch` as the role name; Phase 1 Dispatch reads `codex_events` and routes completion only; use `correlation_id` from the start.

## Goal Oracle

The oracle for this goal is:

`A final Judge/PM audit shows that implemented code, migrations, CLI behavior, tests, and replay/audit surfaces satisfy the accepted tranche of issues #113-#117 without violating Dispatch's no-judgment boundary.`

The PM must keep comparing task receipts to this oracle. Planning, discovery, a passing tiny slice, or a clean-looking board is not enough. The goal finishes only when a final Judge/PM audit maps receipts and verification back to this oracle and records `full_outcome_complete: true`.

## Goal Kind

`existing_plan`

## Current Tranche

The tranche is to turn the issue cluster into working `workerctl` behavior in dependency order. The preferred first implementation path is:

1. Add categorized permissions and tool declarations to `manager-config` while preserving legacy aliases.
2. Add worker/manager acknowledgement persistence and context exposure.
3. Add Dispatch Phase 1 completion routing from `codex_events` to manager notification with dedupe and correlation.
4. Add a minimal epilogue framework with durable run state and finish gating.
5. Add the dual "what's next" persistence/review flow only after the permission and epilogue foundations exist.
6. Defer full Dispatch command claiming, `nudge_worker` actuation, and watch mode until the completion-router and epilogue flows create real queue pressure.

## Non-Negotiable Constraints

- Do not let Dispatch decide task success, acceptance criteria, strategy, PR merging, final task state, or manager decisions.
- Preserve backwards compatibility for existing flat manager permissions and existing direct nudge behavior during migration.
- Keep tmux side effects conservative and explicitly audited; do not blindly retry non-idempotent sends.
- Use `correlation_id` as a first-class chain field for dispatch, epilogue, continuations, and related telemetry/audit rows.
- Prefer additive schema changes and compatibility helpers before destructive migrations or renames.
- Keep human/operator-facing notifications out of Dispatch; create or defer a separate notifier/operator-channel concept if needed.
- Do not start with a generalized plugin framework for epilogues.
- Keep the GoalBuddy board as the execution truth; GitHub issues are source requirements, not board state.

## Stop Rule

Stop only when a final audit proves the full original outcome is complete.

Do not stop after planning, discovery, or Judge selection if the user asked for working software or automation and a safe Worker task can be activated.

Do not stop after a single verified Worker package when the broader owner outcome still has safe local follow-up work. Advance the board to the next highest-leverage safe Worker package and continue unless a phase, risk, rejected-verification, ambiguity, or final-completion review is due.

Do not create one Worker/Judge pair per repeated file, table, route, or helper. Put repeated same-shape work into one Worker package and review the package as a whole.

Do not stop because a slice needs owner input, credentials, production access, destructive operations, or policy decisions. Mark that exact slice blocked with a receipt, create the smallest safe follow-up or workaround task, and continue all local, non-destructive work that can still move the goal toward the full outcome.

## Slice Sizing

Safe means bounded, explicit, verified, and reversible. It does not mean tiny.

A good task is the largest safe useful slice.

Small is not the goal. Useful is the goal.

A Worker should finish the whole assigned slice. A Judge should judge the whole assigned slice. A PM should reorient the board when tasks are safe but not moving the outcome.

Tiny tasks are allowed when the failure is isolated, the risk is high, the scope is unknown, or the tiny task unlocks a larger slice. Tiny tasks are bad when they keep happening, do not change behavior, only add wrappers/contracts/proof files, or avoid the real milestone.

Do not stop because a slice needs owner input, credentials, production access, destructive operations, or policy decisions. Mark that exact slice blocked with a receipt, create the smallest safe follow-up or workaround task, and continue.

## Canonical Board

Machine truth lives at:

`docs/goals/dispatch-supervision-control-plane/state.yaml`

If this charter and `state.yaml` disagree, `state.yaml` wins for task status, active task, receipts, verification freshness, and completion truth.

## Run Command

```text
/goal Follow docs/goals/dispatch-supervision-control-plane/goal.md.
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
