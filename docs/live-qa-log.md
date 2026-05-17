# Live QA Log

## 2026-05-16: manager-led Gate 3 disposable edit QA

Scenario:

- Ladder gate: Gate 3 disposable edit readiness.
- Ladder scenario: Scenario 4 disposable edit task.
- Live disposable pair:
  - task `qa-g3-disposable-edit`
  - worker `qa-g3-worker`
  - manager `qa-g3-manager`
- Disposable edit target:
  `docs/live-qa-artifacts/2026-05-16-manager-led-gate3-disposable-edit/worker-disposable-edit.md`
- Evidence bundle:
  `docs/live-qa-artifacts/2026-05-16-manager-led-gate3-disposable-edit/`

Validated:

- The manager ran the first cycle and saw criteria negotiation was needed before
  criteria existed.
- The manager recovered from legacy `workerctl nudge` not resolving the
  session-bound worker and used `workerctl session-nudge`.
- The worker proposed three current-task criteria and one deferred follow-up.
- The manager ran `criteria-plan` before criteria mutations.
- The manager recorded three accepted criteria and one deferred follow-up.
- The manager instructed the worker to edit exactly one disposable target file.
- The worker created
  `docs/live-qa-artifacts/2026-05-16-manager-led-gate3-disposable-edit/worker-disposable-edit.md`
  and reported scoped verification.
- The manager noticed `git diff --name-only` missed the untracked target and
  corrected to scoped `git status --short` plus event-trail evidence.
- The manager satisfied all accepted criteria and exported replay evidence.
- Final postflight cleanup left both qa-g3 sessions marked `gone`, no matching
  tmux sessions, and clean `reconcile` state.

Gate decision:

- Pending Judge audit in
  `docs/goals/manager-led-scenario-3-gate3/state.yaml`.

Findings:

- A stray `/review` prompt appeared in both panes; the manager explicitly
  ignored it and no review, compact, clear, PR, merge, or destructive git action
  appeared in inspected evidence.
- The manager stopped the worker but left itself alive to report. PM stopped and
  deregistered the manager afterward to satisfy postflight invariants.

## 2026-05-16: manager-led Scenario 2 Gate 2 QA

Scenario:

- `scripts/workerctl qa-plan emergent-criteria --json`
- Live disposable pair:
  - task `qa-g2-manager-led-scenario-2`
  - worker `qa-g2-worker`
  - manager `qa-g2-manager`
- Evidence bundle:
  `docs/live-qa-artifacts/2026-05-16-manager-led-scenario-2/`

Validated:

- PM only started the pair, persisted narrow manager config, observed, exported,
  and ran postflight checks.
- The manager ran the first cycle, saw `criteria_negotiation.needed: true` with
  `reason: no_criteria`, and acted on it.
- The manager nudged the worker for separated must-have current-task criteria
  versus deferred follow-up criteria.
- The worker returned three must-have criteria and one deferred follow-up while
  keeping the task status-only.
- The manager ran `criteria-plan` on the worker criteria text before any
  criteria mutation.
- The manager recorded three worker-proposed accepted criteria and one
  worker-proposed deferred follow-up.
- The manager attempted a premature audited finish and `workerctl` blocked it
  while accepted criteria remained open.
- The manager satisfied all accepted criteria with proof text and structured
  evidence JSON.
- Replay shows criteria add/defer/satisfy/final finish transitions.
- Export wrote `acceptance-criteria.json`, and `manifest.json` lists it.
- Final `finish-task --require-criteria-audit --stop-manager --stop-worker`
  reported `killed_worker: true` and `killed_manager: true`.
- Postfinish cleanup found no matching tmux sessions, session rows marked
  `gone`, and `reconcile --stale-cycles-seconds 1` returned empty
  `dangling_bindings`, `dead_pid_sessions`, and `stuck_tasks`.

Gate decision:

- Gate 2 emergent criteria readiness is unlocked by this run.

Findings:

- Mutation audit currently reports the criteria mutations as `actor=workerctl`;
  manager terminal capture is the proof that the manager drove those commands.
  A future evidence-hardening helper could persist manager decision IDs or
  session identity for criteria mutations.
- The final manager capture after cleanup failed because the manager tmux
  session had already been stopped by successful final finish. That is expected
  after cleanup.

## 2026-05-16: emergent-criteria live QA

Scenario:

- `scripts/workerctl qa-plan emergent-criteria --json`
- Live disposable pair:
  - task `qa-emergent-criteria-20260516-run2`
  - worker `qa-ec-worker-run2`
  - manager `qa-ec-manager-run2`
- Evidence bundle:
  `docs/live-qa-artifacts/2026-05-16-emergent-criteria/`

Validated:

- Initial pair creation worked with suffixed disposable names. The preferred
  unsuffixed `qa-ec-worker` / `qa-ec-manager` names were still registered as
  `gone` from an older run, so the run avoided deregistering history.
- First `cycle` output included `manager_context.acceptance_criteria` with
  empty status buckets and `criteria_negotiation.needed: true`,
  `reason: no_criteria`.
- Worker produced separated must-have and deferred criteria while staying
  status-only.
- `criteria-plan` generated reviewed add commands from the saved worker
  response with no warnings and without mutating task state.
- Three worker-proposed criteria were recorded as accepted and two follow-up
  criteria were recorded as deferred.
- A later `cycle` showed accepted criteria in `open`, deferred criteria in
  `deferred`, and `criteria_negotiation.needed: false`.
- Premature `finish-task --require-criteria-audit` failed while accepted
  criteria were still open.
- Accepted criteria were satisfied with evidence JSON, and
  `criteria --list` reported `accepted: 0`, `satisfied: 3`, `deferred: 2`.
- The live manager noticed open criteria, recovered from legacy `nudge` not
  resolving the session-bound worker, used `session-nudge`, and got a
  status-only follow-up receipt from the worker.
- `replay` showed criteria add/defer/satisfy transitions.
- `export-task` wrote `acceptance-criteria.json`, and `manifest.json` lists it.
- Final audited `finish-task --stop-manager --stop-worker` reported
  `killed_worker: true` and `killed_manager: true`.
- Postfinish cleanup found no matching tmux sessions, both run2 sessions marked
  `gone`, and `reconcile --stale-cycles-seconds 1` returned empty
  `dangling_bindings`, `dead_pid_sessions`, and `stuck_tasks`.

Findings:

- This is a strong Scenario 1 / deterministic Scenario 2 pass, but not a full
  autonomous manager-led Scenario 2 pass. The PM thread still performed the
  initial `criteria-plan` and criteria add/satisfy mutations.
- The manager recovered correctly from `workerctl nudge qa-ec-worker-run2`
  failing with `Unknown worker`, switching to `session-nudge`.
- The worker first tried `./workerctl --help` and hit `permission denied`;
  `scripts/workerctl --help` and `bin/workerctl --help` both passed. Install
  and path behavior outside repo-local wrappers remains a follow-up.
- Git status was not clean after cleanup because GoalBuddy prep files were
  already modified before this run and the QA evidence bundle is new. No
  tracked product source file drift was observed.

## 2026-05-16: tmux-errors QA Pass

Scenario:

- `scripts/workerctl qa-plan tmux-errors`
- Non-destructive checks plus disposable mutating failure checks in isolated
  `WORKERCTL_STATE_ROOT` temp directories.

Validated:

- `doctor-self --json` remains parseable when unsupported from the current
  non-tmux Codex session.
- Missing-tmux simulation with `PATH=/usr/bin:/bin` keeps parseable JSON and
  includes an actionable `tmux_access` error.
- Active real sessions were empty before and after QA.
- Failed `session-nudge` against a disposable missing tmux target exits nonzero
  with clean stderr and does not record a misleading successful
  `session_nudged` audit event.
- `cycle` survives missing tmux pane capture and reports:
  - `pane_signal.captured: false`
  - `pane_signal.degraded: true`
  - a `tmux capture failed` reason
  - `worker_alive` / `manager_alive` based on registered process liveness
- `finish-task --stop-manager --stop-worker` fails cleanly when session identity
  verification sees the missing manager tmux session.
- `stop-task --reason ... --stop-worker` is accepted by argparse and reaches the
  same identity-verification failure path instead of failing as an unknown
  option.
- After killing disposable PIDs, `reconcile --stale-cycles-seconds 1` reports
  the dead pid sessions and `reconcile --apply` marks the disposable sessions
  gone and clears recovery state.

Resolved findings from the first tmux-errors run:

- Pane capture failures originally returned `degraded: false`; fixed in
  `ded46de` so attached-pane capture failures are degraded.
- `stop-task --reason` was originally rejected by argparse; fixed in `ded46de`
  and the reason is now recorded in command payloads, result payloads, and
  success events.
- The canonical read-only JSON-shape check now uses `workerctl list --json`
  rather than legacy text `workerctl list`; clarified in `3bf30c0`.

Final cleanup:

- `scripts/workerctl sessions --state active` returned `[]`.
- `tmux list-sessions` returned no sessions.
- `scripts/workerctl reconcile --stale-cycles-seconds 1` reported no dangling
  bindings, dead pid sessions, or stuck tasks.
- Git status was clean before starting the doc update.
