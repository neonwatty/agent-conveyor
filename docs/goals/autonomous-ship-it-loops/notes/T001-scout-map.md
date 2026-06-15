# T001 Scout Map

## Result

Done.

Mapped the existing Conveyor PR/Ralph-loop/autopilot/session-visible surfaces and the smallest coherent surface for an autonomous ship-it loop.

## Current Capability Map

- `src/runtime/manager-permissions.ts` defines repo permissions for `repo.open_pr`, `repo.push_branch`, and `repo.merge_green_pr`, with legacy aliases for `create_pr` and `merge_green_pr`.
- `README.md` documents `manager-config --permit`, `--allow-pr`, `--allow-merge-green`, `manager-permission`, and legacy permission normalization.
- `src/runtime/dispatch.ts` checks `commands.required_permission` before side effects. If permission is missing, Dispatch emits `dispatch_command_permission_checked` telemetry and fails closed before delivery.
- `src/cli/typescript-runtime.ts` enqueues commands with optional `required_permission`, so permission-gated dispatch is generic rather than hard-coded to one command.
- `src/cli/typescript-runtime.ts` already defines a `pr_ci_merge_loop` template with `required_before_continue=["pr_url","ci_green","merge","adversarial_check"]`, `cleanup_policy="clear"`, `recommended_tools=["gh","verification.run_tests"]`, and `max_iterations=2`.
- `src/cli/typescript-runtime.ts` defines a `pr-ci-merge-ralph-loop` manager recipe with strict mode, `repo.open_pr`, `repo.merge_green_pr`, worker compact/clear permissions, `draft-pr` and `record-handoff` epilogues, and final-report requirements for PR URL, CI, merge, handoff, finish-task, and cleanup receipts.
- `bin/conveyor loop-templates --show pr_ci_merge_loop --json` confirms the template requires PR URL, CI-green, merge, and adversarial evidence before continuation.
- `bin/conveyor manager-recipes --show pr-ci-merge-ralph-loop --json` confirms the recipe exposes the existing strict PR/CI/merge authority boundary and suggested `manager-config` command.
- `src/runtime/dispatch.ts` enforces Ralph-loop continuation gates before routed notification creation or tmux send. Missing evidence creates a blocked command attempt with no worker delivery.
- `src/runtime/loop-evidence.ts` records run-qualified evidence as satisfied acceptance-criteria rows. Structured `adversarial_check` evidence must include `failure_mode`, `check`, and `result`.
- `src/cli/typescript-runtime.test.ts` covers template creation, `pr_ci_merge_loop` required evidence, missing PR/CI/merge/adversarial evidence blocking, allowed retry after evidence, app-autopilot visible prompts, app-heartbeat recommendations, and manager permissions.
- `README.md`, `skills/manage-codex-workers/SKILL.md`, and `docs/goals/visible-conveyor-sessions/state.yaml` establish the visible-session protocol: consumed inbox items must produce live `CONVEYOR POLL`, `CONVEYOR RECEIVED`, `WORK`, `CONVEYOR SEND`, and `DISPATCH` sections in the manager/worker sessions.
- `docs/qa/ralph-loop.md` describes the intended full PR/CI/merge/handoff/clear loop, including `gh pr checks --required` guidance and the warning that `gh pr merge --auto` is not sufficient evidence on an unprotected repo.
- `docs/qa/goalbuddy-conveyor.md` describes higher-level GoalBuddy child-board proof: PR URL, CI result, merge SHA, parent handoff, and `satisfied_on_main` alternatives.

## Existing Proof

- `bin/conveyor qa-plan ralph-loop --json` reports expected observations that PR creation is blocked until `repo.open_pr`, merge is blocked until `repo.merge_green_pr` and CI is green, worker context clear is blocked until permission and handoff exist, and Dispatch blocks max-iteration/missing-evidence drills before worker delivery.
- `docs/goals/ralph-loop-evidence-gates/notes/T999-final-audit.md` records the earlier evidence-gate tranche: Dispatch checks only explicit recorded evidence, does not query CI or judge PR quality, and blocks missing `ci_green` before delivery.
- `docs/goals/visible-conveyor-sessions/state.yaml` records a completed dogfood proving app/tmux session visibility is the live review surface, with SQLite/replay/status as audit proof.
- `docs/goals/goalbuddy-conveyor-live-dogfood/state.yaml` records a parent/child GoalBuddy conveyor dogfood where PR URL, CI result, merge SHA, and satisfied-on-main proof were tracked manually in board receipts.

## Gaps

1. No first-class ship-it lifecycle state exists. Current receipts are generic loop evidence or board notes, not a normalized lifecycle record with branch, PR URL, CI/check state, conflict state, mergeability, manager decision, merge SHA, and post-merge proof.
2. `pr_ci_merge_loop` gates continuation after PR/CI/merge evidence exists, but it does not guide or validate the lifecycle steps that produce those receipts.
3. The manager recipe grants `repo.open_pr` and `repo.merge_green_pr`, but not `repo.push_branch`. Push authority exists in the taxonomy and parser, yet the PR/CI/merge recipe does not currently distinguish commit/push/open PR/merge as separate lifecycle phases.
4. Dispatch can enforce a `required_permission` on queued commands, but there are no dedicated ship-it commands or helpers that automatically attach `repo.open_pr`, `repo.push_branch`, or `repo.merge_green_pr` to PR lifecycle actions.
5. Conflict handling is documented only as operator behavior, not as a bounded lifecycle phase with retry count, evidence, and stop conditions.
6. CI-green evidence is a recorded claim. The current system intentionally does not query GitHub; that is good for Dispatch, but the manager/worker prompts and QA need a clear verifier contract for `gh pr checks --required`, mergeability, and unprotected-repo edge cases.
7. App-visible prompts cover live inbox handling, but the PR/CI/merge recipe does not yet spell out visible lifecycle sections for PR creation, CI monitoring, conflict resolution, and merge closeout.
8. Local QA proves missing evidence and allowed retry, but there is no `ship-it` dry-run QA scenario that simulates the whole lifecycle without live GitHub credentials.

## Recommended Ship-It Surface

Add an explicit ship-it lifecycle contract layered above existing loop evidence:

- Policy flags: `allow_commit`, `allow_push_branch`, `allow_open_pr`, `allow_monitor_ci`, `allow_resolve_conflicts`, `allow_merge_green`.
- Role boundary: worker may implement/test/commit/push only when policy grants the phase; manager alone may verify and authorize PR closeout/merge.
- Lifecycle states: `drafting`, `branch_ready`, `pr_open`, `ci_pending`, `ci_failed`, `conflict_blocked`, `conflict_fixing`, `ci_green`, `merge_ready`, `merged`, `blocked`.
- Required receipts: branch name, commit SHA, PR URL, CI/check evidence, conflict evidence when present, manager merge decision, merge SHA, post-merge verification or explicit blocker.
- Safety checks: no live GitHub required for unit tests; simulated QA must prove manager-only merge gating and fail-closed missing permission/evidence.

## Recommended First Worker Slice

Judge should consider approving one coherent implementation slice:

- Add a `ship_it_loop` or extend `pr_ci_merge_loop` metadata with explicit lifecycle phase requirements and artifact requirements for branch, PR, CI checks, conflict resolution, mergeability, manager decision, merge SHA, and post-merge proof.
- Add/extend manager recipe output so the manager prompt explicitly separates commit, push, open PR, monitor CI, resolve conflicts, and merge permissions.
- Add a deterministic `qa-run` scenario for ship-it lifecycle gates that uses simulated receipts and proves:
  - missing `repo.open_pr` blocks PR-opening commands;
  - missing `repo.push_branch` blocks push/PR-readiness phase when required;
  - missing `repo.merge_green_pr`, missing `ci_green`, missing mergeability, or missing manager decision blocks merge closeout;
  - conflict resolution is bounded by retry limit and records a blocker when unresolved;
  - app-visible prompt text includes the lifecycle authority boundary.
- Update docs/skill guidance only after the CLI/runtime behavior exists.

## Risk Notes

- Do not make Dispatch query GitHub, decide CI truth, or merge. Keep Dispatch mechanical: it should enforce explicit permissions and recorded evidence only.
- Do not treat `gh pr merge --auto` or a PR URL as enough proof. The manager must verify required checks or explicitly record why the repo has no required checks.
- Do not let "prove finish-task works" become an acceptance criterion. Closeout proof belongs in the manager final report or ship-it receipt.
- A dry-run QA path is acceptable for the first tranche because live GitHub credentials and merge authority should remain operator-approved.
