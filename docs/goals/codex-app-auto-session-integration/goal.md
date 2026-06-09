# Codex App Auto Session Integration

## Objective

Make Agent Conveyor able to set up supervised manager/worker pairs from inside the Codex app by using fresh Codex app thread creation when available, while preserving tmux startup for terminal users and inbox-based Dispatch as the durable source of truth.

## Original Request

Work this up as a GoalBuddy prep board, sequence of tasks with measurable acceptance criteria, and implement the automatic Codex app session creation direction.

## Intake Summary

- Input shape: `specific`
- Audience: Agent Conveyor users, Codex app manager sessions, Codex app worker sessions, and maintainers dogfooding manager/dispatcher/worker loops.
- Authority: `approved`
- Proof type: `test + live demo + audit`
- Completion proof: A final receipt proves that a Codex app manager can create a fresh same-project worker thread with a human-readable title, record or surface its app-thread identity in Conveyor setup metadata, route work through Dispatch/inbox semantics, and fall back cleanly to tmux or manual no-tmux setup when app thread creation is unavailable.
- Goal oracle: A live app-assisted setup drill plus focused automated tests and direct thread-list/read evidence show the correct session creation path is selected for Codex app vs terminal/tmux contexts.
- Likely misfire: Treating the fork-thread proof as fresh session creation, or adding app-only behavior that breaks terminal/tmux pair creation and Dispatch audit semantics.
- Blind spots considered:
  - `create_thread` is available to Codex app agent sessions, not necessarily to a raw terminal `conveyor` process.
  - The package should own durable state, Dispatch, inboxes, audit, replay, and tmux flows; the installed skill/app wrapper should own app-thread creation when tool access exists.
  - App-to-app communication should use existing `pull_required` inbox records as source of truth; direct `send_message_to_thread` is only a wake-up convenience if used at all.
  - Human-readable app thread titles and thread ids need to be visible enough for operators to confirm the worker session they created.
  - Fallback behavior matters because not every Agent Conveyor install will have Codex app thread tools.
- Existing plan facts:
  - Same-directory `fork_thread` was proven but is not sufficient for fresh-worker setup.
  - Fresh `create_thread` with target project root `/Users/neonwatty/Desktop/codex-terminal-manager` was proven and the created thread was renamed/listed as `this is a created test`.
  - Existing no-tmux Dispatch support already routes Codex app/no-tmux targets with `delivery_mode='pull_required'`.

## Goal Oracle

The oracle for this goal is:

`A fresh Codex app worker thread can be created, titled, addressed, and tied to a Conveyor task setup from a manager Codex app session, while terminal/tmux users still get tmux-backed pair creation and app/no-tmux users still communicate through pull-required Dispatch inboxes.`

The PM must keep comparing task receipts to this oracle. Planning, discovery, a passing tiny slice, or a clean-looking board is not enough. The goal finishes only when a final Judge/PM audit maps receipts and verification back to this oracle and records `full_outcome_complete: true`.

## Goal Kind

`specific`

## Current Tranche

Deliver the first practical app-assisted setup path:

1. Validate the exact integration boundary between terminal CLI, installed skill, and Codex app thread tools.
2. Add or adjust Conveyor session metadata and command output so app-created threads can be named, identified, audited, and explained without changing Dispatch into a decision-maker.
3. Update the installed `manage-codex-workers` workflow so Codex app managers prefer fresh `create_thread`, terminal managers prefer tmux `pair`, and unavailable app tools fall back to manual no-tmux inbox setup.
4. Prove the workflow with focused tests plus a live no-edit Codex app thread creation/visibility receipt.

## Non-Negotiable Constraints

- Preserve existing tmux `pair`, `start-worker`, `start-manager`, `session-nudge`, and Dispatch behavior for terminal users.
- Do not make Dispatch decide task success, acceptance criteria, next work, PR actions, or human routing.
- Keep `routed_notifications` and `manager-inbox`/`worker-inbox` as the source of truth for app-session communication.
- Treat Codex app `create_thread` and `send_message_to_thread` as app-layer capabilities, not capabilities every terminal install can assume.
- Avoid destructive git or tmux operations outside disposable QA state.
- Use direct evidence before claiming fresh app session creation: thread id, title, cwd/project, status, and list/read accessibility.

## Acceptance Criteria

- A documented and tested detection/selection model distinguishes terminal/tmux setup, Codex app with thread tools, and Codex app/manual no-tmux fallback.
- Conveyor session setup output can carry Codex app thread identity or explicit app-thread metadata without weakening rollout/tmux identity checks.
- The installed `manage-codex-workers` skill describes an app-assisted worker creation workflow using `create_thread` when available and a manual handoff fallback when unavailable.
- App-created worker setup still communicates through Dispatch inboxes with `delivery_mode='pull_required'`.
- Terminal/tmux setup continues to prefer `pair` or `start-*` and remains push-capable.
- Focused tests cover new CLI/session metadata or workflow behavior.
- A live no-edit Codex app proof creates a fresh same-project thread, assigns a human-readable title, and confirms it appears in the Codex app thread list.
- `python3 -m unittest tests.test_workerctl -v` or a narrower justified test suite passes.
- `npm test` or relevant TypeScript tests pass when TypeScript surfaces are changed.
- `git diff --check` passes.

## Stop Rule

Stop only when a final audit proves the app-assisted setup workflow is implemented, documented, verified, and live-proven, with no required Worker task queued or active.

Do not stop at a design note, a fork-thread proof, or a manual no-tmux binding proof.

Do not mark complete unless a final Judge/PM receipt records `full_outcome_complete: true`.

## Slice Sizing

Safe means bounded, explicit, verified, and reversible. It does not mean tiny.

A good task is the largest safe useful slice.

Small is not the goal. Useful is the goal.

Worker tasks should complete coherent surfaces: one schema/CLI metadata package, one skill/workflow package, one live proof package. If Scout or Judge finds those surfaces are too entangled, split only at a clear verification boundary.

## Canonical Board

Machine truth lives at:

`docs/goals/codex-app-auto-session-integration/state.yaml`

If this charter and `state.yaml` disagree, `state.yaml` wins for task status, active task, receipts, verification freshness, and completion truth.

## Run Command

```text
/goal Follow docs/goals/codex-app-auto-session-integration/goal.md.
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
10. Review at phase, risk, rejected-verification, ambiguity, or final-completion boundaries.
11. Finish only with a Judge/PM audit receipt that maps receipts and verification back to the original user outcome and records `full_outcome_complete: true`.
