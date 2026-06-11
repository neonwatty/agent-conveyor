# T001 Scout Receipt

## Result

Done.

## Evidence

- Codex app tool discovery exposed `codex_app.send_message_to_thread`, `create_thread`, `read_thread`, `list_threads`, `set_thread_title`, `set_thread_pinned`, `set_thread_archived`, and `handoff_thread` as callable tools in this environment.
- No app-thread message was sent during Scout.
- Disposable local `app-wakeup-dispatch --json` sample produced top-level keys `actions`, `dispatcher`, `receipt`, `status`, and `summary`.
- Each action contains `blocker`, `prompt`, `reason`, `role`, `send_ready`, `status`, and `thread`.
- The sampled stale manager/worker case returned `ready_to_send=2`, `dispatcher.required=true`, `dispatcher.state=missing`, and `status.ok=false`.
- Current `manage-codex-workers` skill tells managers to use `app-wakeup-dispatch` for auditable prepared/skipped/blocked wake receipts, but it does not yet give a step-by-step adapter procedure or post-send receipt command.
- Current code has `app_wakeup_dispatch_planned` telemetry, but no generic operator telemetry command or app wake delivery receipt command.

## Boundary

The package cannot call `send_message_to_thread` directly because that is a Codex app tool, not a terminal package API. The safe slice is:

1. Package provides a receipt command that validates a delivery report against the prior `app_wakeup_dispatch_planned` telemetry event.
2. Installed skill tells Codex app managers to call `send_message_to_thread` only for actions where `send_ready=true`.
3. After each send/skip/block, the manager records `app_wakeup_delivery_recorded` through the package command.

## Recommended Worker Slice

Add `conveyor app-wakeup-record-delivery`:

- Requires `TASK`, `--role manager|worker`, `--dispatch-receipt EVENT_ID`, and `--delivery-status sent|skipped|blocked`.
- Requires `--thread-id` for `sent`.
- Validates `sent` only when the referenced dispatch receipt action is `ready_to_send` and `send_ready=true`.
- Validates `skipped` only for `skipped_healthy`.
- Validates `blocked` only for `blocked_missing_thread`.
- Records `app_wakeup_delivery_recorded` telemetry linked to the dispatch receipt.
- Keeps missing Dispatch from the dispatch receipt visible in output.

