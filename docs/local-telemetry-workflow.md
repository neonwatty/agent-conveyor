# Local Telemetry Workflow

This workflow is local-only. It uses the SQLite database behind `workerctl`; it does not send telemetry to a service.

## Inspect A Run

Use the run id from `workerctl runs --list`, `workerctl runs --show`, or the `workerctl pair` output.

```bash
scripts/workerctl telemetry --summary --run <run_id>
scripts/workerctl telemetry --run <run_id>
scripts/workerctl telemetry --search manager --run <run_id>
```

## Inspect A Task For Dashboard Supervision

Use the task-scoped snapshot when you need the same aggregate state the local dashboard cockpit consumes:

```bash
scripts/workerctl telemetry snapshot --task <task> --json
```

The snapshot includes task, binding, worker/manager session, active run, latest cycle, acceptance criteria, recent telemetry, recent command receipts, diagnostics, and alert summaries. It does not include raw transcript content.

## Launch The Local Dashboard

The dashboard is a loopback-only supervision cockpit for a single task:

```bash
scripts/workerctl dashboard --task <task>
```

For repeatable QA or scripted checks, inspect the launch command without starting the server:

```bash
scripts/workerctl dashboard --task <task> --dry-run --json
```

The TypeScript backend shells out to `workerctl` JSON commands for task state and attaches interactive terminal panes to registered tmux sessions with a WebSocket PTY bridge. The cockpit includes bind setup and action receipts for cycle, nudge, interrupt, finish, and export, without returning raw transcript content in diagnostics JSON by default.

Use `--json` when saving durable evidence:

```bash
scripts/workerctl telemetry --summary --run <run_id> --json > telemetry-summary.json
scripts/workerctl telemetry --run <run_id> --json > telemetry-events.json
scripts/workerctl telemetry --search manager --run <run_id> --json > telemetry-manager-search.json
```

## Export Evidence

The task export includes telemetry artifacts by default:

```bash
scripts/workerctl export-task <task> --zip --include-transcripts
```

The export bundle writes:

- `telemetry-events.json`: structured telemetry events for the task
- `telemetry-summary.json`: counts by actor, event type, and severity
- `telemetry-report.md`: readable event-type summary and timeline

Keep `replay.json`, `mutation-audit.json`, `manager-decisions.json`, and the telemetry files together when reviewing a run. Replay explains task chronology; telemetry exposes structured control-point receipts, correlation ids, and error/status counts.

## Realistic Drill Checklist

For a manager/worker drill, capture these command outputs under the drill artifact directory:

```bash
scripts/workerctl telemetry --summary --run <run_id>
scripts/workerctl telemetry --run <run_id>
scripts/workerctl telemetry --search manager --run <run_id>
scripts/workerctl export-task <task> --zip --include-transcripts
scripts/workerctl sessions --state active
scripts/workerctl reconcile --stale-cycles-seconds 1
```

The drill is not complete until telemetry can reconstruct the run identity, manager cycles, decisions, commands, captures, handoffs, criteria changes, task finish, run finish, and any errors without reading raw Codex logs.
