# T003 Worker Receipt

## Result

Done.

Implemented dispatcher-enforced Ralph-loop max-iteration blocking for durable `continue_iteration` commands.

## What Changed

- Added Ralph-loop helpers over the existing durable `runs` table:
  - `create_ralph_loop_run`
  - `ralph_loop_run`
  - `enqueue_continue_iteration`
- Added first-class `continue_iteration` dispatch support:
  - dispatch type filtering accepts `continue_iteration`
  - route is manager -> worker
  - signal type is `continue_iteration`
- Added pre-delivery policy enforcement:
  - Dispatch resolves text, route, permission, and delivery mode
  - before `insert_routed_notification`, it checks `current_iteration >= max_iterations`
  - blocked commands finish as command state `failed` with result `state=blocked`
  - blocked result includes `reason=max_iterations_reached`, current/max/requested iteration, `delivered=false`, `target_worker_notified=false`, manager decision id, command id, and correlation id
  - blocked path creates no routed notification and starts no tmux side effect
- Added CLI command:
  - `enqueue-continue-iteration`
- Added replay/dashboard evidence:
  - replay command-attempt details now include structured `result` and `error`
  - dashboard dispatch chain entries expose `blocked_policy`
  - dashboard Dispatch panel renders `max_iterations_reached`, `iteration 1/1`, delivery status, and worker notification status
- Updated `qa-plan ralph-loop`, `docs/qa/ralph-loop.md`, and `docs/manual-qa-checklist.md` with the negative max-iteration browser drill.

## Proof

- `python3 -m unittest tests.test_workerctl.DispatchTests tests.test_workerctl.CliTests.test_enqueue_continue_iteration_cli_records_loop_policy_reference tests.test_workerctl.CliTests.test_qa_plan_ralph_loop_outputs_managed_delivery_loop tests.test_workerctl.CliTests.test_qa_plan_ralph_loop_includes_correlation_and_receipt_template -v` passed.
- `python3 -m unittest tests.test_workerctl -v` passed: 505 tests.
- `npm test` passed: 39 tests.
- `npm run build` passed.
- `git diff --check` passed.

## Key Acceptance Evidence

- No-tmux blocked worker path: `test_dispatch_blocks_continue_iteration_past_max_before_no_tmux_worker_inbox`
- Tmux blocked worker path: `test_dispatch_blocks_continue_iteration_past_max_before_tmux_send`
- Allowed no-tmux continuation path: `test_dispatch_allows_continue_iteration_within_max_to_no_tmux_worker_inbox`
- Replay/audit blocked evidence: `test_replay_exposes_blocked_continue_iteration_without_worker_notification`
- Dashboard blocked evidence: `dispatch chains expose blocked Ralph-loop continuation policy`
- CLI durable continuation command: `test_enqueue_continue_iteration_cli_records_loop_policy_reference`
- Generated QA plan includes browser drill: `test_qa_plan_ralph_loop_outputs_managed_delivery_loop`

## Scope Guard

Dispatch still does not decide task success, PR quality, CI meaning, merge readiness, or whether more work is strategically useful. This slice enforces only the explicit numeric loop policy in durable run metadata.
