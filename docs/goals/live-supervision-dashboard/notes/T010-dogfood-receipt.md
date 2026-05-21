# T010 Dogfood Receipt

Date: 2026-05-21

## Disposable task

- Task: `dashboard-dogfood-final2-20260521`
- Worker: `dashboard-dogfood-final2-worker`
- Manager: `dashboard-dogfood-final2-manager`
- Rollout files: `.codex-workers/dashboard-dogfood-final2-20260521/worker-rollout.jsonl`, `.codex-workers/dashboard-dogfood-final2-20260521/manager-rollout.jsonl`

## Evidence

- Dashboard URL: `http://127.0.0.1:8797/?task=dashboard-dogfood-final2-20260521`
- Screenshot: `/tmp/workerctl-dashboard-dogfood.png`
- Pre-finish snapshot: `/tmp/dashboard-dogfood-final2-snapshot-before.json`
- Post-finish snapshot: `/tmp/dashboard-dogfood-final2-snapshot-after.json`
- Playwright dogfood script: `docs/live-qa-artifacts/dashboard-dogfood.spec.js`

## Walkthrough result

The dashboard loaded a selected disposable task with worker and manager terminals side by side. Both terminals attached to tmux through the xterm.js PTY bridge and rendered live shell content. The diagnostics rail showed no alerts, telemetry counts, attach/bind selectors, and action controls.

The Playwright dogfood exercised:

- task load for `dashboard-dogfood-final2-20260521`
- worker and manager terminal attach assertions
- `cycle dashboard-dogfood-final2-20260521`
- `session-nudge dashboard-dogfood-final2-worker`
- `export-task dashboard-dogfood-final2-20260521 --zip`
- `finish-task dashboard-dogfood-final2-20260521 --require-criteria-audit`

The post-finish telemetry snapshot showed:

- task state: `done`
- alerts: none
- active binding: none
- failed commands: 0
- unfinished commands: 0
- criteria: 1 satisfied, 0 accepted open
- diagnostics: no dangling bindings, no dead PID sessions, schema ok, no stuck tasks
- telemetry total: 14 events

## Cleanup

The disposable tmux sessions and the earlier polluted dogfood sessions were stopped and deregistered. A final `scripts/workerctl reconcile` reported no dangling bindings, no dead PID sessions, schema health ok, and no stuck tasks.

## Commands

- `scripts/workerctl dashboard --task dashboard-dogfood-final2-20260521 --dry-run --json`
- `npx playwright test docs/live-qa-artifacts/dashboard-dogfood.spec.js --reporter=line`
- `scripts/workerctl telemetry snapshot --task dashboard-dogfood-final2-20260521 --json`
- `scripts/workerctl reconcile`
