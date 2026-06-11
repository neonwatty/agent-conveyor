# T001 Scout Receipt

## Result

Done.

## Evidence

- `src/runtime/app-autonomy.ts` defines `appLoopStatusSync`, `appWakeupPlanSync`, `appHeartbeatPollCommand`, `appLoopStatusCommand`, `appWakeupPlanCommand`, `directInboxPollCommand`, and `roleWakeup`.
- `appLoopStatusSync` reads the active binding, manager and worker session heartbeats, optional Codex app thread ids/titles, and latest `dispatch_watch_heartbeat` telemetry for the requested dispatcher id.
- `appLoopStatusSync` returns `next_actions` for `start_dispatch`, `wake_manager`, and `wake_worker`, and sets `ok` only when dispatch, manager, and worker leases are healthy.
- `appWakeupPlanSync` creates stale manager/worker prompts and a dispatch command, but it does not emit telemetry or record orchestration attempts/skips.
- `src/cli/typescript-runtime.ts` exposes `app-heartbeat`, `app-loop-status`, and `app-wakeup-plan` commands. `app-heartbeat` records `app_heartbeat` telemetry; the status and plan commands are read-only.
- `src/cli/typescript-runtime.test.ts` covers app heartbeat, stale worker plus missing dispatch status, and stale-role wakeup prompt generation.
- `scripts/package-smoke` creates an app-loop disposable binding, records manager/worker app heartbeats, starts bounded dispatch, and verifies healthy status produces zero wakeups.
- `README.md`, `docs/manager-recipes.md`, and `skills/manage-codex-workers/SKILL.md` document app heartbeat, app loop status, and app wakeup planning. The skill explicitly says app thread messages do not replace Dispatch/inbox receipts.

## Current Boundary

The package can decide what should be woken, but it cannot directly call Codex app-only `send_message_to_thread` from terminal-only code. The safe boundary is an adapter-ready orchestration receipt: Conveyor should compute required wake actions, identify whether each action is send-ready, record why actions were prepared or skipped, and leave actual app-thread delivery to the Codex app operator/tool layer.

## Missing Pieces

- No command currently records an orchestration receipt for wake attempts/skips.
- No structured output distinguishes `ready_to_send`, `blocked_missing_thread`, `skipped_healthy`, and `requires_dispatch`.
- No telemetry proves the operator considered a stale loop and intentionally prepared or skipped wake actions.
- Package smoke covers healthy zero-wakeup behavior but not stale-role orchestration receipts.

## Failure Modes

- A successful app-thread message could hide missing Dispatch heartbeat unless orchestration output keeps dispatch state authoritative.
- A healthy manager/worker could be woken unnecessarily because a prompt is available.
- A no-thread-id session could be treated as send-ready, causing app automation to target nothing.
- A stale role could be reported only in text, leaving no durable receipt for audit.

## Recommended Worker Slice

Add a package-runtime orchestration command, tentatively `app-wakeup-dispatch`, that:

- Reuses `appWakeupPlanSync`.
- Returns adapter-ready wake actions and skip reasons.
- Marks app-thread send readiness without sending direct app-thread messages.
- Emits telemetry receipt(s) for prepared/skipped wake orchestration.
- Adds tests for stale manager, stale worker, healthy loop, missing dispatch, and missing thread/skipped cases.

