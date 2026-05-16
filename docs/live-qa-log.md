# Live QA Log

## 2026-05-16: tmux-errors QA Pass

Scenario:

- `scripts/workerctl qa-plan tmux-errors`
- Non-destructive checks plus disposable mutating failure checks in isolated
  `WORKERCTL_STATE_ROOT` temp directories.

Validated:

- `doctor-self --json` remains parseable when unsupported from the current
  non-tmux Codex session.
- Missing-tmux simulation with `PATH=/usr/bin:/bin` keeps parseable JSON and
  includes an actionable `tmux_access` error.
- Active real sessions were empty before and after QA.
- Failed `session-nudge` against a disposable missing tmux target exits nonzero
  with clean stderr and does not record a misleading successful
  `session_nudged` audit event.
- `cycle` survives missing tmux pane capture and reports:
  - `pane_signal.captured: false`
  - `pane_signal.degraded: true`
  - a `tmux capture failed` reason
  - `worker_alive` / `manager_alive` based on registered process liveness
- `finish-task --stop-manager --stop-worker` fails cleanly when session identity
  verification sees the missing manager tmux session.
- `stop-task --reason ... --stop-worker` is accepted by argparse and reaches the
  same identity-verification failure path instead of failing as an unknown
  option.
- After killing disposable PIDs, `reconcile --stale-cycles-seconds 1` reports
  the dead pid sessions and `reconcile --apply` marks the disposable sessions
  gone and clears recovery state.

Resolved findings from the first tmux-errors run:

- Pane capture failures originally returned `degraded: false`; fixed in
  `ded46de` so attached-pane capture failures are degraded.
- `stop-task --reason` was originally rejected by argparse; fixed in `ded46de`
  and the reason is now recorded in command payloads, result payloads, and
  success events.

Final cleanup:

- `scripts/workerctl sessions --state active` returned `[]`.
- `tmux list-sessions` returned no sessions.
- `scripts/workerctl reconcile --stale-cycles-seconds 1` reported no dangling
  bindings, dead pid sessions, or stuck tasks.
- Git status was clean before starting the doc update.
