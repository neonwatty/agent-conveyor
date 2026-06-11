# T002 Judge Receipt

## Decision

Approved.

## Implementation Boundary

Implement a mixed package + skill slice. The package records and validates delivery receipts; the Codex app skill/operator layer performs the actual `send_message_to_thread` call.

The terminal CLI must not call Codex app tools.

## Allowed Files

- `src/cli/typescript-runtime.ts`
- `src/cli/typescript-runtime.test.ts`
- `README.md`
- `docs/manager-recipes.md`
- `docs/manual-qa-checklist.md`
- `scripts/package-smoke`
- `skills/manage-codex-workers/SKILL.md`
- `docs/goals/codex-app-wake-adapter/state.yaml`
- `docs/goals/codex-app-wake-adapter/notes/*`

## Acceptance Criteria

- `app-wakeup-record-delivery` records `sent` only for a referenced action with `send_ready=true` and `status=ready_to_send`.
- `sent` requires a matching `--thread-id`.
- Attempts to record `sent` for `skipped_healthy` or `blocked_missing_thread` fail before telemetry mutation.
- `skipped` and `blocked` receipts are valid only for matching source action states.
- Output includes the linked dispatch receipt id and whether Dispatch was required.
- Skill/docs instruct app managers to call `send_message_to_thread` only between `app-wakeup-dispatch` and `app-wakeup-record-delivery`.
- Verification does not send app messages to private/non-disposable threads.

## Verification Commands

- `npm test -- --runInBand src/cli/typescript-runtime.test.ts`
- `npm run build:cli`
- `scripts/package-smoke`
- `node /Users/neonwatty/.codex/plugins/cache/goalbuddy/goalbuddy/0.3.8/skills/goalbuddy/scripts/check-goal-state.mjs docs/goals/codex-app-wake-adapter/state.yaml`
- `git diff --check`

## Stop Conditions

- Need terminal package code to call `send_message_to_thread`.
- Need to send a message to a non-disposable/private thread for verification.
- Cannot validate delivery reports against the planned wake receipt.

