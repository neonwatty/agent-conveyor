# Seeded Pair Smoke

## Objective

Run and document a narrow live QA smoke that proves `workerctl pair --manager-*`
can launch a manager with pre-seeded config and have that manager start
supervising from `cycle` instead of asking setup questions first.

## Original Request

Use `$goalbuddy:goal-prep` for the seeded-pair smoke QA.

## Intake Summary

- Input shape: `specific`
- Audience: Jeremy Watt and future manager/worker dogfood runs
- Authority: `requested`
- Proof type: `artifact`
- Completion proof: a disposable live manager/worker task is exported and
  documented, showing the manager saw seeded config, started with `cycle`, used
  `session-nudge`, verified worker evidence, satisfied accepted criteria, and
  cleaned up with no active sessions.
- Likely misfire: declaring the smoke passed because `pair` accepted flags,
  without proving the launched manager actually skipped setup questions and
  supervised from the seeded config.
- Blind spots considered:
  - `manager_configs.acceptance_criteria_json` may not be enough if durable
    accepted criteria rows are also needed for `finish-task
    --require-criteria-audit`.
  - Transcript capture must happen before stopping sessions if the smoke needs
    terminal transcript segments.
  - The manager may still follow the bootstrap setup-question path if the prompt
    wording is too weak.
- Existing plan facts:
  - Use task `qa-seeded-pair-smoke`.
  - Use worker `qa-seeded-pair-worker`.
  - Use manager `qa-seeded-pair-manager`.
  - Use artifact root
    `docs/live-qa-artifacts/2026-05-17-seeded-pair-smoke/`.
  - Worker must only write ignored QA artifacts.
  - Verify active sessions return `[]` and reconcile is clean.

## Goal Kind

`specific`

## Current Tranche

Complete one disposable live seeded-pair smoke and record enough durable
evidence to decide whether the PR #72 behavior is ready for broader dogfooding
or needs a follow-up product fix.

## Non-Negotiable Constraints

- Do not edit product implementation files during the smoke unless the board
  explicitly creates a follow-up Worker task after evidence shows the smoke
  failed.
- Use disposable task/session names prefixed `qa-seeded-pair`.
- Worker writes only ignored artifacts under `.codex-workers/` or documented QA
  artifacts under `docs/live-qa-artifacts/`.
- Capture transcript segments before stopping sessions if transcript evidence is
  required.
- Do not leave active tmux sessions running at completion.
- Preserve the acceptance criteria and verification evidence in durable
  receipts.

## Stop Rule

Stop only when a final audit proves the seeded-pair smoke outcome is complete.

Do not stop after creating the board, starting the pair, or seeing successful
CLI output if the manager behavior has not been verified.

Do not mark the tranche complete if the manager still asks setup questions first
or if accepted criteria cannot be audited before finish.

## Slice Sizing

This is intentionally a narrow QA tranche. The useful slice is one complete live
smoke with setup, observation, manager action, worker receipt, audit export,
cleanup, and QA-log documentation.

If the smoke finds a product defect, record it with evidence and either queue a
bounded follow-up Worker task or stop for the operator if the fix would exceed
the QA tranche.

## Canonical Board

Machine truth lives at:

`docs/goals/seeded-pair-smoke/state.yaml`

If this charter and `state.yaml` disagree, `state.yaml` wins for task status,
active task, receipts, verification freshness, and completion truth.

## Run Command

```text
/goal Follow docs/goals/seeded-pair-smoke/goal.md.
```

## PM Loop

On every `/goal` continuation:

1. Read this charter.
2. Read `state.yaml`.
3. Run the bundled GoalBuddy update checker when available and mention a newer
   version without blocking.
4. Work only on the active board task.
5. Assign Scout, Judge, Worker, or PM according to the task.
6. Write a compact task receipt.
7. Update the board.
8. Continue through the queued smoke, audit, and documentation tasks until the
   final audit proves the tranche complete.
