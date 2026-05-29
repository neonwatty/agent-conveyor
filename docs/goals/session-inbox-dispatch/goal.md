# Universal Session Inbox For Dispatch

## Objective

Make dispatcher signals first-class for both tmux-backed and Codex app-based sessions by adding a durable pull inbox for manager and worker sessions, while preserving tmux push delivery as an optional transport.

## Original Request

Plan the mailbox/inbox work with GoalBuddy so app-based managers and workers can poll dispatcher messages with actionable tasks and measurable acceptance criteria.

## Intake Summary

- Input shape: `specific`
- Audience: Jeremy, future Codex app managers/workers, and workerctl operators.
- Authority: `approved`
- Proof type: `test`
- Completion proof: Tests and a local smoke demonstrate that a non-tmux manager can consume worker-completion signals, a non-tmux worker can consume manager nudges, tmux sessions still receive pushed signals, and all paths share durable audit/correlation evidence.
- Goal oracle: A repeatable `python3 -m unittest tests.test_workerctl -v` run plus focused inbox/dispatch tests showing push-capable and pull-required sessions both receive the same routed notification semantics.
- Likely misfire: Building a manager-only helper or a parallel app-only queue that bypasses `routed_notifications`, losing correlation, dedupe, command attempts, or audit/replay continuity.
- Blind spots considered:
  - Tmux push and inbox consumption are different delivery transports but should share one durable notification model.
  - Delivered tmux notifications may still need inbox visibility until consumed for audit/recovery.
  - Non-tmux targets should not be counted as failed dispatch sends when pull delivery is expected.
  - Worker-directed app sessions need the same pull semantics as manager-directed app sessions.
  - Inbox consumption needs idempotency and evidence that ties back to the target session and manager/worker cycle.

## Goal Kind

`specific`

## Current Tranche

Implement a universal session inbox slice for dispatcher-routed notifications:

1. Confirm the current schema and dispatch lifecycle.
2. Choose the minimal schema/API design that preserves existing routed notification semantics.
3. Add session inbox read/consume primitives.
4. Add CLI surfaces for `session-inbox`, `manager-inbox`, and `worker-inbox`.
5. Make dispatch transport-aware so no-tmux targets become pull-required inbox deliveries instead of opaque send failures.
6. Update manager/worker instructions and docs.
7. Verify with focused unit tests, full workerctl tests, and a local smoke.

## Non-Negotiable Constraints

- Preserve dispatch as a mechanical router/executor; managers still decide meaning and next action.
- Do not create a second notification system that bypasses `routed_notifications` unless Judge explicitly proves a separate table is safer.
- Keep existing tmux push behavior compatible.
- Keep command claims, leases, side-effect-risk tracking, dedupe, correlation IDs, and audit/replay continuity intact.
- App-based sessions must pull the same messages and evidence tmux sessions receive.
- Implement with TDD for behavior changes.
- Avoid destructive tmux/git operations outside disposable test/smoke state.

## Stop Rule

Stop only when a final audit proves the universal inbox tranche is implemented, verified, documented, and no required Worker task remains queued or active.

Do not stop at planning if a safe implementation slice exists.

Do not mark complete unless a final Judge/PM receipt records `full_outcome_complete: true`.

## Canonical Board

Machine truth lives at:

`docs/goals/session-inbox-dispatch/state.yaml`

If this charter and `state.yaml` disagree, `state.yaml` wins.

## Run Command

```text
/goal Follow docs/goals/session-inbox-dispatch/goal.md.
```
