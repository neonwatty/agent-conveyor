# Dispatch Command Queue Watch

## Objective

Implement the deferred #113 Dispatch command queue/watch tranche: atomic command claiming, durable attempt history, `notify_manager` and `nudge_worker` command execution through Dispatch, watch mode, failure visibility, and replay/dashboard correlation-chain surfaces.

## Original Request

"plan it out with $goalbuddy:goal-prep"

## Intake Summary

- Input shape: `existing_plan`
- Audience: `workerctl` operators, managers, workers, and dashboard users.
- Authority: `requested`
- Proof type: `test`
- Completion proof: Dispatch can safely process explicit queued commands in `--once` and `--watch` modes with atomic claiming, conservative tmux side-effect audit, replay/telemetry visibility, and no Dispatch judgment behavior.
- Goal oracle: a final Judge/PM audit maps #113 deferred acceptance criteria to implemented schema, CLI behavior, command execution semantics, replay/dashboard visibility, and passing tests.
- Likely misfire: implementing a simple polling loop or direct tmux send path while leaving atomic claim safety, side-effect ambiguity, invalid-payload failure, or correlation-chain audit unproven.
- Blind spots considered: non-idempotent tmux sends, double-claim races, stale leases, direct nudge compatibility, dashboard grouping scope, and Dispatch accidentally becoming a decision maker or human notifier.
- Existing plan facts: the prior tranche merged as PR #118 and explicitly deferred #113 command row processing, atomic command claiming, command attempts, `dispatch --watch`, invalid payload handling, stale claim recovery, replay correlation chains, and dashboard observation grouping.

## Goal Oracle

The oracle for this goal is:

`A final audit proves that workerctl Dispatch mechanically claims and executes queued notify/nudge commands safely in one-shot and watch modes, records durable attempts and failures with correlation_id, exposes the chain in replay/dashboard surfaces, and still does not decide task success or route to human operators.`

## Goal Kind

`existing_plan`

## Current Tranche

Implement #113 Phase 2+ in safe slices:

1. Validate current command/dispatch schema and choose the smallest additive claim/attempt model that preserves existing direct commands.
2. Add atomic command claim and durable attempt history.
3. Process `notify_manager` and `nudge_worker` command rows in `workerctl dispatch --once`.
4. Add replay/telemetry visibility for command attempts and correlation chains.
5. Add `workerctl dispatch --watch` with heartbeat, interval, shutdown, and limit/type behavior.
6. Add dashboard observation surfaces only after DB/replay semantics are stable.

## Non-Negotiable Constraints

- Dispatch must not decide task success, acceptance criteria, strategy, PR merging, final task state, next work, or manager decisions.
- Dispatch must not route to human operators.
- Existing direct nudge/session commands must remain available during migration.
- Tmux side effects are not safely idempotent; if a side effect may have started, record that risk and do not blindly retry.
- Command claiming must be atomic and safe with multiple dispatch processes.
- `correlation_id` must remain the audit spine for manager decision, command, attempt, routed notification, and later cycle visibility.
- Schema changes should be additive.
- Do not touch unrelated dirty work, especially the pre-existing `dashboard/client/styles.css` change, unless a later Worker task explicitly includes dashboard work and the user has resolved that dirty file.

## Canonical Board

Machine truth lives at:

`docs/goals/dispatch-command-queue-watch/state.yaml`

If this charter and `state.yaml` disagree, `state.yaml` wins.

## Run Command

```text
/goal Follow docs/goals/dispatch-command-queue-watch/goal.md.
```

## PM Loop

On every `/goal` continuation:

1. Read this charter and `state.yaml`.
2. Work only on the active board task.
3. Keep Scout/Judge tasks read-only.
4. Keep Worker writes inside `allowed_files`.
5. Write compact receipts before advancing the board.
6. Continue through safe local work until final audit proves the tranche complete or a specific task is blocked.
7. Finish only with a final audit receipt that records `full_outcome_complete: true`.
