# Manual QA Checklist

Run this after unit tests and `scripts/live-smoke-repeat 3` pass.

## Run Metadata

- Date:
- Operator:
- Task:
- Worker:
- Manager:
- Evidence bundle:
- Result: pending

## Checklist

- [ ] `scripts/workerctl doctor` reports `ok: true`.
- [ ] `scripts/workerctl db-doctor` reports schema health ok.
- [ ] `scripts/workerctl pair --task <task> --worker-name <worker> --manager-name <manager> --task-goal "<goal>" --cwd "$PWD" --codex-profile yolo --manager-mode strict --manager-objective "<objective>" --manager-acceptance "<criterion>"` creates worker and manager with seeded manager config.
- [ ] `scripts/workerctl cycle <task>` reports pane signal and manager context.
- [ ] `scripts/workerctl session-nudge <worker> "dry-run status request" --dry-run` resolves the target.
- [ ] `scripts/workerctl session-nudge <worker> "..."` sends text to the correct pane in a disposable run.
- [ ] `scripts/workerctl criteria <task> --add --criterion "<criterion>" --source manager_inferred --status accepted` records an accepted criterion.
- [ ] `scripts/workerctl criteria <task> --list` shows the accepted criterion.
- [ ] `scripts/workerctl criteria <task> --satisfy <criterion-id> --evidence-json '{"command":"manual QA","status":"pass"}'` records satisfaction evidence.
- [ ] `scripts/workerctl finish-task <task> --require-criteria-audit` blocks when accepted criteria remain open.
- [ ] `scripts/workerctl finish-task <task> --capture-transcript-before-stop --require-transcript-segment --stop-manager --stop-worker` captures non-empty transcript segments and stops both sessions.
- [ ] `scripts/workerctl transcript-show <task> --json` returns captured transcript metadata with segment text redacted.
- [ ] `scripts/workerctl replay <task> --json` includes cycle, criteria, and finish evidence.
- [ ] `scripts/workerctl replay <task> --json --format full-transcript` fails unless `--include-content` is passed.
- [ ] `scripts/workerctl replay <task> --json --format full-transcript --include-content > /tmp/workerctl-full-transcript.json` includes transcript segment evidence without dumping it into the active Codex terminal.
- [ ] `scripts/workerctl telemetry --summary --run <run_id>` reports local telemetry counts for the run.
- [ ] `scripts/workerctl telemetry --run <run_id>` prints the telemetry timeline.
- [ ] `scripts/workerctl telemetry --search manager --run <run_id>` finds manager-linked telemetry events.
- [ ] `scripts/workerctl qa-plan dispatch-completion` prints the dispatch completion QA flow.
- [ ] `scripts/workerctl dispatch --once --type worker_task_complete --dispatcher-id qa-dispatch --json` routes a disposable worker completion to the bound manager without Dispatch deciding task success.
- [ ] `scripts/workerctl audit <task> --json` includes `routed_notifications` and `correlation_chains` for the dispatch completion.
- [ ] `scripts/workerctl dashboard --task <task>` shows the selected task's Dispatch panel, heartbeat iteration/processed/dry-run details when present, and any durable `dispatch_signal_suppressed` telemetry count.
- [ ] `scripts/workerctl export-task <task> --zip --include-transcripts` writes a manifest and zip.
- [ ] `scripts/workerctl sessions --state active` has no disposable QA sessions after cleanup.
- [ ] `scripts/workerctl reconcile --stale-cycles-seconds 1` reports no dangling bindings, dead PID sessions, or stuck tasks.
