# Dashboard Live QA Lane

## Objective

Build a live dashboard QA lane for worker/manager supervision so the operator can watch connection state, activity, telemetry, commands, discovery results, and suggested binding actions without repeatedly juggling tmux terminals or manual refreshes.

## Original Request

The user asked to plan and execute a dashboard improvement that shows a live tail visualization of what is happening between the worker and manager during manual QA, including connection state, telemetry, commands, discovery, and binding.

## Intake Summary

- Input shape: `existing_plan`
- Audience: the repo owner/operator manually QAing worker/manager supervision flows
- Authority: `approved`
- Proof type: `demo`
- Completion proof: a local dashboard walkthrough demonstrates a selected task with live-updating connection state and activity, discovery of existing worker/manager/task candidates, suggested binding action, terminal panes still attached, and a manual QA loop run from the dashboard.
- Goal oracle: a Playwright-backed dashboard walkthrough plus local tests proves that the dashboard can discover candidates, bind/select a pair, poll or stream updated snapshot state, show recent telemetry/command/cycle activity without manual refresh, and preserve the existing terminal/control workflow.
- Likely misfire: adding static widgets or a pretty activity list that still requires manual refresh and does not help the operator understand whether the worker and manager are connected and progressing.
- Blind spots considered: polling load, dashboard state jumpiness, stale data, discovery ambiguity, mutating bind safety, terminal regressions, telemetry noise, raw transcript/log amplification, and keeping Python `workerctl` as the source of truth.
- Existing plan facts:
  - Start with the existing dashboard and `workerctl telemetry snapshot`.
  - Add client polling before deeper backend changes.
  - Make the activity rail clearly live, deduplicated, and compact.
  - Add a connection state panel for task, worker, manager, binding, and latest cycle.
  - Add dashboard integration for `workerctl discover/search`.
  - Let discovery present candidate tasks, sessions, bindings, telemetry matches, and suggested actions.
  - Require explicit user click before binding a suggested pair.
  - Verify with dashboard tests and Playwright/manual QA.

## Goal Oracle

The oracle for this goal is:

`A local dashboard walkthrough shows a selected worker/manager task where connection state and activity update without manual refresh, discovery returns likely worker/manager/task options, a suggested bind can be executed explicitly, terminals still attach correctly, and telemetry/commands/cycles visibly update after dashboard actions.`

Planning, unit-only proof, or a static dashboard screenshot is not enough. The goal finishes only when a final audit maps tests and browser/manual verification back to this oracle and records `full_outcome_complete: true`.

## Goal Kind

`existing_plan`

## Current Tranche

Deliver the next useful dashboard vertical slice: a live QA lane with polling, activity tail, connection state, discovery, and suggested binding.

## Non-Negotiable Constraints

- Keep dashboard local-only by default.
- Do not expose raw transcript/log-like content in the dashboard or Codex chat by default.
- Keep Python `workerctl` as the durable control-plane source of truth.
- TypeScript dashboard backend shells out to stable `workerctl` JSON commands.
- Preserve existing xterm.js/PTy terminal attach behavior.
- Do not auto-bind silently; suggested binding must require an explicit user action.
- Avoid UI jumpiness during polling.
- Follow existing repo patterns and tests.

## Stop Rule

Stop only when a final audit proves the full original outcome is complete.

Do not stop after planning, discovery, or a single partial UI improvement if a safe next Worker package remains.

## Canonical Board

Machine truth lives at:

`docs/goals/dashboard-live-qa-lane/state.yaml`

If this charter and `state.yaml` disagree, `state.yaml` wins for task status, active task, receipts, verification freshness, and completion truth.

## Run Command

```text
/goal Follow docs/goals/dashboard-live-qa-lane/goal.md.
```

## PM Loop

On every `/goal` continuation:

1. Read this charter.
2. Read `state.yaml`.
3. Re-check the oracle, likely misfire, and constraints.
4. Work only on the active board task.
5. Assign Scout, Judge, Worker, or PM according to the task.
6. Write a compact task receipt.
7. Update the board.
8. Continue to the next safe task until the oracle is proven.
