# T002 Judge Receipt

## Decision

Approved.

## Implementation Slice

Implement `conveyor app-wakeup-dispatch TASK [--dispatcher-id ID] [--stale-after N] [--json]`.

The command does not send direct Codex app messages. It produces adapter-ready wake actions for the Codex app/operator layer and records a durable Conveyor telemetry receipt that the wake orchestration decision was made.

## Allowed Files

- `src/runtime/app-autonomy.ts`
- `src/cli/typescript-runtime.ts`
- `src/cli/typescript-runtime.test.ts`
- `src/index.ts`
- `README.md`
- `docs/manager-recipes.md`
- `docs/manual-qa-checklist.md`
- `scripts/package-smoke`
- `skills/manage-codex-workers/SKILL.md`
- `docs/goals/codex-app-wake-orchestration/state.yaml`
- `docs/goals/codex-app-wake-orchestration/notes/*`

## Acceptance Criteria

- `app-wakeup-dispatch --json` includes the underlying loop status and dispatcher requirement.
- Stale manager and stale worker roles produce role actions with prompt, thread id/title, reason, and `send_ready=true` when a thread id exists.
- Stale roles without a Codex app thread id are not marked send-ready and include an explicit blocker reason.
- Healthy manager/worker roles are represented as skipped, not woken.
- Missing or stale Dispatch remains visible as `dispatcher.required=true`; app wake readiness must not make the loop healthy.
- The command emits telemetry with counts and action summaries so a manager/judge can audit prepared, skipped, and blocked wake actions.
- Existing `app-wakeup-plan` behavior remains compatible.
- Package smoke covers one healthy no-wakeup case and one stale wake orchestration case.
- Docs and skill explain that the command prepares app-thread messages and receipts; actual `send_message_to_thread` remains an app/operator action.

## Verification Commands

- `npm test -- --runInBand`
- `npm run build:cli`
- `scripts/package-smoke`
- `scripts/release-check`
- `node /Users/neonwatty/.codex/plugins/cache/goalbuddy/goalbuddy/0.3.8/skills/goalbuddy/scripts/check-goal-state.mjs docs/goals/codex-app-wake-orchestration/state.yaml`
- `git diff --check`

## Stop Conditions

- The implementation would require raw terminal package code to call Codex app-only tools directly.
- Delivery mode or Dispatch inbox semantics would need to change.
- The command cannot keep missing Dispatch visible as unhealthy.
- Required changes exceed the allowed file list.

