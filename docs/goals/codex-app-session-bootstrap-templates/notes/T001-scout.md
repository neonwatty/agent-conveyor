# T001 Scout Receipt

## Result

Done.

## Tool Availability

Current Codex app tool discovery exposed:

- `codex_app.create_thread`
- `codex_app.send_message_to_thread`
- `codex_app.list_threads`
- `codex_app.set_thread_title`
- `codex_app.set_thread_pinned`
- `codex_app.set_thread_archived`
- `codex_app.handoff_thread`

No app-thread messages were sent during this Scout task.

## Current Surfaces

- Session registration stores optional Codex app thread metadata through `codex_app_thread_id` and `codex_app_thread_title`; see `src/runtime/codex-session.ts:162` and `src/runtime/codex-session.ts:192`.
- Session communication classifies no-tmux Codex sessions as pull-required and emits role-specific inbox polling commands; see `src/runtime/codex-session.ts:379` and `src/runtime/codex-session.ts:400`.
- App loop status/wakeup code produces heartbeat, loop status, wake plan, and direct inbox commands; see `src/runtime/app-autonomy.ts:239`, `src/runtime/app-autonomy.ts:306`, and `src/runtime/app-autonomy.ts:318`.
- `app-wakeup-dispatch` already distinguishes `ready_to_send`, `skipped_healthy`, and `blocked_missing_thread`; see `src/runtime/app-autonomy.ts:251`.
- `app-wakeup-record-delivery` records sent/skipped/blocked outcomes linked to `app_wakeup_dispatch_planned`; see `src/cli/typescript-runtime.ts:3791`.
- `create-disposable-binding` already generates `worker_handoff` and `heartbeat_recommendations`; see `src/cli/typescript-runtime.ts:19440` and `src/cli/typescript-runtime.ts:19457`.
- Generated heartbeat recommendations include `interval_minutes=2`, manager/worker `app-heartbeat` commands, direct inbox commands, `app-loop-status`, `app-wakeup-plan`, and teardown policy; see `src/cli/typescript-runtime.ts:19513`.

## Current Docs And Skill Guidance

- README says the terminal CLI does not create Codex app threads and that the Codex app tool layer should use `create_thread`, `set_thread_title`, and `send_message_to_thread`; see `README.md:169`.
- README documents registration, `create-disposable-binding`, app heartbeat/status/wakeup, and delivery receipt commands; see `README.md:328` and `README.md:362`.
- README states app thread metadata is navigation metadata and durable communication remains routed notifications plus inbox consumption telemetry; see `README.md:1058`.
- Manager recipe documents the Codex app native loop and preserves Dispatch/inbox authority; see `docs/manager-recipes.md:275`.
- Installed skill guidance already instructs `create_thread`, `create-disposable-binding`, Dispatch, app heartbeat, `send_message_to_thread`, `app-wakeup-dispatch`, and `app-wakeup-record-delivery`; see `skills/manage-codex-workers/SKILL.md:38`, `skills/manage-codex-workers/SKILL.md:95`, and `skills/manage-codex-workers/SKILL.md:751`.

## Live/Dry-Run Evidence

`./bin/conveyor create-disposable-binding bootstrap-scout-task --worker bootstrap-scout-worker --manager bootstrap-scout-manager --worker-codex-app-thread-id worker-thread-scout --worker-codex-app-thread-title 'Scout Worker Thread' --manager-codex-app-thread-id manager-thread-scout --manager-codex-app-thread-title 'Scout Manager Thread' --path <temp-db> --json` returned:

- `worker.communication.session_kind=codex_app`, `receive_style=pull`, `delivery_mode=pull_required`
- `manager.communication.session_kind=codex_app`, `receive_style=pull`, `delivery_mode=pull_required`
- `heartbeat_recommendations.interval_minutes=2`
- role-specific `app-heartbeat` poll commands
- role-specific direct `manager-inbox` / `worker-inbox` commands
- `status_command` for `app-loop-status`
- `wakeup_plan_command` for `app-wakeup-plan`
- `worker_handoff`

The dry-run also exposed the current gap: generated bootstrap recommendations include `app-wakeup-plan`, but do not include an explicit `app-wakeup-dispatch` command, `app-wakeup-record-delivery` command template, or in-prompt send/skip/block receipt procedure. That procedure exists in docs/skill, but not in the generated prompt surface that tests already inspect.

## Current Test Coverage

`src/cli/typescript-runtime.test.ts:2377` covers `create-disposable-binding` JSON output. It asserts:

- thread ids/titles are preserved
- sessions are `codex_app` pull targets
- manager/worker inbox poll commands
- heartbeat interval and `app-heartbeat` commands
- `app-loop-status`
- `app-wakeup-plan`
- teardown policy
- manager prompt includes exactly one next worker task discipline
- worker prompt includes idle receipt and heartbeat safety

It does not currently assert `app-wakeup-dispatch`, `app-wakeup-record-delivery`, or send/skipped/blocked delivery receipt instructions in the generated bootstrap prompts.

## Recommendation

Use a mixed package + skill slice.

Package side:

- Extend the existing `heartbeat_recommendations`/bootstrap generation rather than creating a separate app-thread control plane.
- Add generated fields or prompt text for:
  - `app-wakeup-dispatch <task> --path <db> --json`
  - `app-wakeup-record-delivery <task> --role <role> --dispatch-receipt <receipt.event_id> --delivery-status sent --thread-id <action.thread.id> --path <db> --json`
  - skipped/blocked receipt handling for `skipped_healthy` and `blocked_missing_thread`
  - explicit reminder that direct app-thread delivery is not task completion
- Keep Codex app-only calls (`create_thread`, `send_message_to_thread`, title/pin/archive) in skill/operator guidance only.

Skill/docs side:

- Tighten the app-native setup recipe so it tells operators to use the generated bootstrap fields rather than reconstructing command strings manually.
- Preserve current fallback when app thread tools are unavailable: manual paste/open sessions.

## Suggested Worker Boundary

Allowed files for the first Worker slice:

- `src/cli/typescript-runtime.ts`
- `src/cli/typescript-runtime.test.ts`
- `README.md`
- `docs/manager-recipes.md`
- `docs/manual-qa-checklist.md`
- `skills/manage-codex-workers/SKILL.md`
- `scripts/package-smoke`
- `docs/goals/codex-app-session-bootstrap-templates/state.yaml`
- `docs/goals/codex-app-session-bootstrap-templates/notes/*`

Verification commands:

- `npm test -- --runInBand src/cli/typescript-runtime.test.ts`
- `npm run build:cli`
- `scripts/package-smoke`
- `./bin/conveyor install-skills --json`
- `node /Users/neonwatty/.codex/plugins/cache/goalbuddy/goalbuddy/0.3.8/skills/goalbuddy/scripts/check-goal-state.mjs docs/goals/codex-app-session-bootstrap-templates/state.yaml`
- `git diff --check`

Stop conditions:

- Need terminal package code to call `create_thread` or `send_message_to_thread`.
- Need to send messages to a non-disposable/private app thread.
- Cannot make tests fail on omission of heartbeat, inbox polling, Dispatch, wake recovery, delivery receipts, or evidence/one-next-task rules.
