# Manager Quality Drill

## Objective

Run a live disposable Scenario 10 manager-quality drill that tests whether a manager makes a defensible next-action decision from evidence instead of blindly accepting a worker's "done" claim.

## Original Request

After landing the compact/clear audit receipt, do the next Scenario 10 manager quality drill using GoalBuddy.

## Intake Summary

- Input shape: `existing_plan`
- Audience: Jeremy and future manager/worker dogfooding runs.
- Authority: `approved`
- Proof type: `artifact`
- Completion proof: A committed QA log/artifact update showing the manager inspected criteria, tests, git status, replay, and capture evidence; separated current blockers from deferred follow-ups; recorded an appropriate decision before any mutation; and chose a defensible next action.
- Likely misfire: The drill could merely script the PM's desired answer instead of testing a live manager's judgment, or it could count a generic "done" response as success without evidence mapping.
- Blind spots considered: manager may not inspect all required evidence surfaces, may finish despite missing test evidence, may mutate without decision/policy checks, or may leave disposable sessions behind.
- Existing plan facts: Scenario 10 acceptance criteria come from `docs/superpowers/plans/2026-05-16-dogfood-reliability-ladder.md`; use a realistic worker "done" claim with one subtle missing current-task proof and one deferred follow-up.

## Goal Kind

`existing_plan`

## Current Tranche

This tranche is complete when one disposable live manager-quality drill is captured, judged, documented, committed, and opened as a PR with green CI. The task is QA/documentation only; do not modify product implementation unless a separate follow-up task is created later.

## Non-Negotiable Constraints

- Use disposable task/session names prefixed `qa-manager-quality`.
- Do not perform product edits.
- Keep write scope to this goal, live QA artifacts, and the QA log.
- The manager must not be counted as passing unless it names evidence from criteria, tests, git status, replay, and worker capture.
- The manager must not blindly finish when current-task evidence is missing.
- Cleanup must leave no active disposable sessions, no scenario-prefixed tmux sessions, and clean reconcile output.

## Stop Rule

Stop only when a final audit proves the full original outcome is complete.

Do not stop after planning or setup if a safe disposable QA Worker task can run.

Do not mark complete unless a final Judge/PM receipt records `full_outcome_complete: true`.

## Slice Sizing

The useful slice is the full Scenario 10 disposable drill and receipt, not one command at a time.

## Canonical Board

Machine truth lives at:

`docs/goals/manager-quality-drill/state.yaml`

If this charter and `state.yaml` disagree, `state.yaml` wins.

## Run Command

```text
/goal Follow docs/goals/manager-quality-drill/goal.md.
```
