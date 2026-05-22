# T003 Worker Receipt

## Result

Done.

## Summary

Implemented the approved dashboard live QA vertical slice.

## Changes

- Added a typed dashboard `discover` workerctl command mapping.
- Added `/api/discover` backed by existing `workerctl discover` JSON output.
- Made `/api/sessions` work with dashboard `--db-path` by deriving sessions from `discover` when a DB override is active.
- Added non-overlapping client polling for setup and snapshot data.
- Added live refresh status with last refresh/error state.
- Stabilized and deduped activity item keys.
- Added a Connection panel showing task, binding, worker, manager, and latest cycle state.
- Added Discovery UI with task/session results, registration prompts, and explicit bind-from-suggestion button.
- Preserved existing xterm.js/PTy terminal attach behavior and fixed the server upgrade handler so non-PTY WebSocket upgrades are not destroyed.
- Attached Vite HMR to the dashboard HTTP server to avoid HMR port collisions during local QA.

## Verification

- `npm test -- --runInBand` passed.
- `npm run build` passed.
- `/opt/homebrew/bin/python3.13 -m unittest tests.test_workerctl.RegisterCommandsTests tests.test_workerctl.CliTests -v` passed.
- `git diff --check` passed.
- Playwright against disposable DB verified:
  - discovery renders task/session options
  - explicit bind suggestion button appears
  - clicking bind activates the connection
  - live refresh status updates without manual refresh
  - cycle activity appears in the Live activity rail
  - no browser console/page errors
- Playwright against real tmux-backed dummy sessions verified:
  - bind suggestion appears
  - both terminal panels report `Attached`
  - Connection panel shows binding active, worker attached, manager attached
  - live refresh remains healthy
  - no browser console/page errors

## Files Changed

- `dashboard/client/main.tsx`
- `dashboard/client/styles.css`
- `dashboard/server/index.ts`
- `dashboard/server/workerctl.ts`
- `dashboard/server/workerctl.test.ts`
- `docs/goals/dashboard-live-qa-lane/state.yaml`
- `docs/goals/dashboard-live-qa-lane/notes/T001-scout-map.md`
- `docs/goals/dashboard-live-qa-lane/notes/T002-judge-decision.md`
- `docs/goals/dashboard-live-qa-lane/notes/T003-worker-receipt.md`
