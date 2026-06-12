# Codex App Session Bootstrap Templates

## Objective

Build the next autonomy slice for Agent Conveyor: Codex app-native manager and worker bootstrap templates that let a manager/operator create new Codex app sessions with Conveyor heartbeat, Dispatch/inbox polling, and wake-adapter receipt discipline already embedded.

The package should generate durable, auditable prompts and receipts. The Codex app session/operator remains responsible for native app-thread operations such as `create_thread` and `send_message_to_thread`.

## Context

`agent-conveyor@0.1.10` added app wake delivery receipts through `app-wakeup-record-delivery`. The system can now plan wakeups with `app-wakeup-dispatch`, send only `send_ready=true` prompts through Codex app tools, and record sent/skipped/blocked outcomes without treating app-thread delivery as durable task progress.

The next gap is reliable session creation. Today a manager can use the Codex app to create sessions, but the manager/worker prompts still need to be assembled carefully by hand. This tranche should make the bootstrap prompt shape explicit, testable, and reusable.

## Oracle

A verified bootstrap flow can produce manager and worker prompts that include:

- `manage-codex-workers` skill instruction.
- The default heartbeat cadence, normally every 2 minutes.
- Exact `conveyor app-heartbeat ... --role manager|worker ... --json` commands.
- Exact `manager-inbox` and `worker-inbox` polling commands.
- Dispatch expectation and missing/stale Dispatch handling.
- Wake recovery through `app-wakeup-dispatch` and `app-wakeup-record-delivery`.
- Manager rule: require evidence, verify worker claims, and produce exactly one next worker task.
- Worker rule: execute the assigned task, report evidence, then stop or await the next inbox item.
- Safety rules: do not inspect private phone content, do not treat app-thread delivery as completion, and preserve Dispatch/inbox/telemetry as authority.

The final proof must include tests or dry-run output that assert the above prompt content exactly enough to catch omissions, plus a disposable Codex app thread proof only if needed and safe.

## Likely Misfire

The generated bootstrap looks plausible but omits one autonomy-critical loop: heartbeat, inbox polling, Dispatch, wake recovery, delivery receipts, or evidence verification. Another likely misfire is putting Codex app-only thread calls inside terminal package code instead of the Codex app/operator layer.

## Constraints

- Do not publish or merge unless explicitly requested.
- Do not touch generated `dist/`.
- Do not inspect private phone content.
- Do not send app-thread messages during tests unless the target thread ids are explicitly created disposable test threads for this board.
- Keep Dispatch/inbox/telemetry receipts authoritative.
- Treat app-thread tool availability as a claim until verified in the current Codex app environment.
- Do not implement before Scout maps the existing surfaces and Judge approves the implementation boundary.

## Completion Proof

The final audit must include:

- Scout evidence for current session binding, app heartbeat, wake dispatch, and Codex app thread tooling surfaces.
- Judge decision on whether this is package command, skill guidance, app-operator procedure, or a mixed slice.
- Prompt/template tests or dry-run proof covering manager and worker bootstraps.
- Proof that missing heartbeat, inbox, Dispatch, wake recovery, or evidence rules would be caught by tests.
- Package/skill smoke or equivalent.
- GoalBuddy state checker evidence.
- A next single worker task or close recommendation.
