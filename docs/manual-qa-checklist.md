# Manual QA Checklist

Run this after unit tests and `scripts/live-smoke` pass.

- [ ] `scripts/workerctl doctor` reports `ok: true`.
- [ ] `scripts/workerctl db-doctor` reports schema health ok.
- [ ] `scripts/workerctl pair --task <task> --worker-name <worker> --manager-name <manager> --task-goal "<goal>" --cwd "$PWD" --manager-mode strict --manager-objective "<objective>" --manager-acceptance "<criterion>"` creates worker and manager with seeded manager config.
- [ ] `scripts/workerctl cycle <task>` reports pane signal and manager context.
- [ ] `scripts/workerctl session-nudge <worker> "dry-run status request" --dry-run` resolves the target.
- [ ] `scripts/workerctl session-nudge <worker> "..."` sends text to the correct pane in a disposable run.
- [ ] `scripts/workerctl criteria <task> --add --criterion "<criterion>" --source manager_inferred --status accepted` records an accepted criterion.
- [ ] `scripts/workerctl criteria <task> --list` shows the accepted criterion.
- [ ] `scripts/workerctl criteria <task> --satisfy <criterion-id> --evidence-json '{"command":"manual QA","status":"pass"}'` records satisfaction evidence.
- [ ] `scripts/workerctl finish-task <task> --require-criteria-audit` blocks when accepted criteria remain open.
- [ ] `scripts/workerctl finish-task <task> --capture-transcript-before-stop --stop-manager --stop-worker` captures transcript and stops both sessions.
- [ ] `scripts/workerctl transcript-show <task> --json` returns captured transcript records.
- [ ] `scripts/workerctl replay <task> --json` includes cycle, criteria, finish, and transcript evidence.
- [ ] `scripts/workerctl export-task <task> --zip --include-transcripts` writes a manifest and zip.
- [ ] `scripts/workerctl sessions --state active` has no disposable QA sessions after cleanup.
- [ ] `scripts/workerctl reconcile --stale-cycles-seconds 1` reports no dangling bindings, dead PID sessions, or stuck tasks.
