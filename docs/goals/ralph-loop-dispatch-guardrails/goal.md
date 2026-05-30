# Ralph Loop Dispatch Guardrails

## Objective

Make Ralph/ROF loop continuation a durable, policy-gated workflow so Dispatch can refuse manager requests that violate preset loop constraints before any invalid "run another iteration" message reaches the worker.

## Original Request

Plan this out with GoalBuddy prep, including a new browser QA test case with precise acceptance criteria, for dispatcher-enforced Ralph-loop guardrails.

## Intake Summary

- Input shape: `specific`
- Audience: `workerctl` operators, Ralph-loop managers, Codex workers, Dispatch maintainers, and dashboard QA reviewers.
- Authority: `requested`
- Proof type: `test + demo + review`
- Completion proof: A merged implementation with automated tests and a browser QA walkthrough proves a manager can request another iteration after `max_iterations`, Dispatch blocks delivery, the worker never receives the message, and the dashboard/replay/audit surfaces show the blocked reason and loop state.
- Goal oracle: A browser-backed QA scenario starts a loop with `max_iterations=1`, completes iteration 1, has the manager request iteration 2, and proves Dispatch records `blocked/max_iterations_reached` with `delivered=false` and no worker inbox/tmux delivery.
- Likely misfire: Implementing docs or a manager-side reminder only, while Dispatch still delivers invalid continuation messages to workers.
- Blind spots considered:
  - Dispatch must enforce mechanical policy without deciding task correctness, PR quality, or whether the manager's strategic choice is good.
  - The manager must receive a refusal receipt so the workflow stays visible instead of silently dropping commands.
  - Codex app and tmux workers must share the same policy gate, even though delivery transport differs.
  - Browser QA must prove the negative case: the worker did not receive the blocked iteration.
  - Operator overrides, if allowed later, must be explicit and separately permission-gated.
- Existing plan facts:
  - Ralph-loop runs have seed prompts, iterations, correlation ids, manager decisions, CI/PR/merge evidence, handoff, clear/compact policy, and stop conditions.
  - Dispatch already routes queued commands, records command attempts, maintains routed notifications, and supports inbox polling for no-tmux sessions.
  - Dashboard/replay/audit already expose dispatch chains and inbox delivery/consumption evidence.

## Goal Oracle

The oracle for this goal is:

`A local browser QA walkthrough shows a Ralph loop with max_iterations=1 where the manager requests one more iteration, Dispatch blocks the command before delivery, the worker inbox remains empty, and dashboard/replay/audit show the blocked command attempt with reason max_iterations_reached, current/max iteration counts, manager decision id, and correlation id.`

The PM must keep comparing task receipts to this oracle. Planning, discovery, a passing backend-only unit test, or a dashboard-only mock is not enough. The goal finishes only when a final Judge/PM audit maps receipts and verification back to this oracle and records `full_outcome_complete: true`.

## Goal Kind

`specific`

## Current Tranche

Deliver the first useful Ralph-loop guardrail slice:

1. Preserve the manager-led model: managers express intent, Dispatch enforces preconfigured mechanical constraints, and workers only receive valid work.
2. Add or validate a durable loop state model for max iterations, current iteration, cleanup policy, stop conditions, and continuation commands.
3. Block invalid `continue_iteration` delivery in Dispatch before tmux push or session inbox creation.
4. Record refusal receipts for the manager and operator surfaces.
5. Add dashboard/browser QA showing both the blocked decision and the absence of worker delivery.
6. Verify with automated tests, browser walkthrough, PR review, and final audit.

## Non-Negotiable Constraints

- Dispatch must not decide task success, acceptance criteria, PR quality, CI meaning, merge readiness, or next strategic work.
- Dispatch may enforce only explicit loop policy and mechanical preconditions such as `max_iterations`, required cleanup, missing handoff, missing merge evidence, missing CI-green evidence, missing permission, or exhausted budget.
- A blocked continuation must not create a worker-directed routed notification and must not push to tmux.
- The manager must receive a refusal receipt with a machine-readable reason.
- Guardrails must work for both tmux-backed workers and Codex app workers that poll `worker-inbox`.
- Preserve existing Dispatch behavior for non-loop commands unless the command is explicitly loop-scoped.
- Browser QA must prove the negative worker-delivery case, not only the visible blocked badge.

## Acceptance Criteria

- A Ralph-loop run can persist `max_iterations`, `current_iteration`, `cleanup_policy`, `stop_conditions`, `manager_session`, `worker_session`, and the seed prompt hash or equivalent run identity.
- A manager continuation request is represented as a durable command or loop decision with correlation id and manager decision linkage.
- When `current_iteration >= max_iterations`, Dispatch refuses the continuation before delivery.
- Refusal records include `state=blocked` or equivalent, `reason=max_iterations_reached`, `delivered=false`, `target_worker_notified=false`, `current_iteration`, `max_iterations`, command id, manager decision id, and correlation id.
- The worker receives no tmux push and no worker inbox item for the blocked continuation.
- The manager can see the refusal through manager inbox, command output, dashboard, replay, or audit.
- Dashboard/browser QA shows loop policy, current/max iteration count, blocked continuation reason, and no worker pending notification.
- Automated tests cover the max-iteration block and at least one allowed continuation path.
- Browser QA test case covers: create loop with `max_iterations=1`, complete iteration 1, request iteration 2, observe Dispatch block, verify worker inbox remains empty, and verify dashboard/replay/audit evidence.
- `python3 -m unittest tests.test_workerctl -v` passes.
- Dashboard tests/build pass if dashboard files change.
- `git diff --check` passes.
- PR review toolkit reports no actionable findings before merge.

## Stop Rule

Stop only when a final audit proves the full guarded continuation workflow is implemented, visible, tested, browser-QA-proven, reviewed, and ready to merge.

Do not stop after planning, discovery, data-model design, backend-only tests, or dashboard-only rendering if the worker-delivery block is not proven.

Do not mark complete unless a final Judge/PM receipt records `full_outcome_complete: true`.

## Canonical Board

Machine truth lives at:

`docs/goals/ralph-loop-dispatch-guardrails/state.yaml`

If this charter and `state.yaml` disagree, `state.yaml` wins for task status, active task, receipts, verification freshness, and completion truth.

## Run Command

```text
/goal Follow docs/goals/ralph-loop-dispatch-guardrails/goal.md.
```

