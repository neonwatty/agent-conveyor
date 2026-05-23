# T001 Scout Map

## Current Command Surface

- `workerctl/db.py`
  - `commands` currently has `id`, `idempotency_key`, timestamps, optional task/worker/manager ids, `type`, `state`, `payload_json`, `result_json`, and `error`.
  - Command state is limited to `pending | attempted | succeeded | failed`.
  - `create_command`, `mark_command_attempted`, and `finish_command` mutate the row directly and emit generic `workerctl` telemetry.
  - There is no `correlation_id`, claim/lease fields, attempt count, dispatcher id, `command_attempts`, stale claim model, or atomic claim helper.
  - `task_audit` reads command rows but not command attempts.
  - `db-doctor live` already reports unfinished `pending` / `attempted` commands, so claim/stale metadata can extend that surface.

## Current Dispatch Surface

- `workerctl/cli.py`
  - `dispatch` accepts `--once`, `--watch`, `--limit`, `--dispatcher-id`, `--type`, `--dry-run`, `--json`, and `--path`.
  - `--type` is currently limited to `notify_manager` and `worker_task_complete`.
  - There is no `--interval` or bounded test-only watch iteration flag.
- `workerctl/commands.py`
  - `command_dispatch` rejects `--watch`.
  - It only routes unrouted bound worker `codex_events.subtype == task_complete` signals.
  - It records `routed_notifications` and dispatch telemetry, then sends the manager notification through `tmux.send_text_to_session`.
  - It does not inspect or claim `commands` rows.

## Existing Routing/Telemetry Surface

- `routed_notifications` already has `correlation_id`, optional `command_id`, delivery state, target/source session ids, and payload/error fields.
- `telemetry_events` already accepts actor `dispatch` and can carry arbitrary correlation/attributes JSON.
- Good event names already exist for signal routing: `dispatch_signal_detected`, `dispatch_signal_routed`, `dispatch_signal_failed`.
- New command events should use `dispatch_command_claimed`, `dispatch_command_attempted`, `dispatch_command_succeeded`, `dispatch_command_failed`, and `dispatch_command_abandoned`.

## Tmux and Side-Effect Surface

- `workerctl/tmux.py::send_text_to_session` resolves a registered session row, builds a tmux target, sets a tmux buffer, pastes it, sends Enter, deletes the buffer, and returns session/target/text/time metadata.
- Once `set-buffer`/`paste-buffer` begins, idempotency is ambiguous. Dispatch attempts need explicit `side_effect_started` and `side_effect_completed` metadata before retries are considered.
- Initial Worker slice should avoid tmux side effects and prove claim/attempt correctness first.

## Replay/Audit Surface

- `workerctl/replay.py` renders `commands`, manager decisions, acks, continuations, reviews, epilogues, cycles, captures, and transcript segments.
- It does not render command attempts or grouped correlation chains.
- `workerctl/audit.py` mutation audit links mutating command types to manager decisions; new dispatch command attempt details should not imply Dispatch made a manager decision.

## Dashboard Surface

- `dashboard/server/index.ts` builds the observation rail from `discover` and `telemetry snapshot`.
- `dashboard/server/workerctl.ts` does not expose a `dispatch` command or command/attempt list yet.
- `dashboard/client/main.tsx` renders timeline items from telemetry snapshot.
- `dashboard/client/styles.css` is currently dirty before this goal and must not be touched until the user resolves or explicitly includes it.
- Dashboard work should come after DB/replay semantics are stable.

## Existing Test Anchors

- `tests/test_workerctl.py::DispatchTests` covers Phase 1 completion routing, dedupe, dry-run, and unbound event suppression.
- `CliTests.test_commands_cli_lists_durable_commands` and `test_commands_cli_filters_by_type_and_state` cover command listing.
- Database tests cover command lifecycle (`create_command`, `mark_command_attempted`, `finish_command`).
- Session tmux tests cover `send_text_to_session`, dry-run, missing session, and permission errors.
- Mutation audit tests cover mutating command decision linkage.

## Compatibility Risks

- Existing direct `session-nudge`, `session-interrupt`, `request-worker-compact`, and lifecycle commands use `create_command` / `mark_command_attempted` / `finish_command` directly. New claim/attempt helpers must not force these paths through Dispatch yet.
- Adding columns to `commands` must be additive and preserve old rows.
- If `commands.state` gains new values like `claimed`, many filters/tests must change. Prefer keeping existing states for compatibility and placing lease/attempt state in additive columns/table.
- `commands` has no `correlation_id`; add it from now on while accepting old null rows.

## Recommended First Worker Package

Objective:

Implement additive command queue foundations: `commands.correlation_id`, claim/lease columns or equivalent, `command_attempts`, atomic claim helper, attempt start/finish helpers, and a no-side-effect `dispatch --once --type notify_manager --dry-run/--json` command-claim path that proves claim semantics without tmux sends.

Allowed files:

- `workerctl/db.py`
- `workerctl/commands.py`
- `workerctl/cli.py`
- `workerctl/replay.py`
- `tests/test_workerctl.py`
- `docs/goals/dispatch-command-queue-watch/state.yaml`

Verify:

- `python3 -m unittest tests.test_workerctl -v`
- `python3 -m py_compile workerctl/*.py`

Stop if:

- Atomic claim cannot be implemented additively.
- Existing direct command lifecycle tests require destructive state changes.
- Tmux side effects become necessary before claim/attempt tests pass.
- Need files outside allowed files.
