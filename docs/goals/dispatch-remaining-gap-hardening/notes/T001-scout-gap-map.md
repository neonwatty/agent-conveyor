# T001 Scout Gap Map

## Gap Classification

1. Duplicate-route suppression lacks true concurrent multi-dispatcher coverage.
   - Classification: hardening.
   - Current evidence: `tests/test_workerctl.py:1325` mocks `insert_routed_notification` raising a unique-constraint error; it does not run two dispatchers against the same database event.
   - Likely fix surface: `tests/test_workerctl.py`, possibly `workerctl/commands.py` only if real concurrency exposes a behavior bug.

2. Notification-only correlation to next manager cycle/decision is heuristic.
   - Classification: hardening or acceptable asymmetry pending Judge decision.
   - Current evidence: `_build_correlation_chains` attaches commandless notifications to `_next_manager_cycle_for_notification` at `workerctl/db.py:1413`; tests assert happy path at `tests/test_workerctl.py:1230`.
   - Risk: a stronger deterministic rule may not exist with current data. Forcing a link could be less truthful than leaving cycle/decision null unless correlation data is explicit.

3. Suppressed signal dashboard visibility depends on recent telemetry snapshot limits.
   - Classification: bug/hardening.
   - Current evidence: `dispatchHealth` counts `dispatch_signal_suppressed` only from `snapshot.telemetry.recent` at `dashboard/server/index.ts:291`; snapshot call uses `limit: 25` at `dashboard/server/index.ts:380`.
   - Likely fix surface: `dashboard/server/index.ts`, `dashboard/server/workerctl.test.ts`, possibly `workerctl/db.py` if audit should expose a durable summary.

4. `finish_command_attempt` updates command/telemetry even if no running attempt row changed.
   - Classification: bug.
   - Current evidence: update at `workerctl/db.py:1722` ignores rowcount; subsequent select at `workerctl/db.py:1739` reads the attempt regardless of whether it was still running, then command state is overwritten at `workerctl/db.py:1758`.
   - Likely fix surface: `workerctl/db.py`, `tests/test_workerctl.py`.

5. Dispatch holds a SQLite write transaction across tmux side effects.
   - Classification: hardening.
   - Current evidence: `_dispatch_once_pass` opens one connection/transaction at `workerctl/commands.py:4439`, claims at `workerctl/commands.py:4471`, then calls `_execute_dispatch_command`; tmux send happens inside `_execute_dispatch_command` at `workerctl/commands.py:4370`, before the outer commit at `workerctl/commands.py:4648`.
   - Risk: moving send outside the claim transaction must preserve no double-send. A safe design is claim+commit, validate/record pre-send state in a short transaction, run tmux send, then finish in a new transaction.

6. `required_permission` is optional/free-form.
   - Classification: policy hardening.
   - Current evidence: enqueue CLI accepts optional `--required-permission` at `workerctl/cli.py:262`; execution only checks when set at `workerctl/commands.py:4276`; tests cover deny/allow when set at `tests/test_workerctl.py:1510` and `tests/test_workerctl.py:1561`.
   - Risk: making it mandatory may break existing commands. Safer first step: validate format/taxonomy when provided, expose warnings/failures for unknown permission format, and have Judge decide whether command types should default to specific permissions.

7. Worker completion routing is not represented as `command_attempt`.
   - Classification: acceptable asymmetry or follow-up pending Judge decision.
   - Current evidence: command attempts are only for queued command rows; worker completions insert `routed_notifications` directly at `workerctl/commands.py:4547` and are represented as commandless correlation chains at `workerctl/db.py:1413`.
   - Risk: fabricating command_attempts for non-command events may reduce audit truthfulness. Prefer documenting commandless chain semantics unless a real operator workflow needs uniformity.

8. Ack gating checks latest ack presence but not schema/config/binding revision.
   - Classification: follow-up/hardening.
   - Current evidence: cycle gate checks presence only at `workerctl/supervise_cycle.py:348`; ack storage/revision exists in `workerctl/db.py:3547`.
   - Likely fix surface if chosen: `workerctl/db.py`, `workerctl/supervise_cycle.py`, tests. Needs product decision about what revision acks should bind to.

9. `dashboard --task` may be parsed but ignored by observation path.
   - Classification: bug.
   - Current evidence: CLI parses and passes `--task` through `workerctl/commands.py:99`; server parses it at `dashboard/server/index.ts:455`; `dashboardObservation` ignores `options.task` and derives `taskName` only from dashboard binding at `dashboard/server/index.ts:374`.
   - Likely fix surface: `dashboard/server/index.ts`, `dashboard/server/workerctl.test.ts`.

10. Dispatch heartbeat UI omits existing fields.
   - Classification: small UI bug.
   - Current evidence: server already returns `dry_run`, `iteration`, `processed_count` at `dashboard/server/index.ts:208`; client renders only timestamp and dispatcher at `dashboard/client/main.tsx:157`.
   - Likely fix surface: `dashboard/client/main.tsx`, maybe CSS/tests.

11. Generic manual QA docs omit dispatch checks.
   - Classification: docs/ops gap.
   - Current evidence: `docs/manual-qa-checklist.md` has no dispatch checklist, while `workerctl qa-plan dispatch-completion` exists around `workerctl/commands.py:1403`.
   - Likely fix surface: `docs/manual-qa-checklist.md`, maybe README.

## Recommended First Worker Slice

Backend correctness first:

- make `finish_command_attempt` verify it transitioned a running attempt before mutating the command or emitting telemetry;
- add focused regression tests for double-finish/stale finish behavior;
- split dispatch command execution so command claim is committed before tmux send and finalization happens after send in a fresh short transaction;
- add a real two-connection/thread/process concurrency test for duplicate worker completion suppression and/or atomic command claim behavior;
- validate provided `required_permission` strings against known permission taxonomy/format, but do not make permissions mandatory unless Judge approves a migration-compatible default.

Recommended allowed files:

- `workerctl/db.py`
- `workerctl/commands.py`
- `workerctl/cli.py`
- `workerctl/tmux.py`
- `tests/test_workerctl.py`
- `docs/goals/dispatch-remaining-gap-hardening/state.yaml`

Recommended verify:

- `python3 -m unittest tests.test_workerctl.DispatchTests -v`
- `python3 -m unittest tests.test_workerctl.DatabaseTests -v`
- `python3 -m unittest tests.test_workerctl.CliTests -v`
- `python3 -m py_compile workerctl/*.py`
- `git diff --check`

Stop if moving tmux send outside the transaction permits duplicate sends, permission validation would break documented existing commands without compatibility, or the concurrency test is flaky rather than deterministic.
