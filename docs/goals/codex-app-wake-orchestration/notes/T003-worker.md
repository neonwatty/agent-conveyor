# T003 Worker Receipt

## Result

Done.

## Implementation

- Added `appWakeupDispatchPlanSync` in `src/runtime/app-autonomy.ts`.
- Added `conveyor app-wakeup-dispatch TASK [--dispatcher-id ID] [--stale-after N] [--json]` in `src/cli/typescript-runtime.ts`.
- Exported the new runtime function and types from `src/index.ts`.
- Added focused CLI tests for ready stale wake actions, healthy skips with missing Dispatch preserved, and blocked stale roles without a Codex app thread id.

## Behavior

- The command reuses the app-loop status/wakeup planning source of truth.
- It returns two role actions, one for manager and one for worker.
- A stale role with a registered Codex app thread id is `ready_to_send`.
- A healthy role is `skipped_healthy`.
- A stale role without a Codex app thread id is `blocked_missing_thread`.
- Missing or stale Dispatch remains visible through `dispatcher.required` and does not make the loop healthy.
- The command emits `app_wakeup_dispatch_planned` telemetry and returns the telemetry event id as a receipt.
- It does not call `send_message_to_thread`; that remains an app/operator adapter action.

## Evidence

- `npm test -- --runInBand src/cli/typescript-runtime.test.ts` passed: 170 tests, 0 failures.
- `npm run build:cli` passed.
- `scripts/package-smoke` initially failed because the stale smoke fixture had fresh session heartbeats, proving the smoke check was meaningful. After explicitly aging the smoke fixture heartbeats, `scripts/package-smoke` passed.

