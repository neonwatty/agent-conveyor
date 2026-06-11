# T003 Worker Receipt

## Result

Done.

## Implementation

- Added `conveyor app-wakeup-record-delivery`.
- The command validates a delivery report against a prior `app_wakeup_dispatch_planned` telemetry receipt.
- `sent` is allowed only when the source action is `ready_to_send`, `send_ready=true`, and the supplied `--thread-id` matches the source action thread id.
- `skipped` is allowed only for `skipped_healthy`.
- `blocked` is allowed only for `blocked_missing_thread`.
- Successful records emit `app_wakeup_delivery_recorded` telemetry and return the event id.

## Evidence

- `npm test -- --runInBand src/cli/typescript-runtime.test.ts` passed: 173 tests, 0 failures.
- `npm run build:cli` passed.
- Tests prove sent receipts, rejected sent-for-skipped, blocked missing-thread receipts, and sent rejection for blocked actions.

