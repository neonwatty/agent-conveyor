# T002 Judge Receipt

## Decision

Approved.

## Rationale

Scout found the correct implementation surface already exists: `create-disposable-binding` returns `heartbeat_recommendations` and `worker_handoff`, and tests already assert most autonomy-critical prompt content. The safest largest slice is to extend that generated bootstrap surface rather than introduce a new app-thread control plane.

The package must still not call `create_thread` or `send_message_to_thread`. Those remain Codex app/operator actions described by skill/docs.

## Implementation Boundary

Implement one mixed package + skill/docs/smoke slice:

- Add generated `app-wakeup-dispatch` command guidance to bootstrap recommendations.
- Add generated `app-wakeup-record-delivery` command template/guidance for sent/skipped/blocked wake outcomes.
- Put the wake-dispatch and delivery-receipt procedure into the manager bootstrap prompt.
- Keep worker prompt focused on heartbeat, inbox polling, execution evidence, idle receipt, and no teardown authority.
- Update tests so omission of heartbeat, inbox, Dispatch/wake recovery, delivery receipts, or evidence/one-next-task rules fails.
- Update docs/skill/smoke to point operators at generated bootstrap output instead of reconstructing commands manually.

## Allowed Files

- `src/cli/typescript-runtime.ts`
- `src/cli/typescript-runtime.test.ts`
- `README.md`
- `docs/manager-recipes.md`
- `docs/manual-qa-checklist.md`
- `skills/manage-codex-workers/SKILL.md`
- `scripts/package-smoke`
- `docs/goals/codex-app-session-bootstrap-templates/state.yaml`
- `docs/goals/codex-app-session-bootstrap-templates/notes/*`

## Acceptance Criteria

- Generated bootstrap recommendations include exact `app-heartbeat`, direct inbox, `app-loop-status`, `app-wakeup-dispatch`, and `app-wakeup-record-delivery` guidance.
- Manager prompt instructs the manager to use `app-wakeup-dispatch`, send only `send_ready=true` actions with app-thread tools, record sent outcomes with `app-wakeup-record-delivery`, record healthy actions as skipped, record missing-thread actions as blocked, require evidence, and produce exactly one next worker task.
- Worker prompt preserves heartbeat, worker inbox polling, exact command/evidence reporting, idle receipt, and no teardown authority.
- Tests fail if the generated manager/worker bootstrap prompts omit heartbeat, inbox, Dispatch/wake recovery, delivery receipts, evidence requirements, or one-next-task discipline.
- Docs/skill preserve the boundary that package code generates prompts/receipts while Codex app tools create/send threads.
- No private thread content is inspected and no app messages are sent except to explicitly disposable threads if later approved.

## Verification Commands

- `npm test -- --runInBand src/cli/typescript-runtime.test.ts`
- `npm run build:cli`
- `scripts/package-smoke`
- `./bin/conveyor install-skills --json`
- `node /Users/neonwatty/.codex/plugins/cache/goalbuddy/goalbuddy/0.3.8/skills/goalbuddy/scripts/check-goal-state.mjs docs/goals/codex-app-session-bootstrap-templates/state.yaml`
- `git diff --check`

## Stop Conditions

- Need terminal package code to call `create_thread` or `send_message_to_thread`.
- Need to send a message to a non-disposable/private thread for verification.
- Existing `create-disposable-binding` output cannot represent wake-dispatch/delivery receipt guidance without a broader API redesign.
- Prompt tests cannot assert the autonomy-critical clauses directly.

## Board Action

T004 is superseded by the approved T003 Worker package because docs, skill, and smoke changes are part of the same prompt-contract surface and should be verified together.
