# 2026-05-16 Emergent Criteria Live QA

Task: `qa-emergent-criteria-20260516-run2`
Worker: `qa-ec-worker-run2`
Manager: `qa-ec-manager-run2`

## Result

Live Scenario 1/2 QA completed with cleanup.

- Pair start succeeded after switching to suffixed disposable names because the unsuffixed `qa-ec-worker` and `qa-ec-manager` rows were still registered as `gone` from an older run.
- Initial cycle exposed `manager_context.acceptance_criteria` with empty buckets and `criteria_negotiation.needed: true`, `reason: no_criteria`.
- Worker produced separated must-have and deferred criteria without tracked product edits.
- `criteria-plan` generated reviewed criteria commands from saved worker response text with no warnings.
- Three worker-proposed criteria were accepted, two worker-proposed follow-ups were deferred.
- Follow-up cycle exposed accepted criteria in `open`, deferred criteria in `deferred`, and `criteria_negotiation.needed: false`.
- Premature `finish-task --require-criteria-audit` failed while accepted criteria were open.
- Three accepted criteria were satisfied with evidence JSON.
- Replay showed add/defer/satisfy transitions.
- Export wrote `acceptance-criteria.json`, and `manifest.json` lists it.
- Final audited finish succeeded with `killed_worker: true` and `killed_manager: true`.
- Postfinish cleanup showed no matching tmux sessions, session rows marked `gone`, and reconcile clean.

## Covered Expected Observations

- `manager_context.acceptance_criteria` has summary/open/proposed/satisfied/deferred/rejected: `commands/03-cycle-initial.json`, `commands/18-cycle-after-criteria.json`.
- `criteria_negotiation.needed` true before criteria and false after active criteria: `commands/03-cycle-initial.json`, `commands/18-cycle-after-criteria.json`.
- Manager asked worker for criteria after inspecting open criteria: `commands/35-manager-capture-final.txt`.
- `criteria-plan` drafted commands from separated worker text without mutation: `commands/07-criteria-plan.json`.
- Worker-proposed accepted/deferred criteria visible in canonical list: `commands/13-criteria-list-after-add.json`, `commands/27-criteria-list-after-satisfy.json`.
- Accepted criteria blocked audited finish: `commands/19-finish-premature-expected-fail.txt`.
- Satisfied criteria include evidence JSON: `commands/24-satisfy-15.json`, `commands/25-satisfy-16.json`, `commands/26-satisfy-17.json`.
- Replay shows criteria lifecycle transitions: `commands/34-replay-final.txt`.
- Export includes acceptance criteria: `commands/32-export-task.txt`, `commands/33-export-verify.txt`.
- Final cleanup killed worker and manager: `commands/36-finish-task-final.json`.
- Session cleanup and reconcile were clean: `commands/37-tmux-postfinish.txt`, `commands/38-sessions-postfinish.json`, `commands/39-reconcile-postfinish.json`.
- Git status captured after cleanup: `commands/40-git-status-postfinish.txt`.

## Uncovered Or Partial Observations

- The manager did not complete the entire criteria mutation path unaided. It correctly noticed open criteria, tried the legacy `nudge` command, recovered to `session-nudge`, and drove a worker follow-up. The PM thread still performed the initial criteria-plan and criteria add/satisfy mutations.
- The unsuffixed disposable session names were occupied by gone rows, so this run used `qa-ec-worker-run2`, `qa-ec-manager-run2`, and `qa-emergent-criteria-20260516-run2`.
- The worker first tried `./workerctl --help` and hit `permission denied`; repo-local `scripts/workerctl --help` and `bin/workerctl --help` passed. Install/path behavior outside repo-local wrappers remains a deferred follow-up.

## Postflight

- `scripts/workerctl finish-task qa-emergent-criteria-20260516-run2 --reason "QA criteria flow complete" --require-criteria-audit --stop-manager --stop-worker` passed.
- `tmux list-sessions | rg 'qa-ec-(worker|manager)|codex-qa-ec'` returned no matches.
- `scripts/workerctl reconcile --stale-cycles-seconds 1` returned empty `dangling_bindings`, `dead_pid_sessions`, and `stuck_tasks`.
- `git status --short --branch` still shows pre-existing GoalBuddy prep changes plus the new QA artifacts.
