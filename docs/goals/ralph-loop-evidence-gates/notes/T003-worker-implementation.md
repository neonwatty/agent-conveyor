# T003 Worker Implementation Receipt

## Result

Done.

Implemented dispatcher-enforced `ci_green` evidence gating for Ralph-loop `continue_iteration` commands. Dispatch now blocks missing required evidence before routed notification creation or tmux side effects, and allows a fresh retry after matching satisfied criterion evidence exists.

## What Changed

- `workerctl/db.py`
  - Ralph-loop policy records accept and persist `required_before_continue`.
  - Malformed direct `required_before_continue` inputs are rejected instead of being coerced into unsafe policy.
  - `ralph_loop_run` exposes normalized `required_before_continue` metadata.
- `workerctl/commands.py`
  - `runs --create --purpose ralph_loop` preserves `required_before_continue` from metadata.
  - Malformed `required_before_continue` metadata is rejected fail-closed instead of disabling the gate.
  - `_dispatch_ralph_loop_policy` checks required evidence for `continue_iteration`.
  - Satisfied acceptance criteria evidence is the first structured receipt source.
  - Missing evidence blocks with `reason=missing_ci_green_evidence`, `missing_evidence=["ci_green"]`, and no delivery.
  - Allowed delivery payloads include `required_before_continue`.
- `dashboard/server/index.ts`
  - Blocked policy summaries expose `missing_evidence` and `required_before_continue`.
- `dashboard/client/main.tsx`
  - Dispatch panel renders `missing ci_green` in blocked-policy rows.
- `dashboard/server/workerctl.test.ts`
  - Added dashboard coverage for missing Ralph-loop continuation evidence.
- `tests/test_workerctl.py`
  - Added no-tmux block, tmux no-send, allowed retry, replay/audit, CLI metadata, malformed metadata rejection, and QA-plan assertions.
- `docs/qa/ralph-loop.md`
  - Added the missing CI-green evidence drill and retry path.
- `docs/manual-qa-checklist.md`
  - Added manual QA checklist entry for the missing-evidence drill.

## Verification

- `python3 -m unittest tests.test_workerctl.DispatchTests.test_dispatch_blocks_continue_iteration_past_max_before_no_tmux_worker_inbox tests.test_workerctl.DispatchTests.test_dispatch_blocks_continue_iteration_past_max_before_tmux_send tests.test_workerctl.DispatchTests.test_dispatch_blocks_requested_continue_iteration_over_max_before_tmux_send tests.test_workerctl.DispatchTests.test_dispatch_blocks_continue_iteration_missing_ci_green_before_no_tmux_worker_inbox tests.test_workerctl.DispatchTests.test_dispatch_blocks_continue_iteration_missing_ci_green_before_tmux_send tests.test_workerctl.DispatchTests.test_dispatch_allows_continue_iteration_after_ci_green_evidence_to_no_tmux_worker_inbox tests.test_workerctl.DispatchTests.test_replay_exposes_blocked_continue_iteration_without_worker_notification tests.test_workerctl.DispatchTests.test_replay_exposes_missing_evidence_continue_iteration_block tests.test_workerctl.DispatchTests.test_dispatch_allows_continue_iteration_within_max_to_no_tmux_worker_inbox tests.test_workerctl.CliTests.test_runs_cli_creates_ralph_loop_policy_when_active_telemetry_run_exists tests.test_workerctl.CliTests.test_enqueue_continue_iteration_cli_records_loop_policy_reference tests.test_workerctl.CliTests.test_qa_plan_ralph_loop_outputs_managed_delivery_loop -v`
  - Passed 12 focused tests.
- `npm test -- --runInBand dashboard/server/workerctl.test.ts`
  - Passed 40 dashboard/server tests.
- `npm run build`
  - Passed TypeScript and Vite build.
- `node .../check-goal-state.mjs docs/goals/ralph-loop-evidence-gates/state.yaml`
  - Passed while T003 was active.
- `git diff --check`
  - Passed.
- `python3 -m unittest tests.test_workerctl -v`
  - Passed 515 tests after the review fix.
- `npm test`
  - Passed 40 tests.

## Evidence

- Missing `ci_green` no-tmux path creates no routed notification and leaves worker inbox empty.
- Missing `ci_green` tmux path does not call `send_text_to_session`.
- Satisfied criterion evidence with `evidence_type=ci_green`, `ralph_loop_run_id`, and `iteration=1` allows a fresh requested iteration 2 command to reach the worker inbox.
- Replay/audit expose blocked attempt `result.state=blocked`, `reason=missing_ci_green_evidence`, and `missing_evidence=["ci_green"]`.
- Existing max-iteration guardrail tests remain green.
- Malformed `required_before_continue` metadata is rejected before a run can be created without the intended evidence gate.

## Notes

Dispatch only verifies that explicit recorded evidence exists. It does not query CI providers, inspect PR state, or decide whether CI is meaningfully green.
