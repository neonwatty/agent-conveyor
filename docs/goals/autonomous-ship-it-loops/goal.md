# Autonomous Ship-It Loops

## Objective

Add an explicit, evidence-gated ship-it lifecycle for Conveyor manager-worker loops so a bounded run can create a PR, monitor CI, handle merge conflicts, verify after fixes, and merge only when the operator-granted policy allows it.

## Original Request

Plan out with GoalBuddy prep the addition of autonomous ship-it loops.

## Intake Summary

- Input shape: `specific`
- Audience: Conveyor operators using Codex app manager-worker sessions for repo work.
- Authority: `requested`
- Proof type: `test`
- Completion proof: a local verified implementation, docs/skill updates, and a dogfood or QA receipt proving a manager-worker run can express PR/CI/conflict/merge authority without silent escalation or idle loops.
- Goal oracle: `npm test` plus focused Conveyor QA/CLI tests and a receipt-backed dogfood or simulated ship-it run showing policy decisions, visible session prompts, PR lifecycle state, and manager-only merge gating.
- Likely misfire: implementing a vague "auto-merge" convenience that bypasses manager verification, hides worker progress from app sessions, or treats CI green as enough without checking mergeability, conflicts, dirty state, and explicit authority.
- Blind spots considered: GitHub auth may be unavailable locally; merge operations are destructive enough to require explicit policy; Codex app thread/worktree selection can differ from manual worktrees; conflict resolution may need a bounded retry limit; npm package and skill updates may need separate release handling.
- Existing plan facts: user wants manager/worker prompts to include approval boundaries for creating, monitoring, resolving conflicts, and merging PRs; manager should verify worker claims; future runs should act visibly in Codex app sessions; PR lifecycle should be optional and policy-driven, not the default for every loop.

## Goal Oracle

The oracle for this goal is:

`A final Judge/PM audit maps implementation receipts to passing focused tests, full relevant test coverage, updated operator docs/skill prompts, and a dogfood or simulated ship-it run where the manager alone authorizes PR closeout and merge under an explicit policy.`

The PM must keep comparing task receipts to this oracle. Planning, discovery, a passing tiny slice, or a clean-looking board is not enough. The goal finishes only when a final Judge/PM audit maps receipts and verification back to this oracle and records `full_outcome_complete: true`.

## Goal Kind

`specific`

## Current Tranche

Design and implement the first production-ready ship-it loop tranche for Agent Conveyor. The tranche should produce an operator-facing policy/template and the supporting CLI/runtime behavior needed for manager-worker runs to go from task definition to PR closeout safely. It should include tests and docs, but it does not have to perform a real merge against a live repo unless credentials and operator approval are present; a deterministic simulated or dry-run QA path is acceptable if it proves the same gates.

## Non-Negotiable Constraints

- Do not make PR creation, conflict resolution, or merging implicit defaults.
- Worker may edit, test, commit, push, and report only when the run policy grants those powers.
- Manager is the only role allowed to decide final closeout and merge readiness.
- Treat worker claims, green CI, and generated summaries as claims until independently verified.
- Ship-it loops must preserve app-visible manager/worker output expectations: poll, received, work, send, and dispatch steps should be reviewable in the sessions.
- Do not edit env files, secrets, lockfiles, migrations, generated files, or unrelated dirty work unless the active Worker task explicitly permits it.
- Do not require live GitHub credentials for local tests.
- If a real PR/merge dogfood is attempted, record branch, PR URL, CI evidence, mergeability, and post-merge state; do not merge without explicit operator-approved policy.

## Stop Rule

Stop only when a final audit proves the full original outcome is complete.

Do not stop after planning, discovery, or Judge selection if a safe Worker task can be activated.

Do not stop after a single verified Worker package when the broader owner outcome still has safe local follow-up work. Advance the board to the next highest-leverage safe Worker package and continue unless a phase, risk, rejected-verification, ambiguity, or final-completion review is due.

Do not create one Worker/Judge pair per repeated file, test, or documentation page. Put repeated same-shape work into one Worker package and review the package as a whole.

## Slice Sizing

Safe means bounded, explicit, verified, and reversible. It does not mean tiny.

A good task is the largest safe useful slice.

Small is not the goal. Useful is the goal.

A Worker should finish the whole assigned slice. A Judge should judge the whole assigned slice. A PM should reorient the board when tasks are safe but not moving the outcome.

Tiny tasks are allowed when the failure is isolated, the risk is high, the scope is unknown, or the tiny task unlocks a larger slice. Tiny tasks are bad when they keep happening, do not change behavior, only add wrappers/contracts/proof files, or avoid the real milestone.

## Canonical Board

Machine truth lives at:

`docs/goals/autonomous-ship-it-loops/state.yaml`

If this charter and `state.yaml` disagree, `state.yaml` wins for task status, active task, receipts, verification freshness, and completion truth.

## Run Command

```text
/goal Follow docs/goals/autonomous-ship-it-loops/goal.md.
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
10. Review at phase, risk, rejected-verification, ambiguity, or final-completion boundaries; do not review every small Worker by habit.
11. Finish only with a Judge/PM audit receipt that maps receipts and verification back to the original user outcome and records `full_outcome_complete: true`.
