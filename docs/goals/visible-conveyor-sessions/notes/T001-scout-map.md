# T001 Scout Map: Visible Conveyor Sessions

## Summary

The transport already supports the desired model: app/no-tmux sessions poll role inboxes, consumed items emit `dispatch_inbox_consumed`, and workers/managers enqueue durable follow-up commands. The gap is prompt/protocol visibility: generated handoff and heartbeat prompts tell agents what commands to run, but they do not require a live, structured transcript in the actual consuming/sending session.

## Prompt Surfaces To Change

- `src/runtime/app-autonomy.ts:509-542`: `roleWakeup` builds app heartbeat prompts used by app wakeups and app-autopilot automation specs. It needs visible `CONVEYOR POLL`, `CONVEYOR RECEIVED`, `WORK`, `CONVEYOR SEND`, and `DISPATCH` transcript requirements for consumed items.
- `src/runtime/app-autonomy.ts:300-327`: `appAutopilotPlanSync` emits heartbeat automation specs from `roleWakeup`, so changing `roleWakeup` covers `app-autopilot start` prompts.
- `src/cli/typescript-runtime.ts:19612-19632`: `disposableWorkerHandoff` builds the generated worker bootstrap for `create-disposable-binding`. It needs to require visible consumed-item and outgoing notify/dispatch output.
- `src/cli/typescript-runtime.ts:19700-19770`: `disposableHeartbeatRecommendations` builds disposable manager/worker heartbeat prompts. Both need the live protocol; idle polls may stay one-line.
- `skills/manage-codex-workers/SKILL.md:59-110`: durable communication guidance is correct, but it needs to say the live session transcript is the primary human-reviewable surface and SQLite/replay/status is backup proof.
- `README.md:168-180`, `README.md:371-381`, and `README.md:812-815`: docs describe durable notify/dispatch but not the operator expectation for live session readability.
- `docs/manager-recipes.md:251-268` and `docs/manager-recipes.md:302-321`: recipe docs describe app inbox polling and idle receipts but not the non-silent consumed-item protocol.

## Status Surfaces That Can Mislead

- `src/cli/typescript-runtime.ts:18790-18815`: `loopStatusSummarySync` reports commands, notifications, and telemetry matched to a Ralph loop run.
- `src/cli/typescript-runtime.ts:18818-18829`: `telemetryEventsForRunSync` filters by `task_id` and exact `run_id`. This explains the Deckchecker mismatch: task-level `notify_manager`/`nudge_worker` traffic was real, but `loop-status --run` reported zeros because those rows were not linked to the finished Ralph run.
- `src/cli/typescript-runtime.ts:18925-18943`: text rendering prints the run-scoped zeroes without warning when task-level app Dispatch traffic exists.
- `src/runtime/app-autonomy.ts:603-614`: app-autopilot quiescence already anchors on task-level `command_created` and `dispatch_inbox_consumed`, making it a better status model for app-native traffic.

## Existing Tests To Extend

- `src/cli/typescript-runtime.test.ts:2684-2860`: `create-disposable-binding` already asserts worker handoff and disposable heartbeat prompt contents. Extend it for the visible-session protocol phrases in worker handoff, manager heartbeat prompt, and worker heartbeat prompt.
- `src/cli/typescript-runtime.test.ts:809-875`: `app-autopilot start` asserts automation prompt generation. Extend it so both automation specs include the visible-session protocol.
- `src/cli/typescript-runtime.test.ts:2296-2554`: `loop-status` proves run scoping. Use a later package for warnings/fallback summaries when run-scoped counts are zero but task-level app traffic exists.

## Recommended First Worker Package

Implement the visible-session prompt protocol first, without changing transport or status semantics.

Allowed files:

- `skills/manage-codex-workers/SKILL.md`
- `src/cli/typescript-runtime.ts`
- `src/runtime/app-autonomy.ts`
- `src/cli/typescript-runtime.test.ts`
- `README.md`
- `docs/manager-recipes.md`
- `scripts/package-smoke`

Worker objective:

Add a shared visible-session protocol to generated app-native manager/worker prompts so any consumed inbox item must be rendered live in the consuming session before action and summarized again before final answer. The protocol must include visible poll, received instruction, work/evidence, outgoing Conveyor send, and dispatch-result sections. Idle polls may remain one-line receipts.

Verify:

- `pnpm test -- src/cli/typescript-runtime.test.ts`
- `pnpm test`
- `npm pack --dry-run`
- `git diff --check`

Stop if:

- Prompt ownership is unclear beyond the mapped files.
- The only feasible fix is after-the-fact transcript replay.
- Tests cannot assert generated prompt content.
- Changes require schema or dashboard work.

## Deferred Package

Status repair should be a second package. The run-scoped `loop-status` behavior is deliberate, but app-native loops need a warning or task-level companion summary when run-scoped counts are zero and task-level Dispatch traffic exists.
