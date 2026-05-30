# Codex App Dispatch Inbox Ops

## Objective

Make Codex app-based managers and workers operationally first-class dispatcher participants by improving polling ergonomics, dispatcher/inbox observability, and live QA proof for no-tmux manager/worker signaling.

## Original Request

Use GoalBuddy to plan the next dispatcher inbox slice with measurable acceptance criteria.

## Intake Summary

- Input shape: `specific`
- Audience: workerctl operators, Codex app-based manager sessions, Codex app-based worker sessions, and maintainers preparing broader QA rollout.
- Authority: `approved`
- Proof type: `test + demo + review`
- Completion proof: A merged PR with tests and a disposable live QA receipt proves a no-tmux Codex app manager and no-tmux Codex app worker can exchange dispatcher-routed signals through inbox polling, while operator-facing surfaces show the route, delivery mode, pending backlog, consumption evidence, dispatcher heartbeat, and command attempt linkage.
- Goal oracle: A final QA/audit receipt maps the manager-dispatcher-worker signal chain from queued command to inbox consumption in both directions, with passing automated tests and clean PR review.
- Likely misfire: Treating the backend inbox as done without making polling practical, visible, or proven in a realistic no-tmux Codex app drill.
- Blind spots considered:
  - App sessions need clear polling guidance or a helper, not just raw commands hidden in docs.
  - Operators need to see whether a signal is push-delivered, pull-required, pending, consumed, or stuck.
  - Dashboard/replay evidence must connect manager dispatcher, worker dispatcher, routed notification, command attempt, and target session without making Dispatch decide task success.
  - The live QA drill must exercise both directions: manager-to-worker nudge and worker-to-manager completion/notification.
  - Any helper loop must stay bounded/testable and avoid starting indefinite background processes without explicit operator intent.

## Goal Kind

`specific`

## Current Tranche

Turn the universal session inbox into an operator-trustable workflow:

1. Scout the current polling, replay, dashboard, and docs surfaces after PR #163.
2. Judge the smallest coherent implementation slice for ergonomics and observability.
3. Implement bounded polling guidance/helper behavior only if it materially improves app-session use.
4. Add dashboard/replay/operator visibility for inbox backlog and consumption evidence.
5. Run a disposable no-tmux Codex app manager/worker QA drill proving both signal directions.
6. Run local verification, PR review toolkit, and publish/merge when green if the user approves that execution path.

## Non-Negotiable Constraints

- Dispatch remains a mechanical router/executor; it must not decide task success, acceptance criteria, final task state, next work, PR merging, or human routing.
- Reuse the `routed_notifications` inbox model from PR #163; do not introduce a parallel message queue unless Judge explicitly proves the existing model cannot support the goal.
- Preserve tmux push behavior and existing audit/replay semantics.
- Keep any polling helper bounded, explicit, and testable.
- Avoid destructive tmux/git operations outside disposable QA state.
- Use TDD for behavior changes and keep docs aligned with actual commands.

## Acceptance Criteria

- Codex app manager polling flow is documented or wrapped in an ergonomic command with measurable behavior.
- Codex app worker polling flow is documented or wrapped in an ergonomic command with measurable behavior.
- Operator-facing output exposes pending inbox backlog per manager/worker session.
- Dashboard or replay shows `delivery_mode`, target session, source session, `consumed_by_session_id`, delivered/consumed timestamps, dispatcher heartbeat, and command attempt linkage for routed notifications.
- A disposable no-tmux QA drill proves manager-to-worker and worker-to-manager dispatcher signals are both delivered by inbox polling.
- Tests cover the new ergonomics/observability behavior.
- `python3 -m unittest tests.test_workerctl -v` passes.
- `git diff --check` passes.
- PR review toolkit reports no actionable findings before merge.

## Stop Rule

Stop only when a final audit proves the no-tmux Codex app dispatcher inbox workflow is ergonomic, visible, tested, documented, and live-QA proven, with no required Worker task queued or active.

Do not stop at planning, documentation alone, or a backend-only proof if an operator-facing gap remains.

Do not mark complete unless a final Judge/PM receipt records `full_outcome_complete: true`.

## Canonical Board

Machine truth lives at:

`docs/goals/codex-app-dispatch-inbox-ops/state.yaml`

If this charter and `state.yaml` disagree, `state.yaml` wins.

## Run Command

```text
/goal Follow docs/goals/codex-app-dispatch-inbox-ops/goal.md.
```
