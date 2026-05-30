# T002 Judge Decision

## Result

Approved. Implement one vertical guardrail slice: durable Ralph-loop run state, first-class `continue_iteration` command, dispatcher pre-delivery max-iteration refusal, operator evidence surfaces, and browser QA for the refusal.

## Scope Decision

The slice must enforce only the explicit numeric policy `current_iteration >= max_iterations`. It must not add dispatcher authority over task success, PR quality, CI interpretation, merge readiness, or whether additional work is strategically useful.

The first implementation should defer broader stop conditions such as missing CI-green evidence, merge proof, handoff proof, cleanup completion, budget limits, and operator override. Those can reuse the same policy gate later after this max-iteration path is proven.

## Worker Objective

Implement dispatcher-enforced max-iteration blocking for Ralph-loop continuation commands:

1. Persist a Ralph-loop run or equivalent durable policy record with task id, max iterations, current iteration, cleanup policy, stop conditions, and seed/run identity.
2. Represent manager continuation as a durable `continue_iteration` command linked by correlation id and optional manager decision id.
3. Route `continue_iteration` manager -> worker through the existing dispatch path.
4. Before inserting a worker routed notification, block the command if `current_iteration >= max_iterations`.
5. Record a machine-readable refusal with:
   - `state: blocked` in the result payload
   - command/attempt DB state compatible with existing schema
   - `reason: max_iterations_reached`
   - `delivered: false`
   - `target_worker_notified: false`
   - current/max/requested iteration
   - run id, command id, manager decision id when present, correlation id
6. Expose blocked details in command output, audit/replay, and dashboard dispatch chain data.

## Allowed Files

- `workerctl/db.py`
- `workerctl/cli.py`
- `workerctl/commands.py`
- `workerctl/replay.py`
- `dashboard/server/index.ts`
- `dashboard/client/main.tsx`
- `dashboard/server/workerctl.test.ts`
- `tests/test_workerctl.py`
- `docs/qa/ralph-loop.md`
- `docs/manual-qa-checklist.md`
- `docs/goals/ralph-loop-dispatch-guardrails/notes/**`
- `docs/goals/ralph-loop-dispatch-guardrails/state.yaml`

## Required Red Tests

1. No-tmux blocked continuation:
   - setup bound task with worker `tmux_session = null`
   - create run `max_iterations=1`, `current_iteration=1`
   - enqueue `continue_iteration` requesting iteration 2
   - run `dispatch --once --type continue_iteration --json`
   - assert processed result is blocked with reason/current/max/requested
   - assert no routed notifications, empty worker inbox, no tmux send, and attempt side effects are false

2. Tmux blocked continuation:
   - setup bound task with normal worker tmux session
   - same run and command
   - assert no routed notifications, no side-effect start, and no tmux send

3. Allowed continuation:
   - run has `max_iterations=1`, `current_iteration=0`
   - no-tmux worker receives a `pull_required` inbox notification
   - notification signal/type identify `continue_iteration`
   - existing non-loop `nudge_worker` behavior is unchanged

4. Replay/audit evidence:
   - blocked command attempt appears with reason/current/max/requested
   - blocked command correlation and manager decision linkage are visible
   - no worker-directed routed notification exists for the blocked command

5. Dashboard/browser support:
   - server chain entry exposes blocked reason and current/max/requested iteration
   - chain notification count is zero
   - inbox summary pending and pull-required counts remain zero

## Browser QA Scenario

Use a disposable local DB/dashboard fixture:

1. Create task binding with manager and no-tmux worker.
2. Create Ralph-loop run `max_iterations=1`, `current_iteration=1`.
3. Create manager decision requesting `requested_iteration=2`.
4. Enqueue `continue_iteration` command with correlation id `ralph-loop-max-block`.
5. Run dispatch once.
6. Open the dashboard in the browser against that DB/task.

Measurable browser assertions:

- Dispatch panel contains `continue_iteration`.
- Dispatch panel contains `max_iterations_reached`.
- Dispatch panel contains either `1/1` or both `current_iteration=1` and `max_iterations=1`.
- Dispatch chain shows `0 notifications`.
- `Inbox` chip is `0`.
- `Pull inbox` chip is `0`.
- A manager-visible refusal receipt is present in the chain text, replay/audit evidence, or command output captured by the QA receipt.

## Verification Commands

- `python3 -m unittest tests.test_workerctl.DispatchTests -v`
- `python3 -m unittest tests.test_workerctl -v`
- `npm test`
- `npm run build`
- Browser or Playwright walkthrough against a local dashboard fixture
- `git diff --check`

## Stop Conditions

Stop and return to Judge if:

- the implementation requires Dispatch to decide task success, CI/PR quality, merge readiness, or whether more work is useful
- the refusal cannot happen before both routed-notification creation and tmux send
- there is no reliable negative proof that the worker did not receive the blocked continuation
- durable loop state requires files outside the allowed list
- the same unknown verification failure repeats twice
