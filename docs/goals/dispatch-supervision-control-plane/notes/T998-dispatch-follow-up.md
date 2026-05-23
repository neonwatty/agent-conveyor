# T998 Dispatch Follow-Up Handoff

## Decision

T010 chose `defer_follow_up` for #113 Phase 2+.

The current tranche implemented:

- #115 categorized manager permissions and tools.
- #114 worker/manager acknowledgement records.
- #113 Phase 1 worker completion routing from `codex_events` to bound manager notification.
- #116 minimal epilogue framework and finish gating.
- #117 dual continuation proposal/review persistence, ordering enforcement, reviewer isolation metadata, and replay visibility.

## Deferred #113 Acceptance Criteria

The remaining #113 work should become a separate Dispatch command queue/watch tranche:

- `workerctl dispatch --once` processes explicit pending command rows.
- `workerctl dispatch --watch` continuously routes signals and processes pending command rows.
- Command claiming is atomic and safe with multiple dispatch processes.
- Dispatch records command attempts, results, errors, timestamps, dispatcher identity, side-effect started/completed metadata, and `correlation_id` end-to-end.
- Invalid command payloads fail without side effects.
- Failed dispatch executions are visible through CLI/telemetry and dashboard observation.
- `replay` reconstructs the full `correlation_id` chain from `manager_decision` through command attempt/routed notification to the next `manager_cycle`.
- Dashboard observation shows queued command, dispatch success/failure, stale claim, and grouped correlation chains.

## Follow-Up Tranche Text

Implement #113 Dispatch command queue/watch phases:

1. Add additive command claim/lease metadata or a `command_attempts` table with `correlation_id`.
2. Implement atomic command claiming safe across multiple dispatch processes.
3. Process explicit `notify_manager` and `nudge_worker` command rows through `workerctl dispatch --once`.
4. Record conservative side-effect started/completed result metadata and invalid-payload failure handling.
5. Implement `workerctl dispatch --watch` with dispatcher identity, heartbeat, interval, and shutdown behavior.
6. Add replay/dashboard grouping by `correlation_id` for `manager_decision -> command -> dispatch_attempt -> routed_notification -> next manager_cycle`.

Non-goals remain strict: Dispatch must not decide task success, satisfy or reject acceptance criteria, invent next work, choose strategy, finish tasks, merge PRs, or route to human operators.
