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
- [ ] `scripts/workerctl qa-plan ralph-loop` includes the max-iteration refusal browser drill: `enqueue-continue-iteration`, `dispatch --once --type continue_iteration`, `max_iterations_reached`, `0 notifications`, `Inbox 0`, and `Pull inbox 0`.
- [ ] `scripts/workerctl qa-plan ralph-loop` includes the missing-evidence browser drill: `required_before_continue=["ci_green"]`, `missing_ci_green_evidence`, `missing_evidence=[ci_green]`, `0 notifications`, `Inbox 0`, `Pull inbox 0`, and delivered retry after `ci_green` criterion evidence is recorded.
- [ ] `scripts/workerctl qa-plan ralph-loop` includes the preset evidence drill: `ralph-loop-presets --list`, `ralph-loop-presets --create-run`, `pr_ci_merge_loop`, `missing_required_evidence`, `missing pr_url, ci_green, merge`, `0 notifications`, `Inbox 0`, `Pull inbox 0`, and delivered retry after `pr_url`, `ci_green`, and `merge` criterion evidence is recorded.
- [ ] `scripts/workerctl dispatch --watch --watch-iterations 2 --interval 0 --dispatcher-id qa-dispatch-watch --dry-run --json` emits bounded watch heartbeat telemetry with iteration, processed count, and dry-run fields.
- [ ] `scripts/workerctl dispatch --once --type worker_task_complete --dispatcher-id qa-dispatch --json` routes a disposable worker completion to the bound manager without Dispatch deciding task success.
- [ ] `scripts/workerctl audit <task> --json` includes `routed_notifications` and `correlation_chains` for the dispatch completion.
- [ ] For shareable session evidence, use `scripts/workerctl sessions --name <session> --redact-identity-token` for each relevant manager/worker instead of unfiltered `sessions --state active`; verify no unredacted `identity_token` values are retained in artifacts.
- [ ] For Codex app inbox drills, use `manager-inbox <task> --consume-next --wait --json` and `worker-inbox <task> --consume-next --wait --json`; verify consumed items emit `dispatch_inbox_consumed` telemetry. Record whether `doctor-self --json` reports `workerctl_on_path=false`; if so, use explicit `scripts/workerctl` commands or install the local wrapper before handing instructions to app sessions.
- [ ] For whole-rollout ingest drills, note whether older completion signals are delivered before the target proof turn; consume/review older manager inbox items before deciding on the current signal.
- [ ] `scripts/workerctl dashboard --task <task> --ensure-dispatch --dispatcher-id qa-dispatch-dashboard` shows a top/banner Dispatch active state with dispatcher id, heartbeat age, iteration, processed count, dry-run/live state, and any durable `dispatch_signal_suppressed` telemetry count.
- [ ] Dashboard Dispatch conversation lane shows worker completion detection, routed notification, manager cycle consumption, and manager decision/command claim/attempt/delivery where applicable.
- [ ] Dashboard clearly warns when Dispatch is stale or not observed.
- [ ] `scripts/workerctl export-task <task> --zip --include-transcripts` writes a manifest and zip.
- [ ] `scripts/workerctl sessions --state active` has no disposable QA sessions after cleanup.
- [ ] `scripts/workerctl reconcile --stale-cycles-seconds 1` reports no dangling bindings, dead PID sessions, or stuck tasks.
