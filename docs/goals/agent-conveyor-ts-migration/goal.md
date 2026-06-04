# Agent Conveyor TypeScript Migration

## Objective

Convert Agent Conveyor from a Python-published CLI/control plane into a TypeScript/Node application and package, preserving the current `conveyor` and `workerctl` user contracts, the dashboard, QA gates, skill installation, and release confidence.

## Original Request

"convert this from a python to typescript app; use independent agents to analyze it completely including all qa tests and make a detailed queue of goalbuddy prep boards we can run overnight without me being in the loop; pr in, monitor ci, merge green prs; use npm package name agent-conveyor."

## Intake Summary

- Input shape: `existing_plan`
- Audience: Agent Conveyor users, repo maintainers, local Codex operators, and future npm consumers.
- Authority: `approved`
- Proof type: `test`
- Completion proof: `agent-conveyor` has a TypeScript/Node CLI implementation and npm package path with `conveyor` and `workerctl` commands, Python runtime no longer required for the migrated command surface, deterministic QA and package smoke gates pass locally and in CI, PRs are merged only when green, and a final audit maps every preserved Python contract to TS implementation, compatibility shim, or explicit follow-up.
- Goal oracle: a final Judge/PM audit backed by contract inventory diffs, schema parity checks, TS tests, deterministic QA gates, npm tarball install smoke, CI-green PR receipts, and merge receipts.
- Likely misfire: rewriting code in TypeScript while silently dropping CLI flags, JSON/text output, SQLite migration behavior, skill installation, packaging checks, dashboard integration, or live-smoke cleanup semantics.
- Blind spots considered: npm name availability can change before publish, npm auth may expire, TypeScript dashboard config is not enough for a distributable CLI, Node package shape is currently private/dashboard-only, Python package paths are still authoritative, live smoke can be unavailable on hosted CI, and publishing should not happen automatically overnight.
- Existing plan facts: independent scouts mapped Python architecture, QA/test gates, TS dashboard patterns, packaging/release paths, and npm package name availability. Local npm CLI auth was verified as `neonwatty`; `agent-conveyor` returned 404 from npm registry and is available as of the check.

## Goal Oracle

The oracle for this goal is:

`A final Judge/PM audit proves the TypeScript migration by mapping the current Python CLI/package behavior to TS code, passing local and CI verification, npm tarball install smoke, and merged green PRs, with no unreviewed contract loss and no automatic production publish.`

The PM must keep comparing task receipts to this oracle. Planning, a green tiny slice, or a publishable-looking `package.json` is not enough. The goal finishes only when a final Judge/PM audit maps receipts and verification back to this oracle and records `full_outcome_complete: true`.

## Goal Kind

`existing_plan`

## Current Tranche

This board is the overnight execution coordinator. It should proceed continuously through the largest safe verified slices:

1. Validate the scout synthesis and freeze the compatibility contract.
2. Establish the TS CLI/package foundation beside the existing Python CLI.
3. Port state, SQLite schema, tmux/Codex discovery, ingest, dispatch, lifecycle, and QA surfaces in dependency order.
4. Replace package/release gates with npm tarball install smoke while preserving skills and CLI aliases.
5. Open PRs, monitor CI, fix failures, and merge only green PRs when the evidence gates pass.

The board may spawn narrower child GoalBuddy boards only after the contract-freeze task has produced baseline artifacts and Judge confirms the write scopes are safe. Do not run parallel Workers against overlapping files.

## Non-Negotiable Constraints

- Use npm package name `agent-conveyor`.
- Preserve installed commands `conveyor` and `workerctl`.
- Preserve current CLI command names, flags, exit behavior, and JSON/text output unless a Judge explicitly approves a documented diff.
- Preserve SQLite schema v22 compatibility until a separate Judge-approved migration task introduces a new schema.
- Preserve `.codex-workers` state root behavior, `WORKERCTL_STATE_ROOT`, JSON compatibility files, and SQLite/status fallback semantics.
- Preserve tmux permission error handling, pane targeting safeguards, Codex rollout discovery, JSONL offset ingest, malformed-line tolerance, and Dispatch no-judgment boundary.
- Preserve skill installation into `CODEX_HOME` or `~/.codex`, including executable `codex-review` helper mode.
- Keep the existing dashboard green while shared TS code is introduced.
- Do not publish to npm automatically. Preparing a package, tarball, CI, docs, and PRs is approved; actual public publish remains an operator action.
- Treat CI-green, tests-passed, worker claims, and clean-looking package metadata as claims until the board records disproof evidence per `docs/agent-evidence-playbook.md`.
- Do not revert unrelated dirty work. The current pre-board dirty state included an untracked `docs/superpowers/plans/2026-06-02-agent-evidence-playbook.md`; leave unrelated changes alone.

## Stop Rule

Stop only when a final audit proves the full original outcome is complete.

Do not stop after planning, discovery, contract freeze, or a single verified Worker package when the broader TypeScript migration still has safe local follow-up work.

Do not stop because a slice needs npm credentials, GitHub permissions, live Codex/tmux availability, production publish permission, or policy decisions. Mark that exact task blocked with a receipt, create the smallest safe follow-up or workaround task, and continue all local non-destructive work that can still move the goal toward the full outcome.

## Slice Sizing

Safe means bounded, explicit, verified, and reversible. It does not mean tiny.

A good Worker task should produce a meaningful vertical migration slice, such as a TS CLI foundation, state/DB parity, ingest parity, Dispatch parity, package smoke parity, or CI/docs conversion.

Use Judge at phase boundaries, rejected verification, ambiguity, contract-loss risk, and final completion. Do not create one Judge after every helper or test file by habit.

## Canonical Board

Machine truth lives at:

`docs/goals/agent-conveyor-ts-migration/state.yaml`

If this charter and `state.yaml` disagree, `state.yaml` wins for task status, active task, receipts, verification freshness, and completion truth.

## Run Command

```text
/goal Follow docs/goals/agent-conveyor-ts-migration/goal.md.
```

## PM Loop

On every `/goal` continuation:

1. Read this charter.
2. Read `state.yaml`.
3. Run the bundled GoalBuddy update checker when available and mention a newer version without blocking.
4. Re-check the intake: original request, authority, proof, blind spots, existing plan facts, npm auth/name facts, and likely misfire.
5. Work only on the active board task.
6. Assign Scout, Judge, Worker, or PM according to the task.
7. Write a compact task receipt.
8. Update the board.
9. If safe local work remains, choose the next largest reversible Worker package and continue unless blocked.
10. If a PR is ready and local evidence is strong, create it, monitor CI, fix failures, and merge only green PRs when branch protection and permissions allow it.
11. If a package publish or destructive action is the only remaining step, block that exact task for operator approval and continue adjacent safe work.
12. Finish only with a Judge/PM audit receipt that maps receipts and verification back to the original user outcome and records `full_outcome_complete: true`.

Issue and PR handoffs are supporting artifacts. `state.yaml` remains authoritative, and every external artifact decision must be recorded in a task receipt.
