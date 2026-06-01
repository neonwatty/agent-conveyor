# Codex + Chrome Dashboard QA

This directory contains repeatable Markdown task files for driving the
`workerctl-dispatch-lab` scenarios with Codex and Chrome.

Use these when the operator wants Codex to run a lab scenario, open the
dashboard in Chrome, watch the manager/worker/Dispatch loop, and record
pass/fail evidence.

## Task Files

- [Simple calculator](simple-calculator.md) - smallest end-to-end smoke test.
- [Complex refactor](complex-refactor.md) - order-pricing multi-rule test.
- [Support triage](support-triage.md) - support routing, SLA, and summary test.
- [Subscription billing](subscription-billing.md) - billing, credits, proration,
  entitlement, and audit-summary test.
- [Dashboard evidence review](dashboard-evidence-review.md) - dashboard
  evidence summarization and what-next review test.
- [Nudge readiness report](nudge-readiness-report.md) - dedicated what-next
  nudge, worker-side assessment, and manager-side comparison test.
- [Managed Ralph loop](ralph-loop.md) - repeated manager-led PR, CI, merge,
  handoff, worker clear, and same-prompt replay test.
- [Adversarial triggers](adversarial-triggers.md) - natural-language trigger
  phrases for Ralph-loop policy, Dispatch continuation gates, finish gates,
  worker-proposed proof, and manager-created adversarial criteria.
- [GoalBuddy conveyor live dogfood](goalbuddy-conveyor-live-dogfood.md) -
  two-child smoke for `satisfied_on_main`, one-active-child sequencing, and
  PR/CI/merge receipt rails.
- [Late attach support reporter](late-attach-support-reporter.md) - assign a
  manager after worker progress on a small CLI/reporting feature.

## Standard Invocation

Ask Codex:

```text
Use Chrome to run docs/qa/<scenario>.md and report the QA result.
```

Codex should follow the selected task file exactly, use Chrome for dashboard
inspection, and record evidence in the format from [evidence-template.md](evidence-template.md).

## Common Pass Bar

A run passes only when all of these are true:

- `LAB_SCENARIO=<scenario> ./lab qa-start` starts the pair and dashboard.
- Chrome can open the printed dashboard URL.
- The dashboard shows Dispatch active or the backend audit proves Dispatch is
  active when visual inspection is temporarily unavailable.
- Worker completion is routed as `worker_task_complete`.
- A manager cycle consumes the routed notification before `finish_task`
  succeeds.
- Accepted criteria are satisfied.
- The task reaches `done`.
- Cleanup stops dashboard/session processes and reset returns the lab to a known
  baseline.

Pane text alone is not enough. The run must include Dispatch chain evidence from
the dashboard and/or `workerctl audit`.
