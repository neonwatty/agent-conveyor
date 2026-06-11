# Codex App Wake Orchestration

## Objective

Implement the next autonomy slice for Agent Conveyor so Codex app manager sessions can safely coordinate app-created worker sessions using Conveyor status, wake planning, leases, and receipts.

This goal should build on the merged app autonomy runtime after PR #281. It must not treat direct Codex app thread messages as durable state. Dispatch inboxes, routed notifications, leases, and audit receipts remain the source of truth.

## Original Request

"Think out these next steps very carefully and implement them with Goalbuddy Prepboard."

The surrounding conversation focused on moving Agent Conveyor toward more hands-off manager/worker relationships by layering Conveyor management, auditing, dispatch, and heartbeat discipline on top of the Codex app's native ability to create and message sessions.

## Interpreted Outcome

Agent Conveyor gains a bounded, verified wake-orchestration path:

- It can inspect manager/worker/dispatch heartbeat status for Codex app-backed loops.
- It can decide which role, if any, should be woken.
- It can produce or drive role-specific Codex app wake prompts through an explicit adapter boundary.
- It records enough receipts to let a manager or judge verify what was planned, attempted, skipped, and why.
- It refuses to pretend app-thread messaging is the durable communication layer.

## Oracle

A local verified run proves wake orchestration can identify stale manager/worker app threads, produce or send the correct wake prompts, preserve Dispatch/inbox truth, and leave healthy roles alone. The proof must include focused tests, package smoke or equivalent CLI smoke, release-check or equivalent full project verification, and a strongest-failure-mode probe.

## Likely Misfire

Shipping an "autonomous" layer that only prints prompts, pings app threads without lease/receipt discipline, or treats `send_message_to_thread` as the source of truth while Dispatch/inbox status is missing or stale.

## Constraints

- Do not merge or publish unless the user explicitly requests it.
- Do not touch generated `dist/`.
- Do not change product behavior unrelated to app-loop wake orchestration.
- Do not require raw terminal-only `conveyor` code to call Codex app-only tools directly.
- Keep durable state in Conveyor/Dispatch receipts, not direct app-thread messages.
- Preserve terminal/tmux behavior and existing no-tmux app-loop setup.
- Treat worker claims, happy-path tests, and optimistic summaries as claims until verified.

## Completion Proof

The final audit must include:

- Exact commands run and their results.
- Diff or file evidence for the implemented orchestration boundary.
- Test evidence covering stale manager, stale worker, healthy loop, missing dispatch, and skipped wake cases.
- A strongest realistic failure mode and proof that it was checked.
- A recommendation for PR, release, and the next single worker task.

## Conveyor Board

The board for this goal lives in `state.yaml`. Long receipts should be added under `notes/`.
