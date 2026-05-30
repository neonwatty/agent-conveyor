# Ralph Loop Evidence Gates

## Objective

Make Ralph/ROF loop continuation evidence-gated so Dispatch refuses a manager's "run another iteration" request when required worker/PR/CI/merge/cleanup evidence is missing, before any invalid message reaches a worker.

## Original Request

Plan the next guardrail slice after max-iteration blocking: evidence-gated continuation for Ralph-loop manager-worker workflows.

## Intake Summary

- Input shape: `specific`
- Audience: `workerctl` operators, Ralph-loop managers, Codex app workers, tmux workers, Dispatch maintainers, and dashboard QA reviewers.
- Authority: `requested`
- Proof type: `test + demo + review`
- Completion proof: A merged implementation with automated tests and browser QA proves Dispatch blocks a continuation before worker delivery when required evidence is missing, then allows the continuation after the missing evidence is recorded.
- Goal oracle: A browser-backed QA scenario starts a loop with `max_iterations=3` and a required `ci_green` continuation gate, has the manager request iteration 2 before CI evidence exists, proves Dispatch blocks with `missing_ci_green_evidence` and no worker delivery, then records CI-green evidence and proves a new iteration 2 request is delivered.
- Likely misfire: Adding documentation or dashboard labels for evidence requirements while Dispatch still delivers continuation commands before the required evidence exists.
- Blind spots considered:
  - Dispatch must enforce explicit mechanical evidence requirements only; it must not decide code quality, test adequacy, PR content, or strategic next work.
  - Missing evidence must produce a manager/operator refusal receipt instead of a silent drop.
  - The same pre-delivery gate must cover tmux push delivery and Codex app worker-inbox polling.
  - The browser QA must prove both the negative path and the recovery path: first no worker delivery, then delivery after evidence is present.
  - Evidence names and reasons must be machine-readable so later policy gates can compose without brittle text parsing.
  - Replays and audit output must preserve the command, manager decision, correlation id, missing evidence, and delivery outcome.

## Goal Oracle

The oracle for this goal is:

`A local browser QA walkthrough shows a Ralph loop with max_iterations=3 and required ci_green evidence where the manager requests iteration 2 before CI evidence exists; Dispatch blocks the command before delivery with reason missing_ci_green_evidence, worker inbox/tmux delivery remain empty, dashboard/replay/audit show the blocked command and missing evidence; after CI-green evidence is recorded, a new iteration 2 continuation is delivered and visible in worker inbox or routed notification evidence.`

The PM must keep comparing task receipts to this oracle. Planning, discovery, backend-only unit tests, or a dashboard-only mock is not enough. The goal finishes only when a final audit maps receipts and verification back to this oracle and records `full_outcome_complete: true`.

## Goal Kind

`specific`

## Current Tranche

Deliver the next useful Ralph-loop guardrail slice:

1. Preserve the manager-led model: managers request continuation, Dispatch enforces configured mechanical evidence gates, and workers only receive valid work.
2. Add or validate durable loop policy fields for continuation evidence requirements such as worker completion, PR URL, CI-green evidence, merge evidence, and cleanup receipts.
3. Block invalid `continue_iteration` delivery in Dispatch before tmux push or session inbox creation when required evidence is missing.
4. Record machine-readable refusal receipts for the manager and operator surfaces.
5. Add dashboard/browser QA that proves missing evidence blocks delivery and adding evidence allows delivery.
6. Verify with automated tests, browser walkthrough, PR review, and final audit.

## Non-Negotiable Constraints

- Dispatch must not decide task success, code quality, PR quality, CI interpretation beyond explicit recorded evidence, merge readiness beyond explicit recorded evidence, or next strategic work.
- Dispatch may enforce only explicit loop policy and mechanical preconditions such as missing worker completion receipt, missing PR URL, missing CI-green evidence, missing merge evidence, missing cleanup receipt, missing permission, exhausted budget, or exhausted max iterations.
- A blocked continuation must not create a worker-directed routed notification and must not push to tmux.
- The manager must receive a refusal receipt with a machine-readable reason and missing evidence list.
- Guardrails must work for both tmux-backed workers and Codex app workers that poll `worker-inbox`.
- Preserve existing Dispatch behavior for non-loop commands unless the command is explicitly loop-scoped.
- Browser QA must prove the negative worker-delivery case and the positive recovery case.

## Acceptance Criteria

- A Ralph-loop run can persist required continuation evidence policy such as `required_before_continue=["worker_completion","pr_url","ci_green","merge","cleanup"]` or an equivalent structured schema.
- Evidence records or existing receipts can be linked to a loop run, iteration, manager decision, task, and correlation id without brittle text parsing.
- A manager continuation request remains a durable `continue_iteration` command with loop run id, requested iteration, manager decision id, and correlation id.
- When required evidence is missing, Dispatch refuses the continuation before delivery.
- Refusal records include `state=blocked`, `reason=<missing_evidence_reason>`, `missing_evidence`, `delivered=false`, `target_worker_notified=false`, `current_iteration`, `max_iterations`, command id, manager decision id, and correlation id.
- The worker receives no tmux push and no worker inbox item for the blocked continuation.
- The manager/operator can see the refusal through command output, dashboard, replay, or audit.
- After the missing evidence is recorded, a fresh continuation request for the same next iteration is delivered normally.
- Dashboard/browser QA shows loop policy, current/max iteration count, missing evidence reason, missing evidence list, zero notification/inbox for the blocked attempt, and a delivered notification/inbox item for the allowed retry.
- Automated tests cover missing CI-green blocking, allowed continuation after evidence exists, no-tmux worker inbox blocking, tmux side-effect blocking, and preservation of existing max-iteration blocking.
- Browser QA test case covers: create loop with `max_iterations=3` and required `ci_green`, complete or seed iteration 1 without CI evidence, request iteration 2, observe Dispatch block, verify worker inbox remains empty, record CI-green evidence, request iteration 2 again, observe Dispatch deliver, verify worker inbox or routed notification has the item, and verify dashboard/replay/audit evidence.
- `python3 -m unittest tests.test_workerctl -v` passes.
- Dashboard tests/build pass if dashboard files change.
- `git diff --check` passes.
- PR review toolkit reports no actionable findings before merge.

## Stop Rule

Stop only when a final audit proves the full evidence-gated continuation workflow is implemented, visible, tested, browser-QA-proven, reviewed, and ready to merge.

Do not stop after planning, discovery, data-model design, backend-only tests, or dashboard-only rendering if the worker-delivery block and recovery delivery path are not proven.

Do not mark complete unless a final Judge/PM receipt records `full_outcome_complete: true`.

## Canonical Board

Machine truth lives at:

`docs/goals/ralph-loop-evidence-gates/state.yaml`

If this charter and `state.yaml` disagree, `state.yaml` wins for task status, active task, receipts, verification freshness, and completion truth.

## Run Command

```text
/goal Follow docs/goals/ralph-loop-evidence-gates/goal.md.
```
