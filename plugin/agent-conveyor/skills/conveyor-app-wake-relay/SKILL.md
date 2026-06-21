---
name: conveyor-app-wake-relay
description: Wake stale Agent Conveyor Codex app manager or worker threads through native app thread tools and record delivery receipts.
---

# Conveyor App Wake Relay

Use this skill when the operator asks to wake, restart, or nudge an existing
Agent Conveyor Codex app manager/worker pair or worker set from the current
project.

This skill is a relay, not a task channel. Dispatch inboxes, acknowledgements,
audit, and replay remain the durable task truth. A direct Codex app thread
message is only a wake prompt that asks the target session to poll and record
receipts.

## Rules

- Operator-facing only.
- Codex app native sessions only.
- Use `.codex-workers/workerctl.db` under the current project unless the
  operator explicitly provides another path.
- Do not inspect product code or private thread content.
- Never send to a thread id supplied by the operator freeform. Only send to a
  thread id returned by `conveyor app-wakeup-dispatch` for the same task.
- Only call `send_message_to_thread` for actions with `send_ready=true` and
  `status=ready_to_send`.
- After every prepared action, record one Conveyor delivery receipt:
  `sent`, `skipped`, or `blocked`.
- If app thread tools are unavailable or a send fails, record `blocked`; do not
  claim the role was woken.
- Direct app-thread text is not task completion, not manager notification, and
  not message acknowledgement.
- For consumed inbox messages, the recipient session must use
  `conveyor inbox-ack` to record `received`, then `accepted` or `blocked`.

## Default Ledger

```bash
mkdir -p .codex-workers
LEDGER="$PWD/.codex-workers/workerctl.db"
```

## Operator Flow

1. Identify the task. If the task is unknown, list candidates:

```bash
conveyor tasks --path "$LEDGER" --json
```

2. Prepare wake actions and a durable dispatch receipt:

```bash
TASK="example-task"
conveyor app-wakeup-dispatch "$TASK" --path "$LEDGER" --json
```

3. For each returned action:

- If `status=ready_to_send` and `send_ready=true`, call the Codex app thread
  tool `send_message_to_thread` with that action's `thread.id` and exact
  `prompt`.
- If the send succeeds, record:

```bash
conveyor app-wakeup-record-delivery "$TASK" \
  --role "<action.role>" \
  --dispatch-receipt "<receipt.event_id>" \
  --delivery-status sent \
  --thread-id "<action.thread.id>" \
  --reason "Codex app send_message_to_thread delivered wake prompt" \
  --path "$LEDGER" \
  --json
```

- If the action is healthy/skipped, record:

```bash
conveyor app-wakeup-record-delivery "$TASK" \
  --role "<action.role>" \
  --dispatch-receipt "<receipt.event_id>" \
  --delivery-status skipped \
  --reason "<action.reason>" \
  --path "$LEDGER" \
  --json
```

- If the action is blocked, a thread id is missing, app thread tools are
  unavailable, or `send_message_to_thread` fails, record:

```bash
conveyor app-wakeup-record-delivery "$TASK" \
  --role "<action.role>" \
  --dispatch-receipt "<receipt.event_id>" \
  --delivery-status blocked \
  --reason "<blocker or send failure>" \
  --path "$LEDGER" \
  --json
```

4. Re-check loop state:

```bash
conveyor app-loop-status "$TASK" --path "$LEDGER" --json
```

## Final Receipt

End with:

- `task`
- `ledger`
- `dispatch_receipt`
- `sent_roles`
- `skipped_roles`
- `blocked_roles`
- `status_after`
- `next_action`

If any role is blocked, name the exact blocker and do not report the loop as
woken.
