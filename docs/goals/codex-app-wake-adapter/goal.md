# Codex App Wake Adapter

## Objective

Implement the next autonomy slice for Agent Conveyor: a Codex app manager/operator adapter that consumes `conveyor app-wakeup-dispatch --json` and sends direct Codex app thread wake messages only for actions that are explicitly `send_ready=true`.

The adapter must preserve Conveyor as the durable source of truth. `app-wakeup-dispatch` telemetry receipts, Dispatch heartbeat state, routed notifications, and inbox consumption remain authoritative. `send_message_to_thread` is a delivery action, not task state.

## Context

PR #282 added `app-wakeup-dispatch` and published in `agent-conveyor@0.1.9`. That command prepares role wake actions, reports skipped/blocked roles, records telemetry, and keeps missing Dispatch visible even when app thread wake actions are send-ready.

This board should build the app-layer side carefully. The package must not pretend terminal-only code can call Codex app tools. The adapter belongs in the Codex app operator/skill boundary unless Scout and Judge prove a safer package API exists.

## Oracle

A verified Codex app manager flow can:

- Run `conveyor app-wakeup-dispatch TASK --json`.
- Send wake prompts through `send_message_to_thread` only for `send_ready=true` actions.
- Skip healthy roles and blocked missing-thread roles with explicit receipts.
- Preserve missing/stale Dispatch as a blocker or required next action.
- Record enough local Conveyor/app-operator evidence that a Judge can audit what was sent, skipped, blocked, and why.

## Likely Misfire

Building a helper that blindly sends every prompt, treats app-thread delivery as durable success, hides missing Dispatch, or cannot be used from the Codex app's native session tooling.

## Constraints

- Do not merge or publish unless explicitly requested.
- Do not touch generated `dist/`.
- Do not inspect private phone content.
- Do not send app-thread messages during tests unless the target thread ids are explicitly created disposable test threads for this board.
- Keep Dispatch/inbox/telemetry receipts authoritative.
- Treat app-thread tool availability as a claim until verified in the current Codex app environment.

## Completion Proof

The final audit must include:

- Exact app-thread tool availability evidence.
- A proof that only `send_ready=true` actions are sent.
- A proof that healthy and blocked roles are skipped.
- A proof that missing Dispatch remains visible and does not become success.
- Local tests, package/skill smoke or equivalent, and GoalBuddy checker evidence.
- A next single worker task or close recommendation.

