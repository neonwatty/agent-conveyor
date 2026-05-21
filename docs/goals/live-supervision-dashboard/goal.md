# Live Supervision Dashboard

## Objective

Design and build a local-first `workerctl dashboard` live supervision cockpit for debugging manager/worker runs from inside this repo.

## Original Request

The user wants a serious debugging dashboard, not just a lightweight terminal wrapper: a single-task live cockpit with interactive worker and manager terminals, telemetry diagnostics, skill execution signals, and controls that make manual QA and dogfood supervision easier than juggling tmux terminals.

## Intake Summary

- Input shape: `existing_plan`
- Audience: the repo owner/operator supervising Codex worker and manager sessions
- Authority: `approved`
- Proof type: `demo`
- Completion proof: a local dashboard can be launched from this repo, attach to a real registered worker/manager task, show interactive terminals and telemetry/criteria/replay diagnostics, run core actions through `workerctl`, and support an external dogfood pass.
- Goal oracle: a recorded dashboard dogfood walkthrough on a real or disposable task that demonstrates attach/bind, live terminals, snapshot diagnostics, telemetry review, run-cycle/nudge/interrupt/finish/export actions, and cleanup/reconcile checks.
- Likely misfire: shipping a nice-looking web terminal page that does not actually improve supervision, auditability, telemetry visibility, or the manual handoff workflow.
- Blind spots considered: terminal security, log amplification, local-only binding, xterm.js PTY lifecycle, stable JSON contracts, dashboard dependencies, task/session ambiguity, and not duplicating Python `workerctl` control-plane logic in TypeScript.
- Existing plan facts:
  - The dashboard is a live supervision cockpit first.
  - It is attach-first, not spawn-first.
  - It is single-task focused.
  - It has fully interactive worker and manager terminals side by side.
  - It uses xterm.js plus a TypeScript WebSocket PTY bridge.
  - It lives inside this repo as `workerctl dashboard`.
  - It uses TypeScript for frontend and backend.
  - The TypeScript backend shells out to stable `workerctl` JSON commands rather than reimplementing SQLite logic.
  - Terminal panes attach to existing tmux sessions via `node-pty` running `tmux attach`.
  - Desktop layout is a three-column cockpit: worker terminal, manager terminal, diagnostics rail.
  - The Overview rail should be backed by a new `workerctl telemetry snapshot --json --task <task>` command.
  - V1 includes attach/bind setup plus mutating controls for cycle, nudge, interrupt, finish, and export, routed through `workerctl` with receipts.
  - Dashboard registration of the current Codex session is not in v1; it shows copy-paste skill prompts and discovers registered sessions.

## Goal Oracle

The oracle for this goal is:

`A local dashboard walkthrough demonstrates one selected worker/manager task with interactive terminals, attach/bind setup, telemetry snapshot overview, criteria/telemetry/replay diagnostics, audited action receipts, finish/export, and clean reconcile output.`

The PM must keep comparing task receipts to this oracle. Planning, a static mockup, a terminal-only wrapper, or a passing isolated helper is not enough. The goal finishes only when a final Judge/PM audit maps receipts and verification back to this oracle and records `full_outcome_complete: true`.

## Goal Kind

`existing_plan`

## Current Tranche

Build the first usable local dashboard vertical slice, starting with the stable `workerctl telemetry snapshot --json --task <task>` contract and proceeding through the TypeScript dashboard backend/frontend until it can run a real attach-first supervision workflow.

## Non-Negotiable Constraints

- Local-only by default; bind dashboard servers to loopback unless the user explicitly changes that.
- Do not emit or copy raw transcript/log-like content into Codex chat or telemetry by default.
- Keep Python `workerctl` as the durable control-plane source of truth.
- TypeScript dashboard backend shells out to stable `workerctl` JSON commands for v1.
- Terminal panes attach to tmux-backed sessions; worker terminal requires tmux.
- Manager terminal is interactive only when manager is tmux-backed; otherwise dashboard controls and diagnostics still work.
- Mutating dashboard actions must show command receipts and require confirmation for interrupt, finish, and stop-session behavior.
- Follow existing repo patterns and tests.

## Stop Rule

Stop only when a final audit proves the full original outcome is complete.

Do not stop after planning, discovery, or Judge selection if a safe Worker task can be activated.

Do not stop after a single verified Worker package when the broader dashboard outcome still has safe local follow-up work. Advance the board to the next highest-leverage safe Worker package and continue unless a phase, risk, rejected-verification, ambiguity, or final-completion review is due.

## Slice Sizing

Safe means bounded, explicit, verified, and reversible. It does not mean tiny.

A good task is the largest safe useful slice. For this goal, useful slices should produce either a stable CLI/dashboard contract, a running dashboard shell, an attach/bind workflow, interactive terminal behavior, or a demonstrable cockpit workflow.

## Canonical Board

Machine truth lives at:

`docs/goals/live-supervision-dashboard/state.yaml`

If this charter and `state.yaml` disagree, `state.yaml` wins for task status, active task, receipts, verification freshness, and completion truth.

## Run Command

```text
/goal Follow docs/goals/live-supervision-dashboard/goal.md.
```

## PM Loop

On every `/goal` continuation:

1. Read this charter.
2. Read `state.yaml`.
3. Run the bundled GoalBuddy update checker when available and mention a newer version without blocking.
4. Re-check the dashboard decisions, constraints, likely misfire, and oracle.
5. Work only on the active board task.
6. Assign Scout, Judge, Worker, or PM according to the task.
7. Write a compact task receipt.
8. Update the board.
9. If safe local work remains, choose the next largest reversible Worker package and continue unless blocked.
10. Finish only with a Judge/PM audit receipt that maps receipts and verification back to the original dashboard outcome and records `full_outcome_complete: true`.
