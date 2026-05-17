# Compact Clear Audit Receipt

## Objective

Live-verify that the merged dry-run compact/clear audit behavior works in a disposable manager/worker workflow, then document the receipt so the compact/clear mutation-audit caveat is closed with real QA evidence.

## Original Request

Plan and continue the next step: use GoalBuddy to manage a live disposable QA run proving PR #67's dry-run compact/clear mutation-audit behavior.

## Intake Summary

- Input shape: `existing_plan`
- Audience: Jeremy and future manager/worker dogfooding runs.
- Authority: `approved`
- Proof type: `artifact`
- Completion proof: A committed QA log/artifact update showing live `mutation-audit` records for dry-run `/compact` and `/clear` with `effect.dry_run: true`, `effect.sent: false`, linked `nudge` decisions, distinguishable slash commands, and clean cleanup receipts.
- Likely misfire: GoalBuddy could re-prove that `commands` and `replay` contain compact/clear attempts while failing to prove that `mutation-audit.effect` now exposes the no-send dry-run result.
- Blind spots considered: accidental real `/compact` or `/clear`, stale worker handoff, missing manager permission, incomplete cleanup, and documenting unit-test proof instead of live disposable-run proof.
- Existing plan facts: Use a disposable task/session pair, record handoff, enable canonical `worker_compact_clear`, run dry-run compact and clear through `request-worker-compact`, verify `mutation-audit`, capture artifacts, clean up, update `docs/live-qa-log.md`, open a PR, and monitor CI.

## Goal Kind

`existing_plan`

## Current Tranche

This tranche is complete when the live compact/clear dry-run audit receipt is captured and documented. The work should stay scoped to disposable QA artifacts and documentation; product behavior has already been implemented and merged in PR #67.

## Non-Negotiable Constraints

- Do not send real `/compact` or `/clear`; use `--dry-run`.
- Do not edit product implementation files unless a live verification failure proves the merged behavior is broken and the PM records a new explicit Worker repair task.
- Use a disposable task/session pair and clean it up.
- Preserve durable evidence under `docs/live-qa-artifacts/2026-05-17-compact-clear-audit-receipt/`.
- Update `docs/live-qa-log.md` with the live receipt summary.
- Verify cleanup with `sessions --state active`, `reconcile --stale-cycles-seconds 1`, and scenario-prefixed tmux checks.

## Stop Rule

Stop only when a final audit proves the full original outcome is complete.

Do not stop after planning, discovery, or Judge selection if a safe Worker or PM task can be activated.

Do not mark the goal complete unless the final audit maps receipts and verification back to the original goal and records `full_outcome_complete: true`.

## Slice Sizing

The useful slice is the entire disposable live QA receipt, not one command at a time. Scout should map exact commands and artifact names. Worker should run the full disposable QA flow and document it. Judge should audit the whole receipt once.

## Canonical Board

Machine truth lives at:

`docs/goals/compact-clear-audit-receipt/state.yaml`

If this charter and `state.yaml` disagree, `state.yaml` wins for task status, active task, receipts, verification freshness, and completion truth.

## Run Command

```text
/goal Follow docs/goals/compact-clear-audit-receipt/goal.md.
```

## PM Loop

On every `/goal` continuation:

1. Read this charter.
2. Read `state.yaml`.
3. Run the bundled GoalBuddy update checker when available and mention a newer version without blocking.
4. Work only on the active board task.
5. Assign Scout, Judge, Worker, or PM according to the task.
6. Write a compact task receipt.
7. Update the board.
8. Continue to the next safe task unless the final audit proves completion.
