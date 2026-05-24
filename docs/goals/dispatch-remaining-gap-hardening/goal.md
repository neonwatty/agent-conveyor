# Dispatch Remaining Gap Hardening

## Objective

Fix the remaining dispatch-addition gaps found by three independent reviewers, without reopening the already-complete core Dispatch implementation or broadening Dispatch beyond mechanical routing and actuation.

## Original Request

"Make a detailed plan using $goalbuddy:goal-prep to fix these remaining gaps"

## Intake Summary

- Input shape: `existing_plan`
- Audience: `workerctl` operators, managers, workers, dashboard users, and maintainers relying on Dispatch auditability.
- Authority: `requested`
- Proof type: `test`
- Completion proof: focused backend, CLI, dashboard, and regression tests pass; a final Judge audit maps every named residual gap to either implemented evidence or an explicit non-goal.
- Goal oracle: the current app keeps matching the dispatch addition issue while the named hardening gaps are fixed with source-backed tests and no Dispatch judgment behavior.
- Likely misfire: spending the goal revalidating that Dispatch mostly works, or polishing docs/UI while leaving concurrency, state-transition, transaction, and task-selection risks untested.

## Existing Plan Facts

Three independent reviewers agreed that Dispatch is substantially implemented. The remaining gaps to fix or deliberately resolve are:

1. Duplicate-route suppression is covered by a mocked unique-constraint race, not a true concurrent multi-dispatcher integration test.
2. Notification-only correlation to the next manager cycle/decision is heuristic and can mis-associate when cycles are close together.
3. `dispatch_signal_suppressed` dashboard visibility depends on recent telemetry snapshot limits.
4. `finish_command_attempt` may update command state and emit telemetry even if no running attempt row was updated.
5. Dispatch may hold a SQLite write transaction across tmux side effects.
6. `required_permission` is optional/free-form at enqueue time; missing permissions allow execution, and misspellings fail only at execution.
7. Worker completion routing is not represented as `command_attempt`, so queued side effects and automatic completion notifications have different audit shapes.
8. Ack gating checks latest ack presence but does not bind acks to current manager config or binding revision.
9. `dashboard --task` may be parsed but ignored by the observation path, making dispatch inspection ambiguous for named tasks.
10. Dispatch heartbeat UI omits useful existing fields: `dry_run`, `iteration`, and `processed_count`.
11. Generic manual QA docs do not include dispatch checks, though `qa-plan dispatch-completion` exists.

## Non-Negotiable Constraints

- Preserve Dispatch as mechanical routing/execution only: no task success judgment, criteria decisions, next-work selection, final task state changes, PR merging, or human-operator routing.
- Do not rewrite the dispatch architecture unless Scout/Judge proves a narrow fix cannot satisfy the gap.
- Preserve existing direct nudge/session commands and existing dispatch command queue/watch behavior.
- Keep tmux side-effect retry behavior conservative; if a send may have started, record risk and do not blindly retry.
- Keep schema changes additive and migration-compatible.
- Do not touch unrelated dirty work.
- Worker tasks may edit only their explicit `allowed_files`.

## Goal Oracle

The goal is complete only when a final Judge audit proves:

- Each named residual gap is fixed, intentionally out of scope, or converted into a precise follow-up with evidence.
- Focused tests cover any changed behavior, especially concurrency/race, command attempt state transitions, transaction boundaries, permission validation, dashboard task targeting, heartbeat visibility, suppressed signal visibility, and replay/correlation behavior.
- `python3 -m unittest tests.test_workerctl.DispatchTests -v` passes.
- Relevant focused CLI/database tests pass.
- Dashboard tests/build pass for dashboard changes.
- `python3 -m py_compile workerctl/*.py` and `git diff --check` pass.
- Dispatch still does not decide task success, acceptance criteria, next work, or human/operator routing.

## Current Tranche

This tranche should harden the remaining gaps in largest safe useful slices:

1. Scout the exact source/test surfaces for the residual risks and separate true bugs from acceptable documented asymmetry.
2. Judge the largest safe backend slice, with special skepticism around transaction scope and idempotent tmux side effects.
3. Implement backend hardening for command attempt finalization, transaction boundaries, permission validation, and stale/race coverage.
4. Implement correlation/replay improvements only if Scout/Judge can define a deterministic rule that is safer than the current heuristic.
5. Implement dashboard/operator visibility fixes for explicit task targeting, heartbeat detail, and durable suppressed-signal visibility.
6. Add or update dispatch manual QA docs only after behavior is verified.
7. Run final audit against the original dispatch addition issue and this residual-gap list.

## Canonical Board

Machine truth lives at:

`docs/goals/dispatch-remaining-gap-hardening/state.yaml`

If this charter and `state.yaml` disagree, `state.yaml` wins.

## Run Command

```text
/goal Follow docs/goals/dispatch-remaining-gap-hardening/goal.md.
```

## PM Loop

On every `/goal` continuation:

1. Read this charter and `state.yaml`.
2. Work only on the active board task.
3. Keep Scout/Judge tasks read-only.
4. Keep Worker writes inside `allowed_files`.
5. Write compact receipts before advancing the board.
6. Prefer the largest safe useful Worker slice over tiny helper tasks.
7. Continue through safe local work until final audit proves the tranche complete or a specific task is blocked with a receipt.
8. Finish only with a final audit receipt that records `full_outcome_complete: true`.
