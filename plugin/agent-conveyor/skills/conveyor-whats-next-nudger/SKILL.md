---
name: conveyor-whats-next-nudger
description: Run a bounded Agent Conveyor "what's next?" nudger loop for an existing Codex app manager/worker pair or worker set.
---

# Conveyor What's Next Nudger

Use this skill when the operator wants an existing Agent Conveyor Codex app
manager/worker pair or worker set to continue through a bounded number of
manager-approved follow-up passes. This skill does not create sessions, publish,
schedule, push, open PRs, merge, or archive workers unless the operator
explicitly grants that separate authority.

## Rules

- Operator-facing only.
- Codex app native sessions only.
- Use `.codex-workers/workerctl.db` under the current project unless the
  operator explicitly gives another path.
- Require a bounded loop count before continuing; default to 1 extra pass if
  the operator says "one more" and 2 passes if the operator gives no count.
- Treat worker "done" and "what's next" suggestions as claims until the
  manager verifies receipts.
- Continue only when the manager records concrete evidence and the proposed
  next slice is in scope, reversible, and consistent with current authority.
- Keep manager closeout/control-plane proof out of worker acceptance criteria;
  use it in the manager final report instead.
- Do not inspect private content, publish externally, or perform repo shipping
  actions unless the existing task policy explicitly permits the narrow action.
- Keep visible Codex session sections for consumed work:
  `CONVEYOR POLL`, `CONVEYOR RECEIVED`, `WORK`, `CONVEYOR SEND`, `DISPATCH`.

## Default Ledger

```bash
mkdir -p .codex-workers
LEDGER="$PWD/.codex-workers/workerctl.db"
```

## Operator Flow

1. Identify the task or campaign. If the task is unknown, list candidates:

```bash
conveyor tasks --path "$LEDGER" --json
```

2. Inspect current status before nudging:

```bash
TASK="example-task"
conveyor app-loop-status "$TASK" --path "$LEDGER" --json
conveyor loop-status "$TASK" --path "$LEDGER" --json
```

3. Ask the manager, not the worker directly, to evaluate the completed pass and
   choose one of:
   - stop with verified evidence;
   - request a narrow revision;
   - ask the worker "what's next?" and continue for one bounded pass.

Use the manager's inbox or visible app wake path for the existing setup. If the
setup exposes `app-wakeup-plan` or `app-wakeup-dispatch`, prefer that prepared
wake path over ad hoc direct prompts:

```bash
conveyor app-wakeup-plan "$TASK" --path "$LEDGER" --json
```

4. When the manager approves another pass, queue exactly one continuation or
   worker nudge with a narrow instruction and an iteration budget. Prefer loop
   continuation for Ralph-loop tasks:

```bash
RUN="loop-run-id-from-loop-status"
NEXT_ITERATION="2"
conveyor enqueue-continue-iteration "$TASK" \
  --loop-run "$RUN" \
  --requested-iteration "$NEXT_ITERATION" \
  --message "Manager approved one more pass. Before acting, print visible CONVEYOR sections, summarize the verified prior evidence, propose the next narrow slice, do the work only if in scope, then notify the manager with receipts." \
  --path "$LEDGER" \
  --json
conveyor dispatch --watch --watch-iterations 1 --interval 2 \
  --dispatcher-id dispatch-local \
  --path "$LEDGER" \
  --json
```

If the task is not a Ralph loop, use the existing setup's generated
`enqueue-nudge-worker` or manager-approved assignment command instead. Do not
invent new shipping authority.

When a role is stale and `app-wakeup-dispatch` emits `send_ready=true`, use the
`conveyor-app-wake-relay` skill to send the prepared wake prompt and record the
delivery receipt. Do not send ad hoc direct prompts.

5. After each worker pass, require all of:
   - durable worker-to-manager notification receipt;
   - one Dispatch receipt routing that notification;
   - manager verification of artifacts, tests, screenshots, dashboard records,
     or other task-specific evidence;
   - explicit manager decision: continue, revise, stop, or block.

6. Stop when the bounded pass count is exhausted, evidence is insufficient, the
   next proposed slice is out of scope, or the manager recommends stopping.
   Report a compact receipt with task, ledger, passes used, manager decision,
   evidence checked, blockers, and the exact next action.

## Final Receipt

End with:

- `task`
- `ledger`
- `passes_requested`
- `passes_completed`
- `manager_decision`
- `evidence_checked`
- `blockers`
- `next_action`
