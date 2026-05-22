# T001 Scout Map

## Result

Done.

## Summary

Mapped the current dashboard and workerctl surfaces. The dashboard already shells out through TypeScript endpoints for tasks, sessions, telemetry snapshot, bind, cycle, nudge, interrupt, finish, and export. It also preserves WebSocket tmux PTY attach for the worker/manager terminal panes.

The live QA gaps are:

- client polling for snapshot/setup refresh
- dashboard `/api/discover` endpoint and TypeScript command wiring
- discovery result and suggestion rendering
- explicit bind-from-suggestion action
- verification around the new dashboard command surface

## Evidence

- `dashboard/client/main.tsx`: `loadSetup()` loads `/api/tasks` and `/api/sessions` once; `refresh()` loads `/api/snapshot` on mount, manual refresh, create-task success, or post-action reload.
- `dashboard/client/main.tsx`: `buildActivity()` merges local action receipts, `snapshot.telemetry.recent`, and `snapshot.commands.recent`, but has no polling/live behavior.
- `dashboard/client/main.tsx`: `TerminalPane` connects to `/pty?session=<tmux_session>` and forwards xterm.js input/resize control messages.
- `dashboard/server/index.ts`: existing REST endpoints cover config, tasks, sessions, snapshot, and action endpoints; no discovery endpoint exists.
- `dashboard/server/index.ts`: PTY upgrade path validates the endpoint, uses `buildPtyAttachArgs()`, disables tmux status, attaches through node-pty `tmux attach`, and falls back to `script`.
- `dashboard/server/workerctl.ts`: `DashboardCommand` does not include `discover` or `search`.
- `workerctl/commands.py`: `telemetry_snapshot()` returns task, binding, worker, manager, latest cycle, criteria, commands, diagnostics, alerts, telemetry, and run data.
- `workerctl/commands.py`: `command_discover()` returns JSON with `query`, `tasks`, `sessions`, `bindings`, `telemetry`, and `suggestions`.
- `workerctl/cli.py`: `discover` has alias `search` and supports optional query, `--all`, `--limit`, and `--path`.

## Recommended Worker Package

Implement one vertical slice:

- add a typed dashboard `discover` command and `/api/discover` endpoint
- poll snapshot and setup lists on an interval with cleanup and no overlapping requests
- stabilize/dedupe live activity rows
- render discovery results and suggestions
- allow binding from a suggestion only through an explicit button that calls the existing bind action

## Recommended Verification

- `npm test -- --runInBand`
- `npm run build`
- `/opt/homebrew/bin/python3.13 -m unittest tests.test_workerctl.RegisterCommandsTests tests.test_workerctl.CliTests -v`
- `git diff --check`
- Playwright/manual dashboard verification against a local dashboard server
