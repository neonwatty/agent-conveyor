# T002 Judge Slice

## Decision

Approved.

Implement the smallest coherent evidence-gate slice: a `ci_green` required evidence gate for `continue_iteration`, using Ralph-loop run metadata for policy and satisfied acceptance criteria evidence as the receipt source.

## Scope

Worker may implement:

- Ralph-loop run metadata field `required_before_continue`.
- Ralph-loop policy evaluation that checks `required_before_continue` for `continue_iteration`.
- Initial evidence source: satisfied acceptance criteria whose `evidence` contains matching `ralph_loop_run_id`, previous `iteration`, and `evidence_type`.
- Missing-evidence block result with `reason=missing_ci_green_evidence`, `missing_evidence=["ci_green"]`, and existing no-delivery fields.
- Dashboard/audit/replay exposure for `missing_evidence`.
- Docs and browser QA for blocked first attempt plus allowed retry after recording evidence.

## Explicit Non-Goals

- Do not inspect GitHub, CI providers, PR state, merge state, or cleanup state directly in Dispatch.
- Do not decide whether the code is good, tests are adequate, a PR should merge, or the manager's strategy is sound.
- Do not build the full matrix of PR URL, merge, cleanup, budget, or handoff gates in this slice unless needed as generic plumbing for `ci_green`.
- Do not change non-loop `nudge_worker` or `notify_manager` semantics.

## Allowed Files

- `workerctl/db.py`
- `workerctl/cli.py`
- `workerctl/commands.py`
- `workerctl/replay.py`
- `dashboard/server/index.ts`
- `dashboard/client/main.tsx`
- `dashboard/client/styles.css`
- `dashboard/server/workerctl.test.ts`
- `tests/test_workerctl.py`
- `docs/qa/ralph-loop.md`
- `docs/manual-qa-checklist.md`
- `docs/goals/ralph-loop-evidence-gates/notes/**`
- `docs/goals/ralph-loop-evidence-gates/state.yaml`

## Red Tests

Write and watch fail first:

- Python dispatch test: missing `ci_green` blocks a no-tmux `continue_iteration` before worker inbox delivery.
- Python dispatch test: missing `ci_green` blocks a tmux `continue_iteration` before `send_text_to_session`.
- Python dispatch test: satisfied acceptance criterion evidence allows a fresh `continue_iteration` retry to the no-tmux worker inbox.
- Python replay/audit test: blocked attempt exposes `missing_evidence` and `missing_ci_green_evidence`.
- Dashboard server test: blocked policy summary includes `missing_evidence`.

## Required Browser QA

Run a disposable local dashboard fixture:

- `max_iterations=3`
- `current_iteration=1`
- `required_before_continue=["ci_green"]`
- first manager request: `requested_iteration=2`, no CI-green evidence
- first dispatch: blocked with `missing_ci_green_evidence`
- worker inbox: empty
- dashboard: shows `continue_iteration`, `missing_ci_green_evidence`, `missing ci_green`, `iteration 1/3`, `requested 2`, `0 notifications`, `Inbox 0`, `Pull inbox 0`, and `target_worker_notified=false`
- record satisfied criterion evidence for `ci_green`, `ralph_loop_run_id`, `iteration=1`
- second manager request and fresh command: delivered to worker inbox
- audit/replay: both attempts visible with distinct correlation ids

## Verification

- Focused Python tests covering the new gate.
- `python3 -m unittest tests.test_workerctl -v`
- `npm test`
- `npm run build`
- Browser or Playwright QA walkthrough.
- `git diff --check`

## Stop Conditions

Stop if implementation requires Dispatch to query external CI/PR systems or decide CI meaning itself. Stop if the gate cannot be enforced before both routed notification creation and tmux send. Stop if the allowed retry cannot be proven with a fresh command after evidence exists.
