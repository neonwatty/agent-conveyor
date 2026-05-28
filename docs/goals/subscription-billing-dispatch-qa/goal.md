# Subscription Billing Dispatch QA

## Objective

Create and validate the next harder workerctl Dispatch QA lab tranche: a fresh-from-main dashboard QA pass plus a durable subscription-billing scenario that stresses manager/worker handoff, dispatcher routing, dashboard evidence, and repeatable reset behavior.

## Original Request

Plan the next QA lab with GoalBuddy after merging the dashboard dispatch evidence PR and creating the QA lab repo.

## Intake Summary

- Input shape: `specific`
- Audience: the operator and future manager/worker dashboard QA runs
- Authority: `requested`
- Proof type: `demo`
- Completion proof: a fresh-from-main QA run using the new lab repo proves Dispatch starts automatically, routes a worker completion, is consumed by a manager cycle, and finishes with dashboard-visible evidence; the new harder scenario is committed/pushed in the lab repo with repeatable reset/run docs.
- Goal oracle: dashboard-visible Dispatch evidence from a clean QA run plus repo verification for the new scenario.
- Likely misfire: building a clever scenario or writing docs without proving the manager/worker conversation actually flows through Dispatch in the dashboard.
- Blind spots considered: scenario complexity can obscure dispatch evidence; lab repo and product repo may drift; dashboard proof can be falsely inferred from pane text instead of dispatch chains; cleanup/reset must be repeatable after failed runs.
- Existing plan facts:
  - Product PR `#144` is merged.
  - QA lab repo now exists at `neonwatty/workerctl-dispatch-lab`.
  - Existing scenarios include `complex-refactor` and `support-triage`.
  - The desired next scenario is a more complex subscription-billing migration with pricing, invoices, entitlement windows, refunds/credits, and audit summaries.

## Goal Oracle

The oracle for this goal is:

`A clean manual QA cycle from fresh main shows Dispatch active in the dashboard, a worker_task_complete notification routed from a source event, a manager cycle consuming that routed fact, finish_task succeeding, task state done, and all accepted criteria satisfied; the new subscription-billing lab scenario is committed and pushed with repeatable reset/run documentation and passing verification for the fixed worker output.`

The PM must keep comparing task receipts to this oracle. Planning, scenario files alone, passing pytest alone, or a dashboard that only shows pane text is not enough. The goal finishes only when a final Judge/PM audit maps receipts and verification back to this oracle and records `full_outcome_complete: true`.

## Goal Kind

`specific`

## Current Tranche

This tranche should move from local proof to a reusable harder QA surface. The run should first re-establish fresh-from-main confidence, then add the subscription-billing scenario as the next durable stress test, then exercise that scenario through the dashboard with Dispatch proof.

## Non-Negotiable Constraints

- Do not implement product or lab changes without an active Worker task.
- Keep lab changes in `/Users/neonwatty/Desktop/workerctl-dispatch-lab` and product changes in `/Users/neonwatty/Desktop/codex-terminal-manager`.
- Preserve repeatability: every scenario must support destructive reset, fresh run creation, dashboard start, cleanup, and reset back to a known fixture.
- Dashboard proof must come from Dispatch chains, not just worker/manager pane text.
- Manager completion must not happen before the manager cycle consumes the routed dispatch notification.
- Any product fix discovered during QA must be separated from lab-scenario work and verified in the product repo.

## Stop Rule

Stop only when a final audit proves the full original outcome is complete.

Do not stop after planning, discovery, or Judge selection if a safe Worker task can be activated.

Do not stop after a single verified Worker package when the broader owner outcome still has safe local follow-up work. Advance the board to the next highest-leverage safe Worker package and continue unless a phase, risk, rejected-verification, ambiguity, or final-completion review is due.

Do not create one Worker/Judge pair per repeated file, helper, or test. Put repeated same-shape work into one Worker package and review the package as a whole.

## Slice Sizing

Safe means bounded, explicit, verified, and reversible. It does not mean tiny.

A good Worker task for this goal should produce a working QA milestone: a fresh-from-main QA pass, a complete scenario fixture, a dashboard-proven scenario run, or a focused product fix if QA exposes one.

## Canonical Board

Machine truth lives at:

`docs/goals/subscription-billing-dispatch-qa/state.yaml`

If this charter and `state.yaml` disagree, `state.yaml` wins for task status, active task, receipts, verification freshness, and completion truth.

## Run Command

```text
/goal Follow docs/goals/subscription-billing-dispatch-qa/goal.md.
```

## PM Loop

On every `/goal` continuation:

1. Read this charter.
2. Read `state.yaml`.
3. Run the bundled GoalBuddy update checker when available and mention a newer version without blocking.
4. Re-check the oracle, likely misfire, and repo split between product and lab.
5. Work only on the active board task.
6. Assign Scout, Judge, Worker, or PM according to the task.
7. Write a compact task receipt.
8. Update the board.
9. If safe local work remains, choose the next largest reversible Worker package and continue unless blocked.
10. Finish only with a Judge/PM audit receipt that maps receipts and verification back to the original user outcome and records `full_outcome_complete: true`.
