# Continuation Reviewer Gap Hardening

## Original Request

Make a detailed GoalBuddy plan to cover the independent audit gaps found after PR #132 closed issue #130.

## Interpreted Outcome

The repo should have the remaining continuation-reviewer hard-isolation gaps either implemented and verified, or explicitly scoped and tracked as non-required follow-up. The important behavioral edge is that reviewer automation failures must route to stop/operator review even under `auto-proceed`. The important QA gaps are fail-closed sandbox setup coverage, invalid JSON and timeout coverage, cwd/env isolation proof, DB sidecar denial proof, and a decision on whether broader `.codex-workers` artifacts are part of the session-artifact boundary.

## Goal Kind

Specific execution tranche.

## Goal Oracle

A final Judge audit maps every independent audit gap to one of:

- implemented with focused tests and green full verification;
- intentionally out of scope with a recorded rationale and, if useful, a follow-up issue;
- blocked with a concrete blocker and no unsafe behavior left untested.

The oracle must include passing local verification and any opened/merged PR or follow-up issue hygiene.

## Completion Proof

Completion requires:

- the `auto-proceed` reviewer-failure operator-routing edge case is fixed or a Judge explicitly proves it is not a bug;
- focused tests cover sandbox setup failure, invalid JSON, timeout, cwd/env isolation, and DB sidecar denial unless a Judge narrows scope with evidence;
- broader `.codex-workers` artifact scope is decided and either implemented/tested or tracked as a separate hardening issue;
- docs remain accurate after any behavior changes;
- `python3 -m unittest tests.test_workerctl -v`, `python3 -m py_compile workerctl/*.py`, `git diff --check`, and `./scripts/rc-check` pass;
- a final Judge receipt says `full_outcome_complete: true`.

## Non-Goals

- Do not reopen issue #130 unless the implementation is materially wrong.
- Do not replace the macOS `sandbox-exec` design unless Scout/Judge find a concrete reason it cannot safely cover these gaps.
- Do not broaden the sandbox to deny all filesystem reads unless the session-artifact decision task approves that larger scope.
- Do not touch unrelated dispatch/dashboard work except as needed for issue/PR hygiene.

## Constraints

- Preserve failure-to-stop semantics.
- Preserve telemetry and review-output redaction; no raw rollout, DB, prompt, transcript, stdout, stderr, or secret content should leak through failure surfaces.
- Keep implementation scoped to continuation-reviewer code/tests/docs unless Judge approves otherwise.
- Use the repo's existing unittest and CLI patterns.
- Treat #130 as closed and PR #132 as the baseline; this is follow-up hardening, not a rewrite.

## Likely Misfire

The likely misfire is adding a few superficial tests while leaving the `auto-proceed` failure-routing edge case or unproven sandbox setup branches untouched. Another misfire is broadening filesystem denial without deciding whether broader `.codex-workers` artifacts are actually in scope for this tranche.

## Starter Command

```text
/goal Follow docs/goals/continuation-reviewer-gap-hardening/goal.md.
```
