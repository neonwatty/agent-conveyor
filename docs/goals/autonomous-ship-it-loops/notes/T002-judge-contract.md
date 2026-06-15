# T002 Judge Contract

## Decision

Approved.

The first implementation slice should add a first-class, deterministic ship-it lifecycle contract around the existing PR/CI/merge Ralph-loop rails. The slice should not perform live GitHub operations. It should make the authority boundary explicit, testable, and visible before later docs/dogfood work.

## Ship-It Lifecycle Contract

The lifecycle should model these phases:

1. `branch_ready`: worker reports branch and commit evidence.
2. `pushed`: branch push is allowed and recorded.
3. `pr_open`: PR URL is allowed and recorded.
4. `ci_pending`: PR checks are being monitored.
5. `ci_failed`: checks failed and manager may route a fix.
6. `conflict_blocked`: merge conflict or dirty mergeability state is detected.
7. `conflict_fixing`: worker is allowed to resolve conflicts within a bounded retry.
8. `ci_green`: required checks or explicit no-required-checks proof is recorded.
9. `merge_ready`: manager has verified evidence and recorded a merge decision.
10. `merged`: merge SHA and post-merge proof are recorded.
11. `blocked`: a missing permission, missing evidence, unresolved conflict, or unsafe live-GitHub requirement blocks progress.

The first slice may represent these phases as template metadata, QA receipt fields, helper text, and structured evidence requirements rather than adding a new database table. A new table is allowed only if the Worker proves the existing loop evidence model cannot express the contract cleanly.

## Authority Boundary

- Worker may implement/test/commit only under the assigned Worker task.
- Worker may push only when `repo.push_branch` is granted.
- Worker may open or update a PR only when `repo.open_pr` is granted.
- Worker/manager may monitor CI as evidence gathering, but CI truth must be recorded as explicit evidence, not inferred from prose.
- Worker may resolve conflicts only when the manager records a bounded conflict-resolution instruction with retry limit and allowed files.
- Manager alone may decide `merge_ready`.
- Merge requires `repo.merge_green_pr`, `ci_green`, mergeability or conflict-resolved evidence, manager merge decision, and adversarial proof.
- Dispatch remains mechanical: it enforces permissions and recorded evidence; it must not query GitHub, judge code quality, or merge.

## Approved Worker Slice

Implement a package-level ship-it loop contract with local deterministic proof:

- Add a `ship_it_loop` template or extend `pr_ci_merge_loop` with explicit lifecycle metadata and artifact requirements for branch, push, PR URL, CI checks, conflict status/resolution, mergeability, manager merge decision, merge SHA, post-merge proof, and adversarial proof.
- Add or update a manager recipe so generated manager config distinguishes `repo.push_branch`, `repo.open_pr`, `repo.merge_green_pr`, conflict resolution, CI monitoring, and final merge authority.
- Add a deterministic `qa-run` scenario for the ship-it lifecycle that simulates receipts and proves fail-closed behavior for missing PR/push/merge permissions, missing CI/mergeability/manager decision evidence, unresolved conflict retries, and allowed closeout after all evidence exists.
- Extend focused CLI tests for the new template/recipe/QA behavior.
- Keep app-visible session language in generated prompts or template text where the lifecycle requires operator review, but leave long-form docs/skill polishing for T004 unless a tiny README/help update is necessary to make tests meaningful.

## Worker Allowed Files

- `src/cli/typescript-runtime.ts`
- `src/cli/typescript-runtime.test.ts`
- `src/runtime/manager-permissions.ts`
- `src/runtime/dispatch.ts`
- `src/runtime/loop-evidence.ts`
- `README.md`
- `docs/qa/**`
- `docs/manager-recipes.md`
- `docs/goals/autonomous-ship-it-loops/**`

## Required Verification

- `npm test -- --runInBand`
- `npm run build:cli`
- `bin/conveyor loop-templates --show ship_it_loop --json` or equivalent if the Worker intentionally extends `pr_ci_merge_loop` instead of adding a new template
- `bin/conveyor manager-recipes --show <ship-it-recipe> --json` or equivalent updated existing recipe proof
- `bin/conveyor qa-run <ship-it-scenario> --receipt-output /tmp/ship-it-loop-receipt.json --json`
- `node /Users/neonwatty/.codex/plugins/cache/goalbuddy/goalbuddy/0.3.8/skills/goalbuddy/scripts/check-goal-state.mjs docs/goals/autonomous-ship-it-loops/state.yaml`
- `git diff --check`

## Stop Conditions

- Need live GitHub credentials or real merge access for local tests.
- Need package code to call Codex app-only thread tools.
- The design would let CI green alone imply merge readiness.
- The design would let the worker merge without a manager decision.
- The implementation would make PR creation, conflict resolution, or merge implicit defaults.
- The Worker needs files outside the allowed list.
- Verification fails twice with the same unresolved root cause.

## Deferred Follow-Ups

- T004 should polish operator docs and installed skill guidance after behavior is implemented.
- T005 should dogfood or run local QA using the new ship-it lifecycle receipt.
- A real PR/merge dogfood can follow only after the operator explicitly grants live repo authority.
