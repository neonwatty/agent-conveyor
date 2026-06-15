# T003 Worker Receipt - Ship-It Lifecycle Contract

Completed: 2026-06-15T15:59:44Z

## Summary

Implemented the first deterministic `ship_it_loop` lifecycle surface for
Agent Conveyor. The slice adds explicit repo permissions for CI monitoring and
conflict resolution, a strict manager recipe for autonomous ship-it loops, a
template requiring branch/PR/CI/mergeability/manager decision/merge/post-merge
and adversarial evidence, and a deterministic `qa-run ship-it-loop` harness.

## Changed Files

- `src/runtime/manager-permissions.ts`
- `src/cli/typescript-runtime.ts`
- `src/cli/typescript-runtime.test.ts`
- `README.md`
- `docs/manager-recipes.md`
- `docs/qa/README.md`
- `docs/qa/ship-it-loop.md`
- `docs/goals/autonomous-ship-it-loops/state.yaml`
- `docs/goals/autonomous-ship-it-loops/notes/T003-worker-receipt.md`

## Evidence

- `bin/conveyor loop-templates --show ship_it_loop --json`
  - Exited 0.
  - Required evidence: `branch_ready`, `branch_pushed`, `pr_url`, `ci_green`,
    `mergeability_clean`, `manager_merge_decision`, `merge`,
    `post_merge_verification`, `adversarial_check`.
- `bin/conveyor manager-recipes --show ship-it-loop --json`
  - Exited 0.
  - Permissions include `repo.push_branch`, `repo.open_pr`, `repo.monitor_ci`,
    `repo.resolve_conflicts`, and `repo.merge_green_pr`.
- `bin/conveyor qa-plan ship-it-loop --json`
  - Exited 0 and named the authority boundaries, lifecycle evidence, conflict
    blocker, and manager-only merge decision.
- `bin/conveyor qa-run ship-it-loop --receipt-output /tmp/ship-it-loop-receipt.json --json`
  - Exited 0 with `result=passed`, `checks=10`.
  - Saved receipt path: `/tmp/ship-it-loop-receipt.json`.
- `npm test -- --runInBand`
  - Passed 178 tests.
- `npm run build:cli`
  - TypeScript compile passed.
- `node /Users/neonwatty/.codex/plugins/cache/goalbuddy/goalbuddy/0.3.8/skills/goalbuddy/scripts/check-goal-state.mjs docs/goals/autonomous-ship-it-loops/state.yaml`
  - Passed before receipt update with `ok=true`.
- `git diff --check`
  - Passed.

## Disproof Attempt

Strongest realistic failure mode: a ship-it loop could merge after CI green
while permission, conflict, manager decision, mergeability, or post-merge proof
is missing.

Evidence against it: `/tmp/ship-it-loop-receipt.json` reports these passed
checks:

- `ship_it_push_branch_requires_repo_push_branch`
- `ship_it_open_pr_requires_repo_open_pr`
- `ship_it_merge_requires_repo_merge_green_pr`
- `ship_it_lifecycle_blocks_before_any_evidence`
- `ship_it_lifecycle_blocks_before_mergeability_and_manager_decision`
- `ship_it_conflict_retry_blocks_after_limit`
- `ship_it_lifecycle_retry_delivers_after_all_evidence`

The deterministic receipt therefore proves the package fails closed before
permission grants, blocks lifecycle continuation before mergeability and
manager decision proof, records conflict retry exhaustion as blocked, and only
delivers a fresh retry after all lifecycle evidence exists.

## Residual Risk

This is local deterministic QA, not a live GitHub merge dogfood. Live PR
creation, CI monitoring, conflict repair, and merge should stay behind explicit
operator approval and be covered by T005.
