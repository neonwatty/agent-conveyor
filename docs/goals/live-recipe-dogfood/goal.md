# Live Recipe Dogfood

## Objective

Run a live tmux-backed Agent Conveyor dogfood using the `goalbuddy-conveyor`
manager recipe, then prove the manager, Dispatch, worker, dashboard, audit,
replay, export, and release gates all behave from the package-facing path.

## Original Request

"Plan it out with GoalBuddy prep board" and continue with the live
manager/worker dogfood after the installed no-tmux package dogfood passed.

## Intake Summary

- Input shape: `specific`
- Audience: package maintainer and first dogfood users
- Authority: `approved`
- Proof type: `demo`
- Completion proof: a live tmux-backed recipe task receipt showing manager and
  worker sessions, Dispatch routing, dashboard visibility, audit/replay/export
  evidence, cleanup/reconcile, and release/package gates passing without npm
  publish.
- Goal oracle: a disposable live recipe dogfood walkthrough using
  `conveyor pair --manager-recipe goalbuddy-conveyor` or the closest equivalent
  live pair path, plus receipts from dashboard and release checks.
- Likely misfire: declaring readiness from the installed no-tmux dogfood only,
  without proving live Codex/tmux delivery and dashboard surfaces.
- Blind spots considered: live Codex availability, tmux cleanup, dashboard port
  conflicts, Dispatch heartbeat/state visibility, package-vs-repo command path,
  no automatic npm publish.
- Existing plan facts: run live recipe dogfood, dashboard spot-check, release
  cut decision; preserve unrelated dirty GoalBuddy/planning files.

## Goal Oracle

The oracle for this goal is:

`A disposable live tmux-backed manager/worker recipe run can be started, observed,
routed through Dispatch, shown in the dashboard, audited, replayed, exported,
cleaned up, and verified by package/release gates without publishing.`

The PM must keep comparing task receipts to this oracle. Planning, a clean
installed no-tmux run, or a passing unit suite alone is not enough. The goal
finishes only when a final Judge/PM audit maps receipts and verification back to
this oracle and records `full_outcome_complete: true`.

## Goal Kind

`specific`

## Current Tranche

Complete the live recipe dogfood tranche for the current npm-package branch.
Use local disposable sessions and non-destructive checks. If true live Codex
session startup is blocked by auth, tooling, or environment, record the exact
blocker and continue with every safe adjacent proof, but do not call the live
oracle complete.

## Non-Negotiable Constraints

- Preserve unrelated dirty files and GoalBuddy boards.
- Keep one active board task at a time.
- Use disposable task/session names and clean them up.
- Do not publish to npm automatically.
- Do not merge or push unless explicitly requested.
- Record evidence receipts on the board.
- Before claiming completion, try to disprove the result using
  `docs/agent-evidence-playbook.md`.

## Stop Rule

Stop only when a final audit proves the full original outcome is complete.

Do not stop after planning, prerequisite mapping, or installed-package proof if a
safe live dogfood task can still be activated.

## Slice Sizing

Use a few coherent vertical slices rather than one card per command:

- prerequisite map and exact command plan;
- live tmux-backed recipe run;
- dashboard proof;
- release/package closeout;
- final audit.

## Canonical Board

Machine truth lives at:

`docs/goals/live-recipe-dogfood/state.yaml`

If this charter and `state.yaml` disagree, `state.yaml` wins for task status,
active task, receipts, verification freshness, and completion truth.

## Run Command

```text
/goal Follow docs/goals/live-recipe-dogfood/goal.md.
```

## PM Loop

On every continuation:

1. Read this charter.
2. Read `state.yaml`.
3. Work only on the active board task.
4. Write a compact receipt.
5. Update the board and activate the next task unless the final audit proves the
   oracle complete.
