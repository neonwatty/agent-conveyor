# T001 Scout Map

## Current Surfaces

- Ralph-loop QA contract: `docs/qa/ralph-loop.md` describes the manager-worker loop, seed prompt reuse, PR/CI/merge/clear receipts, and a stop condition after max iterations. It currently documents the behavior but does not define a durable loop policy object or a dispatcher-side enforcement gate.
- QA plan generator: `workerctl/commands.py:1454` emits the `ralph-loop` QA plan. The current plan expects two normal iterations and includes dispatch correlation ids such as `ralph-iter-1-pr`, `ralph-iter-1-clear`, and `ralph-iter-2-replay`, but it does not include a negative max-iteration case.
- Durable command queue: `workerctl/db.py:1556` creates generic commands with arbitrary payload, task/worker/manager ids, correlation id, required permission, and manager-decision linkage. This is the right place to represent a manager continuation request as durable data.
- Dispatch route and delivery: `workerctl/commands.py:4517` routes `notify_manager` to manager and `nudge_worker` to worker. `workerctl/commands.py:4575` resolves `push` versus `pull_required` from the target session's tmux presence, so tmux and Codex-app inbox delivery already share one dispatcher path.
- Pre-delivery execution gate: `workerctl/commands.py:4582` validates command text, resolves route, checks permission, resolves delivery mode, and only then calls `worker_db.insert_routed_notification` at `workerctl/commands.py:4612`. A max-iteration check inserted between delivery-mode resolution and notification insertion would block before both worker inbox creation and tmux send.
- Pull-required inbox path: `workerctl/commands.py:4648` marks no-tmux worker delivery as `pull_required`, records a delivered routed notification, and finishes the command as succeeded without calling tmux.
- Tmux push path: `workerctl/commands.py:4696` marks the attempt side effect started and commits before calling `worker_tmux.send_text_to_session` at `workerctl/commands.py:4702`.
- Failure-before-delivery behavior: `workerctl/commands.py:4733` finishes failed attempts and, if no notification was inserted, leaves `routed_notifications` empty and `side_effect_started=false`. Existing test coverage proves this at `tests/test_workerctl.py:2579`.
- Existing no-tmux proof template: `tests/test_workerctl.py:2381` proves a no-tmux worker receives a `pull_required` inbox item and tmux is not called. This is the best template for an allowed Codex-app worker continuation path and the negative blocked path.
- Existing send-order proof template: `tests/test_workerctl.py:2428` proves tmux send only happens after claim/commit. A blocked tmux continuation should prove the inverse: no side-effect start, no send call, no notification.
- Replay evidence: `workerctl/replay.py:179` emits command attempts. `workerctl/replay.py:203` emits routed notifications. A blocked continuation should appear as a command attempt with blocked details and no worker routed notification.
- Dashboard server evidence: `dashboard/server/index.ts:454` builds dispatch chains from commands, command attempts, and routed notifications. `dashboard/server/index.ts:506` summarizes inbox pending/consumed counts from delivered notifications.
- Dashboard client evidence: `dashboard/client/main.tsx:203` renders dispatch health, inbox counts, chains, errors, attempts, and notification counts. A blocked continuation can be browser-visible if the attempt error/result carries `max_iterations_reached` and the chain has zero notifications.

## Gaps

- No first-class `continue_iteration` command type exists. Worker-directed continuation currently has to look like a generic `nudge_worker`.
- No durable Ralph-loop policy or run state exists for `max_iterations`, `current_iteration`, cleanup mode, or stop conditions.
- No dispatcher validator prevents a manager-requested continuation after `current_iteration >= max_iterations`.
- No blocked/refused attempt shape exists beyond `state=failed`; `finish_command_attempt` currently allows only `succeeded`, `failed`, and `abandoned` at `workerctl/db.py:1829`.
- Dashboard chains currently expose attempt `error` but not structured attempt `result_json`, so current/max iteration evidence needs either an enriched error string or dashboard support for blocked-result details.
- Replay command-attempt entries currently omit attempt `error` and `result_json`, so refusal evidence is weaker than it should be.
- No automated browser QA proves the negative case: no worker inbox item and no tmux send when a manager asks for one more iteration past the preset maximum.

## Candidate Data Model Or Reuse Path

Recommended smallest coherent model:

- Add a small durable Ralph-loop run record with `run_id`, `task_id`, `name`, `max_iterations`, `current_iteration`, `cleanup_policy`, optional stop-condition JSON, and state.
- Add or reuse a manager decision payload that references the run and requested next iteration.
- Add a first-class `continue_iteration` command type routed manager -> worker like `nudge_worker`.
- Keep command-attempt DB state as `failed` for compatibility, but set `result_json.state = "blocked"` and `result_json.reason = "max_iterations_reached"` when the dispatcher refuses the continuation mechanically.

This avoids making Dispatch decide PR quality or task success. Dispatch only evaluates explicit numeric policy stored with the loop run.

## Dispatch Interception Point

Insert the policy check in `_execute_dispatch_command` after:

1. `_dispatch_command_text(command)`
2. `_dispatch_command_route(conn, command)`
3. `_dispatch_required_permission_check(...)`
4. `_dispatch_delivery_mode(...)`

and before `worker_db.insert_routed_notification(...)`.

Required blocked result:

- command attempt finishes with DB state `failed` and result state `blocked`
- `reason = "max_iterations_reached"`
- includes `run_id`, `current_iteration`, `max_iterations`, `requested_iteration`
- `side_effect_started = false`
- `side_effect_completed = false`
- no `routed_notifications` row for the worker
- no tmux send attempt
- manager-visible receipt exists through command output, audit/replay, and dashboard chain

## Browser QA Path

Create a local dashboard fixture or disposable DB with:

- task binding containing manager and worker
- Ralph-loop run with `max_iterations=1` and `current_iteration=1`
- manager decision requesting `requested_iteration=2`
- durable `continue_iteration` command with correlation id such as `ralph-loop-max-block`
- dispatch run processes the command

Browser assertions:

- Dispatch panel shows a chain for `continue_iteration`
- blocked reason text includes `max_iterations_reached`
- visible details include `current_iteration=1` and `max_iterations=1` or equivalent `1/1`
- the chain shows `0 notifications`
- Dispatch inbox chip remains `0`
- Pull inbox chip remains `0`
- manager-visible refusal receipt is visible in the chain, replay/audit view, or command output captured by the test

## Recommended Red Tests

1. Backend blocked no-tmux worker:
   - create `max_iterations=1`, `current_iteration=1`
   - enqueue `continue_iteration` to a worker with no tmux session
   - run dispatch once
   - assert processed result is blocked with reason/current/max/requested
   - assert command attempt has `side_effect_started=0`
   - assert no routed notifications and worker inbox is empty
   - assert tmux send not called

2. Backend blocked tmux worker:
   - same loop state with worker tmux present
   - run dispatch once
   - assert no side-effect start and no send call
   - assert no routed notifications

3. Backend allowed path:
   - create `max_iterations=1`, `current_iteration=0`
   - enqueue `continue_iteration`
   - for no-tmux worker assert `pull_required` notification and worker inbox payload
   - for tmux worker assert normal push behavior remains unchanged

4. Replay/audit:
   - blocked attempt appears with manager decision/correlation and structured reason
   - no routed notification exists for the blocked worker delivery

5. Dashboard/browser:
   - server test proves `dispatchChainEntries` exposes blocked reason/current/max and zero notifications
   - browser or Playwright walkthrough proves the visible Dispatch panel assertions above
