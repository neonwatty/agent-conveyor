# Dogfood Reliability Ladder

## Objective

Turn the dogfood reliability ladder into an executable, receipt-driven GoalBuddy
tranche that improves confidence in `codex-terminal-manager` before using it on
meaningful supervised project work.

## Original Request

Use `$goalbuddy:goal-prep` to drive development from
`docs/superpowers/plans/2026-05-16-dogfood-reliability-ladder.md`, with
verifiable acceptance criteria for each step.

## Intake Summary

- Input shape: `existing_plan`
- Audience: Jeremy and future manager/worker dogfood runs.
- Authority: `requested`
- Proof type: `artifact`
- Completion proof: A GoalBuddy board exists with task receipts that either run
  the first dogfood gates or implement the missing helpers needed to make those
  gates mechanically verifiable.
- Likely misfire: GoalBuddy could execute isolated commands or produce more
  planning while failing to prove manager-led nudging, progressive disclosure,
  emergent acceptance criteria, replay/export evidence, and guardrail behavior.
- Blind spots considered: whether to run live pair QA first or build missing QA
  helpers first; whether the current untracked plan should be committed before
  live QA; whether manager behavior needs separate Judge review from control
  plane checks.
- Existing plan facts:
  `docs/superpowers/plans/2026-05-16-dogfood-reliability-ladder.md` defines the
  product thesis under test, required evidence bundle, global stop conditions,
  reusable postflight invariants, ten QA scenarios, promotion gates, and a
  reliability backlog.

## Goal Kind

`existing_plan`

## Current Tranche

Run the next live dogfood gate: Scenario 1 status-only pair QA and the
deterministic/manager-led portions of Scenario 2 emergent criteria QA. The
tranche should use the now-implemented `criteria-plan` helper, preserve an
evidence bundle, update `docs/live-qa-log.md`, and stop before meaningful
project work, unattended management, destructive cleanup, or unapproved
compact/clear behavior.

## Non-Negotiable Constraints

- Preserve and validate the existing dogfood reliability ladder instead of
  rediscovering the product direction from scratch.
- Do not use this app for meaningful project work until the appropriate
  promotion gates are passed.
- Keep writes bounded to explicit GoalBuddy tasks.
- Require durable receipts for every completed, blocked, or deferred task.
- Treat manager-led behavior and deterministic control-plane behavior as
  separate proof dimensions.
- Avoid destructive actions, unattended management, auto-merge, and unapproved
  compact/clear flows.

## Stop Rule

Stop only when a final audit proves the current tranche has produced live
Scenario 1/2 evidence and either unlocks the next dogfood promotion gate or
records exactly what live QA failure, tool limitation, or missing helper blocks
it.

Do not stop after planning, discovery, or Judge selection if a safe Worker or PM
task can be activated.

Do not mark the full dogfood reliability effort complete merely because one
scenario or helper passes. Continue through the highest-leverage safe next slice
until the current tranche is audited.

## Slice Sizing

Safe means bounded, explicit, verified, and reversible. It does not mean tiny.

A good task should either make the dogfood plan more executable, run a complete
QA scenario with evidence, or implement a helper that makes future scenarios
more mechanically checkable.

## Canonical Board

Machine truth lives at:

`docs/goals/dogfood-reliability-ladder/state.yaml`

If this charter and `state.yaml` disagree, `state.yaml` wins for task status,
active task, receipts, verification freshness, and completion truth.

## Run Command

```text
/goal Follow docs/goals/dogfood-reliability-ladder/goal.md.
```

## PM Loop

On every `/goal` continuation:

1. Read this charter.
2. Read `state.yaml`.
3. Run the bundled GoalBuddy update checker when available and mention a newer
   version without blocking.
4. Re-check the intake: original request, input shape, authority, proof, blind
   spots, existing plan facts, and likely misfire.
5. Work only on the active board task.
6. Assign Scout, Judge, Worker, or PM according to the task.
7. Write a compact task receipt.
8. Update the board.
9. If safe local work remains, choose the next largest reversible Worker or PM
   package and continue unless blocked.
10. Review at phase, risk, rejected-verification, ambiguity, or final-completion
   boundaries.
11. Finish only with a Judge/PM audit receipt that maps receipts and
   verification back to the original user outcome and records
   `full_outcome_complete: true`.
