---
name: conveyor-smoke-app-connections
description: Run the blocking Agent Conveyor Codex app connection smoke gate for a manager/worker pair or worker set before real work starts.
---

# Conveyor Smoke App Connections

Use this skill after an Agent Conveyor Codex app manager/worker pair or worker
set has been created and bound, but before sending the real work prompt.

This skill proves connection plumbing. It is not a task channel. Dispatch
inboxes, `inbox-ack`, `app-heartbeat`, and `app-smoke` receipts remain the
durable truth. Direct Codex app thread messages are visible wake/smoke prompts
only.

## Rules

- Operator-facing only.
- Codex app native sessions only.
- Use `.codex-workers/workerctl.db` under the current project unless the
  operator explicitly provides another path.
- Do not inspect product code or private thread content.
- Default to `--mode required`; do not use `advisory` or `skip` unless the
  operator explicitly asks for it.
- Never send to a thread id supplied by the operator freeform. Only send to
  thread ids returned by `conveyor app-smoke start|status` for the same task
  and smoke id.
- Use the Codex app `send_message_to_thread` tool for each app-thread smoke
  prompt send. After every send, record one Conveyor receipt with
  `conveyor app-smoke record ... --status sent`.
- If app thread tools are unavailable or a send fails, record
  `--status blocked` for that role and stop before real work.
- A final answer in an app thread is not smoke proof. Smoke proof requires
  fresh `app-heartbeat`, inbox acknowledgement where applicable, and
  `app-smoke status`.
- If `conveyor app-smoke status` reports `real_work_allowed=false`, do not send
  the real task prompt.

## Default Ledger

```bash
mkdir -p .codex-workers
LEDGER="$PWD/.codex-workers/workerctl.db"
```

## Pair Flow

1. Identify the task. If the task is unknown, list candidates:

```bash
conveyor tasks --path "$LEDGER" --json
```

2. Run preflight:

```bash
TASK="example-task"
conveyor app-smoke preflight "$TASK" --mode required --scope pair --path "$LEDGER" --json
```

If preflight has blockers, report them and stop.

3. Start smoke:

```bash
conveyor app-smoke start "$TASK" --mode required --scope pair --path "$LEDGER" --json
```

Capture `smoke.id`, `smoke.nonce`, `roles.manager.thread_id`, and
`roles.worker.thread_id` from the returned status.

4. Queue the worker smoke inbox item:

```bash
SMOKE_ID="<smoke.id>"
NONCE="<smoke.nonce>"
conveyor enqueue-nudge-worker "$TASK" \
  --message "CONVEYOR SMOKE ${NONCE}: consume this inbox item, run app-heartbeat, record inbox-ack received and accepted, then record app-smoke received and accepted for smoke ${SMOKE_ID}. Do no product work." \
  --correlation-id "$SMOKE_ID-worker-smoke" \
  --path "$LEDGER" \
  --json
conveyor dispatch --watch --watch-iterations 1 --interval 2 \
  --dispatcher-id dispatch-local \
  --path "$LEDGER" \
  --json
```

5. Send the manager smoke prompt to the manager thread with native Codex app
thread tools. Use only the thread id from `app-smoke start|status`.

Manager prompt:

```text
Use the manage-codex-workers skill.
CONVEYOR SMOKE <NONCE>

You are the manager smoke target for Agent Conveyor task <TASK>.
Do not inspect product code or private content. Do not start the real task.

Print these visible sections:
CONVEYOR SMOKE RECEIVED
CONVEYOR SMOKE ACK
CONVEYOR SMOKE REPORT

Run:
conveyor app-heartbeat '<TASK>' --role manager --path '<LEDGER>' --json

Then poll for the worker smoke report:
conveyor manager-inbox '<TASK>' --consume-next --wait --timeout 60 --path '<LEDGER>' --json

If you consume a manager inbox item for smoke <NONCE>, record:
conveyor inbox-ack '<TASK>' --notification-id '<consumed.id>' --role manager --status received --from-stdin --path '<LEDGER>' --json
conveyor inbox-ack '<TASK>' --notification-id '<consumed.id>' --role manager --status accepted --from-stdin --path '<LEDGER>' --json
conveyor app-smoke record '<TASK>' --smoke-id '<SMOKE_ID>' --nonce '<NONCE>' --role manager --status accepted --thread-id '<MANAGER_THREAD_ID>' --notification-id '<consumed.id>' --from-stdin --path '<LEDGER>' --json

If blocked, record app-smoke blocked with the exact blocker.
Stop after the smoke receipt. Do not start real work.
```

If the send succeeds, record:

```bash
conveyor app-smoke record "$TASK" \
  --smoke-id "$SMOKE_ID" \
  --nonce "$NONCE" \
  --role manager \
  --status sent \
  --thread-id "<manager thread id from app-smoke status>" \
  --path "$LEDGER" \
  --json
```

6. Send the worker smoke prompt to the worker thread with native Codex app
thread tools. Use only the thread id from `app-smoke start|status`.

Worker prompt:

```text
Use the manage-codex-workers skill.
CONVEYOR SMOKE <NONCE>

You are the worker smoke target for Agent Conveyor task <TASK>.
Do not inspect product code or private content. Do not start the real task.

Print these visible sections:
CONVEYOR SMOKE RECEIVED
CONVEYOR SMOKE ACK
CONVEYOR SMOKE REPORT

Run:
conveyor app-heartbeat '<TASK>' --role worker --path '<LEDGER>' --json
conveyor worker-inbox '<TASK>' --consume-next --wait --timeout 60 --path '<LEDGER>' --json

For the consumed smoke item, record:
conveyor inbox-ack '<TASK>' --notification-id '<consumed.id>' --role worker --status received --from-stdin --path '<LEDGER>' --json
conveyor app-smoke record '<TASK>' --smoke-id '<SMOKE_ID>' --nonce '<NONCE>' --role worker --status received --thread-id '<WORKER_THREAD_ID>' --notification-id '<consumed.id>' --from-stdin --path '<LEDGER>' --json

Then record accepted:
conveyor inbox-ack '<TASK>' --notification-id '<consumed.id>' --role worker --status accepted --from-stdin --path '<LEDGER>' --json
conveyor app-smoke record '<TASK>' --smoke-id '<SMOKE_ID>' --nonce '<NONCE>' --role worker --status accepted --thread-id '<WORKER_THREAD_ID>' --notification-id '<consumed.id>' --from-stdin --path '<LEDGER>' --json

Finally notify the manager:
conveyor enqueue-notify-manager '<TASK>' --message 'CONVEYOR SMOKE <NONCE>: worker accepted smoke.' --correlation-id '<SMOKE_ID>-worker-report' --path '<LEDGER>' --json
conveyor dispatch --watch --watch-iterations 1 --interval 2 --dispatcher-id dispatch-local --path '<LEDGER>' --json

If blocked, record app-smoke blocked with the exact blocker and notify the manager.
Stop after the smoke receipt. Do not start real work.
```

If the send succeeds, record:

```bash
conveyor app-smoke record "$TASK" \
  --smoke-id "$SMOKE_ID" \
  --nonce "$NONCE" \
  --role worker \
  --status sent \
  --thread-id "<worker thread id from app-smoke status>" \
  --path "$LEDGER" \
  --json
```

7. Poll status until it passes or a blocker is clear:

```bash
conveyor app-smoke status "$TASK" --smoke-id "$SMOKE_ID" --path "$LEDGER" --json
```

If `real_work_allowed=true`, the setup may send the real work prompt. If
`real_work_allowed=false`, report exact blockers and stop.

## Worker Set Flow

For worker sets, run the pair flow once per bound worker task. Treat each worker
task's `app-smoke status` as one shard. The set passes only when every required
worker task reports `real_work_allowed=true`.

Do not use one task's smoke receipt to prove another worker. Do not use
`--worker-count > 1` as proof for a single task; the package intentionally
fails that closed so this skill must aggregate per-worker task receipts.

## Final Receipt

End with:

- `task` or `tasks`
- `ledger`
- `mode`
- `smoke_ids`
- `manager_thread_id`
- `worker_thread_ids`
- `sent_roles`
- `accepted_roles`
- `blocked_roles`
- `status_after`
- `real_work_allowed`
- `next_action`

If any role is blocked, name the exact blocker and do not report the smoke as
passed.
