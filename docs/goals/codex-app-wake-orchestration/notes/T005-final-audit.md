# T005 Final Judge Audit

## Decision

Pass.

## Evidence Table

| Requirement | Evidence |
| --- | --- |
| Inspect manager/worker/dispatch heartbeat status | `appWakeupDispatchPlanSync` reuses `appWakeupPlanSync` and `appLoopStatusSync`; tests verify status includes manager, worker, and dispatch state. |
| Decide which role should be woken | Tests verify stale manager/worker roles become `ready_to_send`, healthy roles become `skipped_healthy`, and missing thread ids become `blocked_missing_thread`. |
| Preserve Dispatch/inbox truth | `app-wakeup-dispatch` does not send direct app-thread messages and keeps `dispatcher.required=true` when Dispatch is missing. |
| Record receipts | Command emits `app_wakeup_dispatch_planned` telemetry and returns the event id in `receipt`. |
| Docs and skill guidance | README, manager recipes, manual QA checklist, package smoke, and `manage-codex-workers` skill document the command and adapter boundary. |
| Package smoke | `scripts/package-smoke` passed and verifies healthy skipped wake dispatch plus stale send-ready wake dispatch. |

## Commands

- `npm test -- --runInBand`: pass, 170 tests, 0 failures.
- `npm run build:cli`: pass.
- `scripts/package-smoke`: pass.
- `scripts/release-check`: pass.
- `node /Users/neonwatty/.codex/plugins/cache/goalbuddy/goalbuddy/0.3.8/skills/goalbuddy/scripts/check-goal-state.mjs docs/goals/codex-app-wake-orchestration/state.yaml`: pass after receipt schema repair.
- `git diff --check`: pass.
- Strongest failure-mode probe: pass. A disposable app loop with stale manager and worker app-thread leases but missing Dispatch produced `ready_to_send=2`, `dispatcher.required=true`, `dispatcher.state=missing`, and `status.ok=false`.

## Strongest Failure Mode

The dangerous failure mode is that app-thread wake readiness could make the loop look healthy even when Dispatch is missing. The probe disproved that: two app wake actions were send-ready, but Dispatch was still required and the loop remained unhealthy.

## Close / Supersede Recommendation

Close this board as complete. It supersedes the previous static-only wakeup planning gap by adding an auditable orchestration receipt command. It does not supersede future app-native `send_message_to_thread` automation; that should remain a separate adapter-layer slice.

## Next Single Worker Task

Open a PR for `codex/codex-app-wake-orchestration-goal`, wait for CI, and merge only when green. After merge, consider a follow-up board for a Codex app operator adapter that consumes `app-wakeup-dispatch` output and calls `send_message_to_thread` from app sessions.

