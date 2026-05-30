# T001 Live Codex App Inbox Drill

## Session Discovery

- Manager session: live app subagent `019e78d3-fc6d-7371-b57c-fcae94170975`
- Worker session: live app subagent `019e78d3-d0c5-7423-b885-55e8047473e6`
- Rollout JSONL paths:
  - Manager: `/Users/neonwatty/.codex/sessions/2026/05/30/rollout-2026-05-30T05-20-19-019e78d3-fc6d-7371-b57c-fcae94170975.jsonl`
  - Worker: `/Users/neonwatty/.codex/sessions/2026/05/30/rollout-2026-05-30T05-20-08-019e78d3-d0c5-7423-b885-55e8047473e6.jsonl`
- PIDs:
  - Manager rollout held open by Codex app server PID `61478`
  - Worker rollout held open by Codex app server PID `61478`
- Rollout evidence:
  - Manager: `artifacts/live-codex-app-inbox-drill-20260530/commands/02-manager-rollout-evidence.txt`
  - Worker: `artifacts/live-codex-app-inbox-drill-20260530/commands/03-worker-rollout-evidence.txt`

## Registration

- Task: `live-codex-app-inbox-20260530`
- Manager registration: `artifacts/live-codex-app-inbox-drill-20260530/commands/05-register-manager.txt`
- Worker registration: `artifacts/live-codex-app-inbox-drill-20260530/commands/04-register-worker.txt`
- Binding: `artifacts/live-codex-app-inbox-drill-20260530/commands/07-bind.txt`
- Active sessions: `artifacts/live-codex-app-inbox-drill-20260530/commands/08-sessions-active.txt`
- Both registrations intentionally omitted `--tmux-session`.
- Registration commands:
  - `scripts/workerctl register-worker --name live-app-worker-20260530 --pid 61478 --codex-session /Users/neonwatty/.codex/sessions/2026/05/30/rollout-2026-05-30T05-20-08-019e78d3-d0c5-7423-b885-55e8047473e6.jsonl --cwd /Users/neonwatty/Desktop/codex-terminal-manager`
  - `scripts/workerctl register-manager --name live-app-manager-20260530 --pid 61478 --codex-session /Users/neonwatty/.codex/sessions/2026/05/30/rollout-2026-05-30T05-20-19-019e78d3-fc6d-7371-b57c-fcae94170975.jsonl --cwd /Users/neonwatty/Desktop/codex-terminal-manager`
  - `scripts/workerctl tasks --create live-codex-app-inbox-20260530 --goal "Prove real Codex app manager and worker sessions can consume Dispatch inbox signals without tmux." --summary "Live Codex app manager/worker Dispatch inbox drill."`
  - `scripts/workerctl bind --task live-codex-app-inbox-20260530 --worker live-app-worker-20260530 --manager live-app-manager-20260530`

## Manager To Worker

- Queued command: `artifacts/live-codex-app-inbox-drill-20260530/commands/09-enqueue-nudge-worker.json`
- Dispatch result: `artifacts/live-codex-app-inbox-drill-20260530/commands/10-dispatch-nudge-worker.json`
- Worker inbox pending result: `artifacts/live-codex-app-inbox-drill-20260530/commands/11-worker-inbox-pending.json`
- Worker consume result: `artifacts/live-codex-app-inbox-drill-20260530/commands/12-worker-consume-by-app-session.json`
- Worker inbox after consume: `artifacts/live-codex-app-inbox-drill-20260530/commands/12-worker-inbox-after-consume.json`
- Worker response evidence: `artifacts/live-codex-app-inbox-drill-20260530/commands/12-worker-response-evidence.json`
- Worker acted on message: yes; worker app session consumed correlation id `live-app-manager-to-worker-20260530`. Its rollout response evidence records `WORKER_CONSUMED` and `Manager-to-worker pull delivery worked.`

## Worker To Manager

- Worker completion signal: worker response ingested from real app session; Dispatch routed two completion signals because the worker had an earlier setup-turn completion plus the target pull-delivery completion.
- Ingest result: `artifacts/live-codex-app-inbox-drill-20260530/commands/13-ingest-worker.txt`
- Dispatch result: `artifacts/live-codex-app-inbox-drill-20260530/commands/14-dispatch-worker-complete.json`
- Manager inbox pending result: `artifacts/live-codex-app-inbox-drill-20260530/commands/15-manager-inbox-pending.json`
- Manager consume result: `artifacts/live-codex-app-inbox-drill-20260530/commands/16-manager-consume-by-app-session.json`
- Manager second consume result: `artifacts/live-codex-app-inbox-drill-20260530/commands/16b-manager-consume-second-by-app-session.json`
- Manager inbox after consume: `artifacts/live-codex-app-inbox-drill-20260530/commands/16-manager-inbox-after-consume.json`
- Manager response evidence: `artifacts/live-codex-app-inbox-drill-20260530/commands/16-manager-response-evidence.json`
- Manager acted on message: yes; manager app session consumed both pull-required worker completion signals. The second consumed signal is the target proof and manager decided to mark the drill path successful with the PATH caveat.

## Dashboard And Replay

- Dashboard inbox summary: `artifacts/live-codex-app-inbox-drill-20260530/dashboard/dispatch-inbox-summary.txt`
- Replay routed notification rows: `artifacts/live-codex-app-inbox-drill-20260530/commands/18-replay.json`
- Audit routed notification rows: `artifacts/live-codex-app-inbox-drill-20260530/commands/17-audit.json`
- Compact replay: `artifacts/live-codex-app-inbox-drill-20260530/commands/19-replay-compact.txt`
- Final manager inbox: `artifacts/live-codex-app-inbox-drill-20260530/commands/17-manager-inbox-final.json`
- Final worker inbox: `artifacts/live-codex-app-inbox-drill-20260530/commands/17-worker-inbox-final.json`
- Export bundle: `artifacts/live-codex-app-inbox-drill-20260530/export/`
- Export command: `artifacts/live-codex-app-inbox-drill-20260530/commands/20-export-task.txt`

## Friction Log

- Polling cadence: manual per-turn polling worked for the drill; a production Codex app manager/worker prompt should explicitly poll once at the start of each turn or after being told a task name.
- Discovering rollout path: rollout evidence files above tie distinct agent ids to distinct Codex app JSONL paths and `lsof` output.
- Registering no-tmux sessions: `workerctl_on_path` is false in app sessions, but explicit `scripts/workerctl` worked for `doctor-self`.
- `workerctl_on_path` false in app sessions: docs/workflow, low/medium. No product fix required for this drill because explicit `scripts/workerctl` works; consider PATH/bootstrap docs improvement.
- Evidence hygiene: `08-sessions-active.txt` was narrowed to the two target sessions and redacted after capture because `sessions --state active` includes `identity_token` fields; the narrowed file still preserves role/name/cwd/pid/tmux evidence.
- Evidence hygiene: sessions output contains `identity_token` and unrelated active sessions unless narrowed/redacted; product/docs, high enough to consider follow-up before committing artifacts or improve sessions output for QA evidence.
- Doctor context caveat: `doctor-self` reports `inside_tmux: true` due to inherited controller command environment; the rollout files and `lsof` evidence are what prove the distinct Codex app sessions.
- `doctor-self` inside_tmux inherited context: docs/diagnostic clarity, medium. Possible future improvement because it confused live app evidence.
- Role caveat: manager rollout metadata may show subagent `agent_role: worker`; workerctl registration will explicitly register it as role `manager`, which is authoritative.
- Consuming the correct inbox: both sessions are ready to poll their role-specific inbox command.
- Reading dashboard/replay evidence: audit, replay, compact replay, final inbox JSON, and the dashboard evidence note now record source, target, delivery mode, and consumed session evidence.
- Signal noise: Dispatch correctly routed two worker completion signals after ingesting the whole worker app rollout; manager had to consume the earlier setup-turn completion before the target pull-delivery completion. This suggests live drills should either ingest only after the target worker turn or document that manager inbox may contain prior completions.
- Signal noise from whole-rollout ingest: workflow/product UX, medium. Dispatch behaved correctly, but live drills need to expect older completion signals or ingest at the right time.

## Verdict

- Result: pass for bidirectional pull-required delivery; follow-up fixes recommended before broad live QA are docs/diagnostic/evidence hygiene rather than core dispatcher correctness.
- Follow-up PR needed: yes, likely focused docs/CLI evidence hygiene improvements, not a blocker for core pull delivery.
- Follow-up issue/goal: create next plan/PR for redacted/narrow session evidence, `doctor-self` app-context clarity, and live-drill inbox signal filtering guidance.

## Acceptance Criteria

- [x] Real Codex app manager session registered without tmux.
- [x] Real Codex app worker session registered without tmux.
- [x] Manager-to-worker signal routed by Dispatch and consumed by worker app session.
- [x] Worker-to-manager completion routed by Dispatch and consumed by manager app session.
- [x] Both routed notification directions show `delivery_mode` as `pull_required`.
- [x] Audit, replay, and dashboard/evidence note show source/target/consumed evidence.
- [x] Friction captured as follow-up.
