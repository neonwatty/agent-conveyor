# T005 Worker Receipt - Local Ship-It QA Proof

Completed: 2026-06-15T16:04:19Z

## Summary

Ran the local deterministic ship-it QA proof with no live GitHub merge. The
fresh receipt proves the manager-worker ship-it loop fails closed before
permissions and evidence, records bounded conflict exhaustion as blocked, and
delivers only after all lifecycle receipts exist.

## Commands

- `bin/conveyor doctor`
  - `ok=true`.
- `bin/conveyor db-doctor --path .codex-workers/workerctl.db`
  - `ok=true`, schema/user version 24, required tables/indexes/triggers present,
    foreign key check clean.
- `bin/conveyor qa-run ship-it-loop --receipt-output /tmp/ship-it-loop-t005-receipt.json --json`
  - `result=passed`, `checks=10`.
- `git diff --check`
  - Passed.
- `node /Users/neonwatty/.codex/plugins/cache/goalbuddy/goalbuddy/0.3.8/skills/goalbuddy/scripts/check-goal-state.mjs docs/goals/autonomous-ship-it-loops/state.yaml`
  - Passed with `ok=true` before receipt update.

## Receipt Evidence

Fresh receipt: `/tmp/ship-it-loop-t005-receipt.json`

Passed checks:

- `ship_it_push_branch_requires_repo_push_branch`: failed closed with worker
  inbox count 0 before permission.
- `ship_it_push_branch_delivers_after_permission`: delivered after permission.
- `ship_it_open_pr_requires_repo_open_pr`: failed closed with worker inbox
  count 0 before permission.
- `ship_it_open_pr_delivers_after_permission`: delivered after permission.
- `ship_it_merge_requires_repo_merge_green_pr`: failed closed with worker inbox
  count 0 before permission.
- `ship_it_merge_delivers_after_permission`: delivered after permission.
- `ship_it_lifecycle_blocks_before_any_evidence`: blocked with all required
  lifecycle evidence missing.
- `ship_it_lifecycle_blocks_before_mergeability_and_manager_decision`: blocked
  after partial branch/PR/CI evidence until mergeability, manager decision,
  merge, post-merge, and adversarial evidence existed.
- `ship_it_conflict_retry_blocks_after_limit`: recorded unresolved conflict
  with `retry_count=2`, `max_retries=2`, `status=blocked`, and
  `stop_reason=conflict_retry_limit_reached`.
- `ship_it_lifecycle_retry_delivers_after_all_evidence`: delivered after all
  lifecycle evidence existed.

## Disproof Attempt

Strongest realistic failure mode: the new autonomous ship-it loop could still
let a manager or worker merge because CI is green while missing permissions,
mergeability, manager decision, post-merge verification, or conflict-blocker
proof.

Evidence against it: the fresh QA receipt shows side effects fail closed before
permission, continuation blocks before evidence, partial PR/CI evidence is not
enough, conflicts stop after retry exhaustion, and only a complete evidence set
allows fresh delivery.

## Residual Risk

This is a local simulated QA proof, not a live PR/CI/merge dogfood. Live
GitHub side effects remain intentionally blocked unless the operator grants
them for a specific task.
