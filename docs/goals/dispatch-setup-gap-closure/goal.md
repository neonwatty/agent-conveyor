# Dispatch Setup Gap Closure

## Objective

Fix all remaining gaps from the post-close dispatcher/setup audit so the app genuinely satisfies the closed Dispatch issue: setup makes Dispatch operational or unmistakably required, backend routing is recoverable and correctly correlated, dashboard status is unambiguous, and CI/manual QA protect the behavior.

## Original Request

"use $goalbuddy:goal-prep to fix all gaps"

## Intake Summary

- Input shape: `existing_plan`
- Audience: `workerctl` operators, managers, workers, dashboard users, and maintainers relying on Dispatch to wake managers mechanically.
- Authority: `requested`
- Proof type: `test`
- Completion proof: focused backend, dashboard, docs/setup, CI, and final audit checks pass; the final audit maps every named gap to implemented evidence or an explicit non-goal.
- Goal oracle: the current app no longer has the known dispatcher/setup gaps, and a maintainer can run the documented setup path with clear Dispatch status, recoverable completion routing, dashboard protection in CI, and manual QA coverage.
- Likely misfire: fixing only README wording while leaving backend consumption/recovery bugs or ambiguous dashboard health intact.

## Existing Plan Facts

The immediately preceding three-agent audit found these gaps:

1. High: delivered dispatch notifications can be consumed by failed manager cycles.
2. Medium: completion-only dispatch has no recovery path for a crash after pending notification insert and before send/finish.
3. Medium: setup does not actually start or strongly guide starting `workerctl dispatch --watch`.
4. Medium: dashboard does not clearly distinguish "dispatcher healthy" from "no dispatcher observed."
5. Medium: CI does not run dashboard TypeScript tests or build.
6. Low: README describes Dispatch command-row processing but omits `enqueue-notify-manager` and `enqueue-nudge-worker` from the command reference.
7. Low: manual QA heartbeat coverage is optional because the checklist runs `dispatch --once`, not bounded watch mode.
8. Low/test gap: install/setup tests do not assert that operators are pointed at Dispatch or dispatch QA guidance.

Known positive evidence from the audit:

- Core `DispatchTests` passed locally.
- Dashboard tests passed locally.
- Completion routing, source-event dedupe, command attempts, leases, permission checks, dashboard chains, suppressed-signal visibility, and consumed-cycle correlation mostly exist and should be preserved.

## Non-Negotiable Constraints

- Preserve Dispatch as mechanical routing/execution only: no task success judgment, acceptance criteria decisions, next-work selection, final task state changes, PR merging, or human-operator routing.
- Keep existing direct `session-nudge` and command queue behavior available.
- Keep tmux side-effect retry behavior conservative; if a send may have started, record risk and do not blindly retry.
- Keep schema changes migration-compatible and additive where possible.
- Do not touch unrelated dirty work.
- Worker tasks may edit only their explicit `allowed_files`.

## Current Tranche

This tranche should fix the named gaps end to end:

1. Revalidate the exact backend failure modes and pick safe semantics for failed-cycle consumption and pending notification recovery.
2. Implement the backend fixes with regression tests.
3. Make setup/operator surfaces require or strongly guide Dispatch watch usage, including docs, help/install guidance, and focused tests.
4. Make dashboard dispatcher health explicit and source heartbeat status durably enough to avoid false "healthy" states.
5. Add CI and manual QA coverage for dashboard dispatch surfaces and watch heartbeat.
6. Run a final skeptical audit against the original Dispatch issue and the named gap list.

## Goal Oracle

The goal is complete only when a final Judge audit proves:

- Each named gap above is fixed, intentionally out of scope, or converted into a precise follow-up with evidence.
- Backend tests cover failed-cycle notification consumption and stale/pending completion notification recovery.
- Dashboard tests cover no-heartbeat, stale-heartbeat, active-heartbeat, and selected-task dispatch status behavior.
- Setup/docs/help tests cover operator guidance for running Dispatch.
- CI or `rc-check` runs dashboard test/build coverage.
- Manual QA includes bounded watch-mode heartbeat verification.
- `python3 -m unittest tests.test_workerctl.DispatchTests tests.test_workerctl.DatabaseTests tests.test_workerctl.SuperviseCycleTests tests.test_workerctl.CliTests -v` passes.
- `npm test -- --runInBand` and `npm run build` pass in `dashboard`.
- `python3 -m py_compile workerctl/*.py` and `git diff --check` pass.
- Dispatch still does not decide task success, acceptance criteria, next work, or human/operator routing.

## Canonical Board

Machine truth lives at:

`docs/goals/dispatch-setup-gap-closure/state.yaml`

If this charter and `state.yaml` disagree, `state.yaml` wins.

## Run Command

```text
/goal Follow docs/goals/dispatch-setup-gap-closure/goal.md.
```
