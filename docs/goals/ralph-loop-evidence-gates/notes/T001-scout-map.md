# T001 Scout Map

## Result

Done.

Mapped the existing Ralph-loop max-iteration guardrail, structured receipt storage, replay/audit, dashboard, and browser QA surfaces needed for evidence-gated continuation.

## Current Surfaces

- `workerctl/commands.py:4664` already centralizes Ralph-loop policy evaluation for `continue_iteration` commands in `_dispatch_ralph_loop_policy`.
- `workerctl/commands.py:4711` resolves the manager-to-worker route, checks permission, computes delivery mode, and evaluates loop policy before `workerctl/commands.py:4790` inserts a routed notification.
- `workerctl/commands.py:4715` currently blocks only `max_iterations_reached`; the blocked result already includes `state=blocked`, `delivered=false`, `target_worker_notified=false`, iteration counts, manager decision id, command id, run id, and correlation id.
- `workerctl/db.py:1644` stores Ralph-loop policy records as finished `runs` rows with metadata containing `kind=ralph_loop`, `max_iterations`, `current_iteration`, `cleanup_policy`, `stop_conditions`, and `seed_prompt_sha256`.
- `workerctl/db.py:1698` normalizes Ralph-loop run metadata for policy checks, but it does not currently expose continuation evidence requirements.
- `workerctl/db.py:1747` creates durable `continue_iteration` commands with `payload.ralph_loop.run_id`, `requested_iteration`, optional manager decision id, and correlation id.
- `workerctl/commands.py:6112` records manager decisions with structured payloads, and `workerctl/db.py:3500` persists those decisions plus telemetry.
- `workerctl/db.py:248` and `workerctl/db.py:3706` provide structured acceptance criteria with `evidence_json`; `workerctl/commands.py:3510` exposes this through `workerctl criteria --add/--satisfy --evidence-json`.
- `docs/qa/ralph-loop.md:235` already recommends recording PR URLs as accepted criterion evidence, and `docs/qa/ralph-loop.md:293` says PR/CI/merge/handoff/clear evidence must be represented as accepted criteria, decisions, handoffs, commands, or evidence-template receipts before finish.
- `workerctl/db.py:5498` task audit includes commands, command attempts, routed notifications, manager decisions, and acceptance criteria; `workerctl/replay.py:179` includes command attempt `result` and `error`.
- `dashboard/server/index.ts:335` extracts blocked policy summaries from command attempt results, and `dashboard/client/main.tsx:287` renders the blocked reason, iteration count, requested iteration, delivery flag, and worker notification flag.

## Gaps

- Ralph-loop run metadata has no structured `required_before_continue` or equivalent required evidence policy.
- `ralph_loop_run` does not expose evidence requirements from metadata.
- `_dispatch_ralph_loop_policy` cannot currently inspect acceptance-criteria evidence or report missing evidence.
- Blocked policy summaries do not expose `missing_evidence`, so browser QA cannot assert the missing gate list yet.
- Existing docs only show the max-iteration refusal browser drill, not missing-evidence block plus allowed retry.

## Candidate Evidence Model

Use the existing acceptance-criteria ledger as the first evidence source, because it already supports structured `evidence_json`, audit, replay, CLI mutation, and dashboard criteria summaries without adding a new table.

Recommended first slice:

- Store required evidence policy on the Ralph-loop run metadata as `required_before_continue`, e.g. `["ci_green"]`.
- Treat a satisfied acceptance criterion as matching evidence when its `evidence_json` includes:
  - `ralph_loop_run_id`
  - `iteration`
  - `evidence_type`, initially `ci_green`
  - optional `correlation_id`, `provider`, `status`, `url`
- During `continue_iteration`, check the requested iteration's prerequisite evidence as the previous completed iteration: for `requested_iteration=2`, require evidence with `iteration=1`.
- Return a structured block with `reason=missing_ci_green_evidence`, `missing_evidence=["ci_green"]`, and the same no-delivery fields used by the max-iteration block.

This keeps Dispatch mechanical: it verifies a recorded receipt exists; it does not decide whether CI is truly green.

## Dispatch Interception Point

The safe interception point is still inside `_execute_dispatch_command` after route/permission/delivery mode and before `insert_routed_notification`.

Evidence-gate blocking should live next to the max-iteration branch, or in a small helper that handles any `loop_policy.reason`, so both no-tmux worker inbox delivery and tmux push delivery are blocked before side effects.

## Browser QA Path

Use a disposable bound task and no-tmux worker first:

1. Create a Ralph-loop run with `max_iterations=3`, `current_iteration=1`, and `required_before_continue=["ci_green"]`.
2. Record a manager decision requesting iteration 2.
3. Enqueue `continue_iteration` for requested iteration 2.
4. Dispatch once with `--type continue_iteration`.
5. Assert command result `state=blocked`, `reason=missing_ci_green_evidence`, `missing_evidence=["ci_green"]`, `delivered=false`, `target_worker_notified=false`, `notification_id=null`, `side_effect_started=false`, and `side_effect_completed=false`.
6. Assert dashboard Dispatch panel contains `continue_iteration`, `missing_ci_green_evidence`, `missing ci_green`, `iteration 1/3`, `requested 2`, `0 notifications`, `Inbox 0`, `Pull inbox 0`, and `target_worker_notified=false`.
7. Satisfy an acceptance criterion with evidence JSON containing `evidence_type=ci_green`, `ralph_loop_run_id`, and `iteration=1`.
8. Record a fresh manager decision and enqueue a fresh `continue_iteration` for requested iteration 2.
9. Dispatch again and assert delivery occurs through routed notification / worker inbox.
10. Assert replay/audit show both attempts with their correlation ids.

Add a focused tmux test that proves `send_text_to_session` is not called when evidence is missing.

## Recommended Red Tests

- `test_dispatch_blocks_continue_iteration_missing_ci_green_before_no_tmux_worker_inbox`
- `test_dispatch_blocks_continue_iteration_missing_ci_green_before_tmux_send`
- `test_dispatch_allows_continue_iteration_after_ci_green_evidence_to_no_tmux_worker_inbox`
- `test_replay_exposes_missing_evidence_blocked_continue_iteration`
- Dashboard server test for `blocked_policy.missing_evidence`.
- CLI test for `runs --create --purpose ralph_loop --metadata-json` preserving `required_before_continue` in run metadata.

## Risk Notes

- Avoid adding evidence truth checks against external CI systems in Dispatch. The gate should only look for explicit recorded evidence.
- Avoid mutating existing max-iteration behavior; missing evidence gates should run only after max-iteration checks pass.
- If multiple required evidence names are introduced later, return all missing names but keep the first reason stable and machine-readable.
