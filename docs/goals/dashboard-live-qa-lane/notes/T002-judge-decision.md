# T002 Judge Decision

## Decision

Approved.

## Worker Objective

Implement one reversible dashboard live QA vertical slice:

- add a typed dashboard `discover` command
- add `/api/discover` backed by existing `workerctl discover` JSON output
- add non-overlapping client polling for setup and snapshot data
- render stable, deduped live activity plus discovery results and suggestions
- let the operator bind from a suggestion only through an explicit button that reuses the existing bind action
- preserve current terminal attach behavior

## Allowed Files

- `dashboard/client/main.tsx`
- `dashboard/client/styles.css`
- `dashboard/server/index.ts`
- `dashboard/server/workerctl.ts`
- `dashboard/server/workerctl.test.ts`
- `docs/goals/dashboard-live-qa-lane/state.yaml`
- `docs/goals/dashboard-live-qa-lane/notes/`

## Verification

- `npm test -- --runInBand`
- `npm run build`
- `/opt/homebrew/bin/python3.13 -m unittest tests.test_workerctl.RegisterCommandsTests tests.test_workerctl.CliTests -v`
- `git diff --check`
- Playwright/manual dashboard verification against a local dashboard server covering polling, discovery, explicit bind-from-suggestion, live activity update, and unchanged worker/manager terminal attach

## Stop Conditions

- Need files outside allowed files, especially Python workerctl source files or terminal attach internals.
- Discovery output lacks enough stable JSON shape for a dashboard contract without a product/API decision.
- Any bind can happen without an explicit user click.
- Polling causes overlapping requests, visible row jumpiness, or exposes raw transcript/log-like content by default.
- Terminal attach behavior regresses or requires redesign.
