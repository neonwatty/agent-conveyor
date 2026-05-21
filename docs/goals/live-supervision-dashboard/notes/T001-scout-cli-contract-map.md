# T001 Scout Receipt: CLI Contract Map

## Summary

The dashboard can be built as a TypeScript orchestration layer over existing `workerctl` JSON commands, but the cockpit Overview rail needs one missing stable aggregate: `workerctl telemetry snapshot --task <task> --json`.

## Existing JSON Surfaces

- `scripts/workerctl sessions [--role worker|manager] [--state active|gone|all]` prints JSON and is suitable for setup screens.
- `scripts/workerctl tasks --json [--active]` lists tasks; `tasks --create` prints creation JSON.
- `scripts/workerctl bind --task <task> --worker <worker> --manager <manager>` prints binding JSON.
- `scripts/workerctl manager-config <task> ...` prints manager config JSON.
- `scripts/workerctl criteria <task> --list` prints task criteria, summary counts, and affected rows for mutations.
- `scripts/workerctl cycle <task>` prints the manager cycle JSON, including state, staleness, pane signal, ingest, manager context, criteria context, and cycle id.
- `scripts/workerctl telemetry --task <task> --json`, `--summary --json`, and `--search ... --json` provide event timeline, counts, and FTS search.
- `scripts/workerctl commands --task <task> --json` provides durable command receipts.
- `scripts/workerctl replay <task> --json` provides chronological task reconstruction without raw transcript content unless explicitly requested.
- `scripts/workerctl audit <task> --json` redacts capture/transcript content by default.
- `scripts/workerctl reconcile --stale-cycles-seconds <n>` prints drift JSON.
- `scripts/workerctl export-task <task> --zip --include-transcripts` prints export location JSON and writes telemetry artifacts.
- `scripts/workerctl finish-task <task> ...` prints finish/stop receipt JSON.

## Dashboard Gaps

- No single task-scoped health snapshot exists for the cockpit Overview rail.
- `task_status_snapshot()` already returns task/worker/manager/config/handoff/integrity, but does not include latest cycle, criteria summary, telemetry summary, recent telemetry, commands, reconcile/drift, or alert list.
- `reconcile` is global; the dashboard can filter task-relevant drift after receiving the report.
- `telemetry` currently has flag-shaped behavior. Adding a `snapshot` sub-mode or flag must preserve existing timeline/search/summary behavior.
- Some setup commands (`sessions`, `bind`, `cycle`) do not expose `--path`, unlike many newer commands. This is acceptable for v1 dashboard against the default DB, but a later dashboard test mode may want path overrides.
- There is no `workerctl dashboard` command or Node/TypeScript package yet.

## Risks

- Avoid duplicating SQLite control-plane logic in TypeScript; keep dashboard backend on CLI JSON contracts for v1.
- Keep raw transcript/log content out of dashboard command receipts by default.
- Terminal bridge must be loopback-only and attach to tmux-backed sessions.
- Manager terminal may be unavailable if the registered manager is not tmux-backed; dashboard should still supervise through controls.

## Recommended First Slice

Implement `workerctl telemetry snapshot --task <task> --json` as the first Worker package. This unlocks the cockpit Overview rail, gives the TypeScript backend a stable contract, and is independently testable before any frontend work.

Suggested contents:

- `task`: task id/name/state/goal/summary/integrity
- `binding`: active worker/manager binding ids and states
- `worker` / `manager`: session names, role, tmux session/pane, pid/liveness where available
- `run`: active run summary if present
- `latest_cycle`: latest manager cycle state/status/notable pane pattern/ingest/new events/staleness
- `criteria`: summary and open accepted blockers
- `telemetry`: summary counts and recent redacted event summaries
- `commands`: recent command receipts and unfinished/failed counts
- `diagnostics`: task-relevant reconcile drift and schema health ok flag
- `alerts`: bounded list of operator-facing warnings

## Verification Candidates

- `python3 -m unittest tests.test_workerctl.CliTests.test_telemetry_snapshot_outputs_task_overview -v`
- `python3 -m unittest tests.test_workerctl.CliTests.test_telemetry_snapshot_reports_alerts -v`
- `/opt/homebrew/bin/python3.13 -m unittest discover -s tests -v`
- `git diff --check`
