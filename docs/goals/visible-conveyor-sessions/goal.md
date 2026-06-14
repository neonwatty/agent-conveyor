# Visible Conveyor Sessions

## Objective

Make app-native Agent Conveyor manager-worker loops reviewable from the actual Codex or tmux sessions while work is happening, as if the operator were driving those sessions directly.

## Original Request

Create a detailed `/goal` plan to fix the misalignment where Conveyor manager-worker communication can be true in SQLite but not clearly visible in the live manager and worker sessions.

## Intake Summary

- Input shape: `specific`
- Audience: operator/users running Agent Conveyor manager-worker loops through Codex app or tmux
- Authority: `requested`
- Proof type: `demo`
- Completion proof: a fresh manager-worker dogfood run where opening the live manager and worker sessions shows the actual poll, receive, work, send, and dispatch transcript as the work happens, not as a replay inserted later
- Goal oracle: live Codex app/tmux session transcript plus durable Conveyor command/inbox receipts agree on the same manager-worker exchange
- Likely misfire: improving SQLite/replay/status reporting while the live sessions still look idle or disconnected
- Blind spots considered: prompt-only fixes may be cooperative rather than enforced; Ralph run status currently misses task-level Dispatch traffic; heartbeat noise suppression can hide real work; tmux and Codex app loops need the same human-readable contract
- Existing plan facts:
  - Do not build an after-the-fact replay-to-session feature as the primary fix.
  - The manager and worker sessions themselves must print the visible transcript during their own turns.
  - Idle checks may be brief, but consumed work may not be silent.
  - Durable inboxes remain the source of audit proof, but not the only human-readable story.

## Goal Oracle

The oracle for this goal is:

`Run a fresh app-native manager-worker Conveyor dogfood loop. While it is running, read both Codex app sessions and verify each consumed item appears live in the consuming session as CONVEYOR POLL / CONVEYOR RECEIVED / WORK / CONVEYOR SEND / DISPATCH output, with matching task-level Dispatch receipts.`

The PM must keep comparing task receipts to this oracle. Planning, cleaner docs, passing unit tests, or better replay output are not enough. The goal finishes only when a final Judge/PM audit maps implementation, tests, and a fresh dogfood transcript back to this oracle and records `full_outcome_complete: true`.

## Goal Kind

`specific`

## Current Tranche

This tranche should implement and verify the visible-session protocol for app-native Conveyor loops. The largest useful reversible scope is:

1. Identify every generated handoff, heartbeat, and app-autopilot prompt that can consume or send manager-worker inbox messages.
2. Add a default visible-session protocol that forces live output in the consuming/sending session.
3. Add tests that prove generated prompts include the protocol and do not permit silent handling after consuming work.
4. Repair status guidance where needed so operators do not trust a Ralph run summary that is blind to task-level Dispatch.
5. Dogfood with a fresh manager-worker pair and verify the actual live session transcripts.

## Non-Negotiable Constraints

- Do not implement an after-the-fact replay as the main user experience.
- Do not treat SQLite, replay, or `loop-status` as a substitute for live manager/worker session output.
- Preserve durable Conveyor inbox semantics; visible transcript is in addition to, not instead of, durable receipts.
- Idle heartbeats may be compact, but any consumed inbox item must produce visible session output before action and before final answer.
- Do not merge unrelated changes or alter downstream product repos as part of this package fix.
- Keep package changes covered by tests and a fresh dogfood receipt.

## Stop Rule

Stop only when a final audit proves the full original outcome is complete.

Do not stop after planning, discovery, prompt edits, or package tests if a fresh dogfood run has not proven the live sessions are readable while work happens.

Do not stop because `loop-status` or SQLite looks clean. The oracle is live-session readability plus matching durable receipts.

## Slice Sizing

Safe means bounded, explicit, verified, and reversible. It does not mean tiny.

The first implementation package should cover the whole visible-session protocol across generated app-native manager and worker prompts, rather than one prompt at a time, if Scout/Judge confirms the files and tests are clear.

## Canonical Board

Machine truth lives at:

`docs/goals/visible-conveyor-sessions/state.yaml`

If this charter and `state.yaml` disagree, `state.yaml` wins for task status, active task, receipts, verification freshness, and completion truth.

## Run Command

```text
/goal Follow docs/goals/visible-conveyor-sessions/goal.md.
```

## PM Loop

On every `/goal` continuation:

1. Read this charter.
2. Read `state.yaml`.
3. Run the bundled GoalBuddy update checker when available and mention a newer version without blocking.
4. Re-check the intake, especially the likely misfire: after-the-fact visibility is not success.
5. Work only on the active board task.
6. Assign Scout, Judge, Worker, or PM according to the task.
7. Write a compact task receipt.
8. Update the board.
9. Continue through implementation, verification, and dogfood until the oracle is satisfied.
10. Finish only with a Judge/PM audit receipt that maps receipts and verification back to the original user outcome and records `full_outcome_complete: true`.
