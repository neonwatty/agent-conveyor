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

- [ ] `conveyor doctor` reports `ok: true`.
- [ ] `conveyor db-doctor` reports schema health ok.
- [ ] `conveyor pair --task <task> --worker-name <worker> --manager-name <manager> --task-goal "<goal>" --cwd "$PWD" --codex-profile yolo --manager-mode strict --manager-objective "<objective>" --manager-acceptance "<criterion>"` creates worker and manager with seeded manager config.
- [ ] `conveyor cycle <task>` reports pane signal and manager context.
- [ ] `conveyor session-nudge <worker> "dry-run status request" --dry-run` resolves the target.
- [ ] `conveyor session-nudge <worker> "..."` sends text to the correct pane in a disposable run.
- [ ] `conveyor criteria <task> --add --criterion "<criterion>" --source manager_inferred --status accepted` records an accepted criterion.
- [ ] `conveyor criteria <task> --list` shows the accepted criterion.
- [ ] `conveyor criteria <task> --satisfy <criterion-id> --evidence-json '{"command":"manual QA","status":"pass"}'` records satisfaction evidence.
- [ ] `conveyor finish-task <task> --require-criteria-audit` blocks when accepted criteria remain open.
- [ ] `conveyor finish-task <task> --capture-transcript-before-stop --require-transcript-segment --stop-manager --stop-worker` captures non-empty transcript segments and stops both sessions.
- [ ] `conveyor transcript-show <task> --json` returns captured transcript metadata with segment text redacted.
- [ ] `conveyor replay <task> --json` includes cycle, criteria, and finish evidence.
- [ ] `conveyor replay <task> --json --format full-transcript` fails unless `--include-content` is passed.
- [ ] `conveyor replay <task> --json --format full-transcript --include-content > /tmp/conveyor-full-transcript.json` includes transcript segment evidence without dumping it into the active Codex terminal.
- [ ] `conveyor telemetry --summary --run <run_id>` reports local telemetry counts for the run.
- [ ] `conveyor telemetry --run <run_id>` prints the telemetry timeline.
- [ ] `conveyor telemetry --search manager --run <run_id>` finds manager-linked telemetry events.
- [ ] `conveyor qa-plan dispatch-completion` prints the dispatch completion QA flow.
- [ ] `conveyor qa-plan adversarial-triggers` includes the five natural-language trigger drills: loop policy creation, Dispatch continuation block, finish gate, worker-proposed proof, and manager-created adversarial criteria.
- [ ] `conveyor loop-triggers --classify "Run this as an adversarially gated Ralph loop." --json` matches `loop-gate-trigger`, while generic "be careful and run tests" prose does not match any controlled loop trigger.
- [ ] `conveyor qa-plan ralph-loop` includes the max-iteration refusal browser drill: `enqueue-continue-iteration`, `dispatch --once --type continue_iteration`, `max_iterations_reached`, `0 notifications`, `Inbox 0`, and `Pull inbox 0`.
- [ ] `conveyor qa-run ralph-loop-guardrails --receipt-output /tmp/ralph-loop-guardrails-receipt.json --json` writes a saved receipt proving max-iteration cutoff, missing `ci_green`/`adversarial_check` cutoff, fresh retry delivery after structured evidence, and the `pr_ci_merge_loop` preset `pr_url`/`ci_green`/`merge`/`adversarial_check` gate.
- [ ] `conveyor qa-run generic-loop-template --receipt-output /tmp/generic-loop-template-receipt.json --json` writes a saved receipt proving `visual_diff_loop` metadata, missing visual evidence cutoff, unstructured `adversarial_check` refusal, and fresh retry delivery only after visual evidence plus structured adversarial proof.
- [ ] `conveyor qa-run generic-loop-template-browser --receipt-output /tmp/generic-loop-template-browser-receipt.json --json` writes a saved receipt proving browser-rendered `candidate_screenshot` evidence, visual diff metadata, missing visual evidence cutoff, unstructured `adversarial_check` refusal, and fresh retry delivery only after browser visual evidence plus structured adversarial proof; this uses the repo's Node Playwright dependency and requires Chromium to be installed and launchable, otherwise the browser-backed QA helper message is expected.
- [ ] `conveyor qa-run test-coverage-loop --receipt-output /tmp/test-coverage-loop-receipt.json --json` writes a saved receipt proving `test_coverage_loop` metadata, missing coverage/adversarial evidence cutoff, unstructured `adversarial_check` refusal, durable coverage artifact output, and fresh retry delivery only after coverage evidence plus structured adversarial proof.
- [ ] `conveyor qa-run adversarial-triggers --receipt-output /tmp/adversarial-triggers-receipt.json --json` writes a saved receipt proving controlled prompt classification, blocked Dispatch with `target_worker_notified=false` and worker inbox 0 before proof, fresh worker inbox retry after structured proof, `finish-task --require-adversarial-proof`, `worker_proposed` proof recording, and manager-created adversarial criteria.
- [ ] `conveyor qa-run build-clear-loop --receipt-output /tmp/build-clear-loop-receipt.json --json` writes a saved receipt proving `build_then_clear` metadata, missing `build_passed`/`cleanup` cutoff, worker inbox 0 before evidence, continued blocking after build evidence alone, and fresh retry delivery only after both build and cleanup evidence.
- [ ] Ralph loop operator guide documents the real-work sequence: `loop-triggers --classify`, `loop-templates --create-run`, `loop-evidence adversarial-check`, `enqueue-continue-iteration`, `worker-inbox --consume-next --wait`, `loop-status`, and `telemetry failures`.
- [ ] `conveyor create-disposable-binding qa-no-tmux-loop --worker qa-no-tmux-worker --manager qa-no-tmux-manager --required-before-continue adversarial_check --json` creates real rollout JSONL files, registers no-tmux manager/worker sessions, binds the task, creates a gated loop run, and prints replay commands for Dispatch, inbox polling, and `loop-status`.
- [ ] Ralph-loop missing-evidence QA includes `required_before_continue=["ci_green","adversarial_check"]`, `missing_required_evidence`, `missing_evidence=[ci_green,adversarial_check]`, `0 notifications`, `Inbox 0`, `Pull inbox 0`, and delivered retry only after `ci_green` criterion evidence and `conveyor loop-evidence adversarial-check` proof are recorded.
- [ ] Ralph-loop preset evidence QA includes `ralph-loop-presets --list`, `ralph-loop-presets --create-run`, `pr_ci_merge_loop`, `missing_required_evidence`, `missing pr_url, ci_green, merge, adversarial_check`, `0 notifications`, `Inbox 0`, `Pull inbox 0`, and delivered retry only after `pr_url`, `ci_green`, `merge`, and structured `adversarial_check` evidence are recorded.
- [ ] `conveyor loop-templates --list --json` includes `visual_diff_loop`, `test_coverage_loop`, `pr_ci_merge_loop`, `build_then_clear`, and `compact_then_continue`.
- [ ] Generic loop template QA blocks `visual_diff_loop` continuation with `missing_required_evidence`, `0 notifications`, `Inbox 0`, and `Pull inbox 0` before visual evidence exists.
- [ ] Generic loop template QA records run-qualified receipts with `conveyor loop-evidence add` and computes visual receipts with `conveyor loop-evidence visual-diff`.
- [ ] Generic loop template QA delivers a fresh `continue_iteration` after `reference_artifact`, `candidate_screenshot`, `visual_diff_report`, `diff_below_threshold`, and structured `adversarial_check` evidence with non-empty `failure_mode`, `check`, and `result` are recorded.
- [ ] Template-backed `enqueue-continue-iteration` JSON includes `loop_policy`, rejects `requested_iteration <= current_iteration` without queueing a command, Dispatch blocks any stale same/current iteration command that reaches the queue, and delivered worker inbox payloads include the same `loop_policy` for Codex app polling and tmux delivery.
- [ ] Generic loop template QA consumes the delivered worker inbox item with `--consume-next --wait` and records `dispatch_inbox_consumed` telemetry.
- [ ] `conveyor dispatch --watch --watch-iterations 2 --interval 0 --dispatcher-id qa-dispatch-watch --dry-run --json` emits bounded watch heartbeat telemetry with iteration, processed count, and dry-run fields.
- [ ] `conveyor dispatch --once --type worker_task_complete --dispatcher-id qa-dispatch --json` routes a disposable worker completion to the bound manager without Dispatch deciding task success.
- [ ] `conveyor audit <task> --json` includes `routed_notifications` and `correlation_chains` for the dispatch completion.
- [ ] For shareable session evidence, use `conveyor sessions --name <session> --redact-identity-token` for each relevant manager/worker instead of unfiltered `sessions --state active`; verify no unredacted `identity_token` values are retained in artifacts.
- [ ] For Codex app inbox drills, use `manager-inbox <task> --consume-next --wait --json` and `worker-inbox <task> --consume-next --wait --json`; verify consumed items emit `dispatch_inbox_consumed` telemetry. Record whether `doctor-self --json` reports `workerctl_on_path=false`; if so, use explicit `conveyor` commands or install the local wrapper before handing instructions to app sessions.
- [ ] For whole-rollout ingest drills, note whether older completion signals are delivered before the target proof turn; consume/review older manager inbox items before deciding on the current signal.
- [ ] `conveyor dashboard --task <task> --ensure-dispatch --dispatcher-id qa-dispatch-dashboard` shows a top/banner Dispatch active state with dispatcher id, heartbeat age, iteration, processed count, dry-run/live state, and any durable `dispatch_signal_suppressed` telemetry count.
- [ ] Dashboard Dispatch conversation lane shows worker completion detection, routed notification, manager cycle consumption, and manager decision/command claim/attempt/delivery where applicable.
- [ ] Dashboard clearly warns when Dispatch is stale or not observed.
- [ ] `conveyor export-task <task> --zip --include-transcripts` writes a manifest and zip.
- [ ] `conveyor sessions --state active` has no disposable QA sessions after cleanup.
- [ ] `conveyor reconcile --stale-cycles-seconds 1` reports no dangling bindings, dead PID sessions, or stuck tasks.
