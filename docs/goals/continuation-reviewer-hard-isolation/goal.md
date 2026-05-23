# Continuation Reviewer Hard Isolation

## Objective

Implement issue #130: give `continuation-reviewer` a real enforced isolation boundary before documenting sandbox guarantees.

## Original Request

"Next is #130: hard isolation for `continuation-reviewer` ... do this"

## Intake Summary

- Input shape: `specific`
- Audience: `workerctl` operators, manager/worker pair users, and future dispatch/continuation-review workflows
- Authority: `requested`
- Proof type: `test`
- Completion proof: issue #130 acceptance criteria are implemented or explicitly superseded with evidence; tests prove manager rollout/session artifacts are inaccessible except through allowed context; reviewer failures still route to `verdict=stop`; docs distinguish restricted context from hard isolation; full verification passes.
- Goal oracle: a final Judge/PM audit proves that `continuation-reviewer` uses an enforced sandbox or equivalent process/filesystem/environment isolation, not just metadata/context convention, and that every #130 acceptance criterion has direct evidence.
- Likely misfire: renaming the current restricted-context subprocess as "isolated" without adding an enforceable boundary.
- Blind spots considered: cross-platform sandbox support, subprocess environment leaks, cwd/filesystem access, temporary context file leakage, reviewer command compatibility, CI constraints, and not breaking existing failure-to-stop routing.
- Existing plan facts: dispatch gap closure deliberately deferred hard isolation to #130; current behavior already has restricted stdin context, `manager_rollout_access=false`, session separation metadata, permission checks, structured telemetry, and failure-to-stop routing.

## Goal Oracle

The oracle for this goal is:

`A final Judge/PM audit maps each #130 acceptance criterion to current source, tests, docs, and issue state, with full verification green and full_outcome_complete: true.`

The PM must reject completion if the implementation only provides naming/context separation and lacks an enforced sandbox or equivalent isolation primitive.

## Goal Kind

`specific`

## Current Tranche

Preferred execution path:

1. Scout the current continuation-reviewer execution path and identify realistic isolation mechanisms available in this repo and CI environment.
2. Have Judge choose the smallest safe isolation boundary and define an implementation package with exact files, tests, and stop conditions.
3. Implement the chosen isolation mechanism without broad refactors and without weakening existing failure-to-stop behavior.
4. Add tests proving manager rollout/session artifacts are inaccessible except through allowed context.
5. Update docs so the current guarantee is precise: restricted-context plus enforced isolation, with limitations stated.
6. Run full verification and close/update #130 only after evidence is present.

## Non-Negotiable Constraints

- Do not claim hard sandboxing unless there is an enforced process, filesystem, environment, or equivalent isolation boundary.
- Preserve existing continuation-review semantics: reviewer failures, timeouts, invalid JSON, and denied access must route to `verdict=stop` and operator review.
- Do not leak raw continuation payloads, prompts, transcripts, rollout content, stdout/stderr, or manager-private context through telemetry.
- Prefer a minimal, testable local boundary over a broad process supervisor refactor.
- Keep Dispatch and continuation review from deciding task success, merge readiness, strategy, or acceptance criteria truth.
- If the platform cannot enforce isolation safely, create a precise follow-up/blocking artifact instead of faking success.

## Stop Rule

Stop only when a final audit proves the full original outcome is complete.

Do not stop after discovery, design, or a passing narrow unit if #130's acceptance criteria are still unproven.

If a chosen sandbox mechanism is unavailable in CI or the local platform, record that exact blocker and continue with any safe local work, docs, or tests that still improves the evidence.

## Canonical Board

Machine truth lives at:

`docs/goals/continuation-reviewer-hard-isolation/state.yaml`

If this charter and `state.yaml` disagree, `state.yaml` wins for task status, active task, receipts, verification freshness, and completion truth.

## Run Command

```text
/goal Follow docs/goals/continuation-reviewer-hard-isolation/goal.md.
```

## PM Loop

On every `/goal` continuation:

1. Read this charter.
2. Read `state.yaml`.
3. Run the bundled GoalBuddy update checker when available and mention a newer version without blocking.
4. Work only on the active board task.
5. Use Scout for read-only mapping, Judge for design/risk gates, Worker for bounded code changes, and PM for issue hygiene.
6. Write a compact task receipt.
7. Update the board.
8. Continue to the next safe local task until the final audit proves completion.
