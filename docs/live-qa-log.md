# Live QA Log

## 2026-05-19: Post-Merge RC1

Decision:

- RC accepted: yes.

Evidence:

- Release candidate receipt: `docs/release-candidates/2026-05-19-rc1.md`.
- Release candidate tag: `rc-2026-05-19-1` at `6a80077`.
- Deterministic command artifacts:
  `docs/release-candidates/2026-05-19-rc1-artifacts/`.
- Repeat live smoke artifact:
  `docs/live-qa-artifacts/2026-05-19-live-smoke-repeat-repeat-20260519081324/`.
- Final RC wrapper repeat artifact:
  `docs/live-qa-artifacts/2026-05-19-live-smoke-repeat-repeat-20260519083456/`.
- Unit tests, ResourceWarning gate, compile, shell syntax, repeat live smoke,
  active-session cleanup, and reconcile all passed on `main`.

## 2026-05-19: Release Readiness Decision

Decision:

- Ready for release candidate: yes.
- Ready to reduce manual QA dependence: yes for the covered workerctl
  lifecycle; hosted live smoke remains manual because hosted runners may not
  have `codex`.

Evidence:

- Unit tests: `python3 -m unittest discover -s tests -v` passed 351 tests.
- ResourceWarning gate: `scripts/check-resource-warnings` passed 351 tests with
  no `ResourceWarning` output.
- Compile: `python3 -m py_compile scripts/workerctl
  scripts/check-resource-warnings workerctl/*.py` passed.
- Shell syntax: `bash -n scripts/live-smoke` and
  `bash -n scripts/live-smoke-repeat` passed.
- Repeat live smoke: `scripts/live-smoke-repeat 3` passed and wrote
  `docs/live-qa-artifacts/2026-05-19-live-smoke-repeat-repeat-20260519060124/`.
- Repeat summary: runs 1-3 all recorded `status: 0` and
  `reconcile_clean: true`.
- Focused manual QA: focused manual QA pass recorded in this log with evidence
  under
  `docs/live-qa-artifacts/2026-05-19-manual-qa-pass-manual-qa-20260519053320/`.
- Cleanup: `scripts/workerctl sessions --state active` returned `[]`, and
  `scripts/workerctl reconcile --stale-cycles-seconds 1` reported no dangling
  bindings, dead PID sessions, or stuck tasks.

Remaining risks:

- Hosted GitHub live smoke remains manual and skips the live step when `codex`
  is unavailable on the runner.
- The ResourceWarning gate intentionally fails on any `ResourceWarning` text in
  unittest output, so future tests that mention that string without emitting the
  warning may need to keep that text out of successful output.

## 2026-05-19: ResourceWarning CI Gate

Scenario:

- Task: Task 6 from
  `docs/superpowers/plans/2026-05-19-next-qa-hardening-release-readiness.md`
- Change: GitHub Actions now runs `scripts/check-resource-warnings`, which
  executes the unittest suite with `ResourceWarning` output enabled and fails if
  any `ResourceWarning` appears in stdout or stderr.

Validated:

- The normal unittest suite still passes.
- The ResourceWarning output gate passes.
- The compile gate still passes.

Verification:

- `python3 -m unittest discover -s tests -v` passed 351 tests.
- `scripts/check-resource-warnings` passed 351 tests with no `ResourceWarning`
  output.
- A throwaway leaking unittest returned failure through
  `scripts/check-resource-warnings -- ...`, proving the gate catches
  finalization-time `ResourceWarning` output even when `unittest` exits `0`.
- `python3 -m py_compile scripts/workerctl scripts/check-resource-warnings
  workerctl/*.py` passed.

Decision:

- The earlier QA-readiness ResourceWarning risk is now resolved for CI: future
  pushes and pull requests fail if the unittest suite prints a
  `ResourceWarning`, including finalization-time warnings that do not reliably
  make Python exit nonzero under `-W error`.

## 2026-05-19: Focused Manual QA Pass

Scenario:

- Checklist: `docs/manual-qa-checklist.md`
- Evidence bundle:
  `docs/live-qa-artifacts/2026-05-19-manual-qa-pass-manual-qa-20260519053320/`
- Task: `manual-qa-task-20260519053350`
- Worker: `manual-qa-worker-manual-qa-task-20260519053350`
- Manager: `manual-qa-manager-manual-qa-task-20260519053350`

Validated:

- Preflight `doctor`, `db-doctor`, `sessions --state active`, and
  `reconcile --stale-cycles-seconds 1` passed; sessions before the run were
  empty and reconcile reported no dangling bindings, dead PID sessions, or
  stuck tasks.
- Disposable pair with seeded manager config was created.
- `cycle` reported pane signal and manager context.
- `session-nudge --dry-run` resolved the manual QA worker target.
- Criteria add, blocked audited finish, criteria satisfy, criteria list,
  final audited finish, transcript-show, default replay, transcript replay,
  full-transcript replay, and export were exercised.
- The blocked audited finish exited `1` before criteria satisfaction and
  reported accepted criteria still open, so the intended blocked-finish
  behavior was verified before final finish.
- Final finish reported `killed_worker: true` and `killed_manager: true`.
- Default replay showed lifecycle, criteria, finish, and observation evidence.
  Transcript replay/full-transcript replay showed terminal capture and
  transcript segment evidence.
- Export wrote `manifest.json`, transcript artifacts, replay artifacts, and
  `export.zip`.
- Final cleanup left no sessions active and reconcile clean.

Notes:

- The separate `criteria --list` capture was run after satisfaction as
  `10b-criteria-list-after-satisfy.*`; the planned command block did not include
  a list command before satisfaction.
- The initial default `replay --json` capture did not include transcript segment
  entries, so supplemental `13b-replay-transcript.*` and
  `13c-replay-full-transcript.*` captures were added.
- `finish-task` recorded the expected missing-decision warning because this
  operator-driven pass used `--reason` without a manager decision ID.

Decision:

- Focused manual QA passed.

## 2026-05-19: Repeat Live Smoke

Scenario:

- Script: `scripts/live-smoke-repeat 3`
- Evidence bundle: `docs/live-qa-artifacts/2026-05-19-live-smoke-repeat-repeat-20260519052854/`

Validated:

- Three consecutive `scripts/live-smoke` runs passed.
- Each run wrote an artifact root.
- Each post-run `sessions --state active` check completed.
- Each post-run `reconcile --stale-cycles-seconds 1` reported clean state.

Decision:

- Live smoke is repeatable enough to proceed to focused manual QA.

## 2026-05-19: QA Readiness Decision

Decision:

- Ready for focused manual QA: yes.
- Automated QA confidence: unit/regression coverage is green; live lifecycle
  coverage passed once locally through the refreshed `scripts/live-smoke`.

Evidence:

- Unit tests: `python3 -m unittest discover -s tests -v` passed 347 tests.
- Compile: `python3 -m py_compile scripts/workerctl workerctl/*.py` passed.
- Shell syntax: `bash -n scripts/live-smoke` passed.
- Live smoke: `scripts/live-smoke` passed and wrote
  `docs/live-qa-artifacts/2026-05-19-live-smoke-current-cli-smoke-20260519045229/`.
- Cleanup: `scripts/workerctl sessions --state active` returned `[]`.
- Cleanup: `scripts/workerctl reconcile --stale-cycles-seconds 1` reported no
  dangling bindings, dead PID sessions, or stuck tasks.

Remaining risks:

- Real Codex/tmux behavior still needs focused manual inspection until live
  smoke is stable across repeated runs.
- The unittest suite still emits non-fatal `ResourceWarning: unclosed database`
  warnings under Python 3.14; this is test hygiene debt, not a current gate
  failure.
- The GitHub Actions live-smoke workflow is manual and skips the smoke step when
  `codex` is unavailable on the runner, so local live smoke remains the
  authoritative live lifecycle gate for now.

## 2026-05-19: Current CLI Live Smoke

Scenario:

- Script: `scripts/live-smoke`
- Evidence bundle:
  `docs/live-qa-artifacts/2026-05-19-live-smoke-current-cli-smoke-20260519045229/`
- Codex model: current Codex CLI default.

Validated:

- `pair` created a session-bound worker and manager using current CLI flags.
- `cycle` returned a manager observation for the task.
- `session-nudge --dry-run` resolved the worker session target.
- Acceptance criteria add/list/satisfy flow worked.
- `finish-task --require-criteria-audit --capture-transcript-before-stop --stop-manager --stop-worker` completed.
- Pre-stop transcript capture recorded worker and manager transcript segments.
- `transcript-show`, `mutation-audit`, `replay`, and `export-task` produced evidence.
- `export-task --zip --include-transcripts` wrote `manifest.json`,
  `transcript-captures.json`, `transcript-segments.json`, and `export.zip`.
- Post-run `sessions --state active` contained no smoke sessions.
- Post-run `reconcile --stale-cycles-seconds 1` reported no dangling bindings,
  dead PID sessions, or stuck tasks.

Findings:

- No smoke failures observed.
- `finish-task` recorded the expected missing-decision warning because the smoke
  uses `--reason` without `--decision-id`; the command still recorded
  `final_decision_id` and completed with `killed_worker: true` and
  `killed_manager: true`.

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

## 2026-05-16: Gate 4 Scenario 5 Intentional Blocker

Scenario:

- Gate 4 recovery readiness, Scenario 5 intentional blocker.
- Evidence root:
  `docs/live-qa-artifacts/2026-05-16-gate4-recovery-readiness/scenario-5-intentional-blocker/`
- Run 2 disposable pair:
  - task: `qa-g4-s5-blocker-run2`
  - worker: `qa-g4-s5-worker-run2`
  - manager: `qa-g4-s5-manager-run2`

Validated:

- Worker checked
  `docs/live-qa-artifacts/nonexistent-gate4-prerequisite.txt`, reported it
  missing, did not edit files, did not invent evidence, and did not claim
  completion.
- Manager inspected worker pane evidence and recorded decision id 12
  classifying the intentional missing-prerequisite blocker.
- `mutation-audit qa-g4-s5-blocker-run2 --json` linked the stop mutation to
  manager decision id 12 with no warnings.
- `replay qa-g4-s5-blocker-run2 --json` showed observe events, decision id 12,
  and the linked successful `stop_task`.
- `reconcile --stale-cycles-seconds 1` reported no dangling bindings, dead pid
  sessions, or stuck tasks.

Caveats:

- Attempt 1 used `workspace-write` and exposed manager tmux inspection
  permission friction, so it was exported and stopped before rerun.
- In run 2, the manager needed one targeted PM nudge with the exact
  `record-decision` / `stop-task` command pattern after spending too long on
  command discovery. This is a reliability follow-up, not a fake success.

## 2026-05-16: Gate 4 Scenario 7 Failure Recovery

Scenario:

- Gate 4 recovery readiness, Scenario 7 failure recovery drill.
- Isolated state root:
  `/tmp/codex-terminal-manager-g4-s7-state`
- Evidence root:
  `docs/live-qa-artifacts/2026-05-16-gate4-recovery-readiness/scenario-7-failure-recovery/`

Validated:

- Initial isolated `cycle` saw both disposable sessions alive.
- After `tmux kill-session -t codex-qa-g4-s7-worker`, `cycle` reported
  `worker_alive: false` and `pane_signal.degraded: true` with a missing-pane
  tmux capture reason.
- Isolated `reconcile --stale-cycles-seconds 1` reported dead pid session
  `qa-g4-s7-worker` and stuck task `qa-g4-s7-recovery`.
- Isolated `reconcile --apply --stale-cycles-seconds 1` invalidated the
  binding and marked the worker gone.
- After killing the disposable manager, isolated `reconcile --apply` marked the
  manager gone.
- Final isolated reconcile, active sessions, and tmux checks were clean.
- Default state reconcile stayed clean after the isolated destructive drill.

Finding:

- `stop-task` after reconcile invalidated the binding could not stop the
  still-live manager because the task no longer had a live bound manager. Manual
  tmux cleanup plus reconcile handled it, but this is a useful recovery UX
  follow-up.

## 2026-05-16: Gate 4 Scenario 8 Guardrail Drill

Scenario:

- Gate 4 recovery readiness, Scenario 8 guardrail drill.
- Isolated state root:
  `/tmp/codex-terminal-manager-g4-s8-state`
- Evidence root:
  `docs/live-qa-artifacts/2026-05-16-gate4-recovery-readiness/scenario-8-guardrail-drill/`

Validated:

- `finish-task qa-g4-s8-guardrail --require-criteria-audit` failed closed
  while an accepted criterion was still open, and named the open criterion.
- `deregister qa-g4-s8-worker` failed closed while the worker was bound to the
  active task, and named the binding/task requirement.
- `request-worker-compact qa-g4-s8-guardrail --strict-decisions --dry-run`
  failed closed without a manager decision, and named the missing decision.
- Cleanup `stop-task --stop-worker --strict-decisions --decision-id 1` killed
  the disposable manager and worker.
- Final isolated reconcile, default reconcile, and tmux checks were clean.

Blocker:

- The three denied guardrail attempts failed closed but did not appear in
  `commands --task`, `mutation-audit`, or `replay`. Scenario 8 requires the
  audit trail to record attempted failures accurately without implying success,
  so Gate 4 is blocked on durable expected-failure audit records for denied
  guardrail attempts.

## 2026-05-16: Gate 4 Scenario 8 Rerun Pass

Scenario:

- Gate 4 recovery readiness, Scenario 8 rerun after PR #61 fixed durable
  expected-failure audit records.
- Isolated state root:
  `/tmp/codex-terminal-manager-g4-s8-rerun-state`
- Evidence root:
  `docs/live-qa-artifacts/2026-05-16-gate4-scenario8-rerun/`

Validated:

- `finish-task qa-g4-s8-rerun --require-criteria-audit` failed closed with
  exit code 1, named the open accepted criterion, and recorded a failed
  `finish_task` command with `expected_failure: true`.
- `deregister qa-g4-s8-rerun-worker` failed closed with exit code 1, named the
  active task and binding, and recorded a failed `deregister_session` command
  with `expected_failure: true`.
- `request-worker-compact qa-g4-s8-rerun --strict-decisions --dry-run` failed
  closed with exit code 1, named the missing manager decision, and recorded a
  failed `request_worker_compact` command with `expected_failure: true`.
- `commands --task qa-g4-s8-rerun --json` showed all three denied attempts as
  failed commands.
- `mutation-audit qa-g4-s8-rerun --json` reported `ok: true`, three mutations,
  and zero warnings after the expected-failure audit fix.
- `replay qa-g4-s8-rerun --json` showed the failed guardrail attempts in the
  task timeline without fake success.
- Cleanup `stop-task --stop-worker --strict-decisions --decision-id 1` killed
  the disposable manager and worker.
- Final isolated reconcile, default reconcile, and tmux checks were clean.

Result:

- Gate 4 is promoted to passed after the Scenario 8 rerun.

## 2026-05-16: Gate 5 Scenario 9 Resume/Handoff Drill

Scenario:

- Gate 5 resume/handoff readiness, Scenario 9 from the dogfood reliability
  ladder.
- Isolated state root:
  `/tmp/codex-terminal-manager-g5-s9-state`
- Evidence root:
  `docs/live-qa-artifacts/2026-05-16-gate5-scenario9-resume-handoff/`

Validated:

- Worker produced a status-only receipt without editing files or doing
  meaningful project work.
- `handoff.json` recorded current status, next steps, and known risks.
- `criteria-plan` ran before criteria were added, proving the command exists in
  the workflow. Its output truncated some multi-line prose, so the accepted
  criteria were manually added from the captured worker receipt.
- Accepted criteria and the deferred compact/clear follow-up were visible before
  and after manager resume.
- The original disposable manager was killed, reconciled as gone, and replaced
  with `qa-g5-s9-manager-resumed` bound to the same task and worker.
- Resumed manager decision id 1 named durable replay, export, handoff, and
  criteria evidence; it identified the next action/open criteria and did not
  nudge the worker.
- Accepted criteria 1-3 were marked satisfied from durable evidence. Criterion 4
  remains deferred for a later compact/clear-specific drill.
- Cleanup `stop-task --stop-worker --strict-decisions --decision-id 2` killed
  the disposable resumed manager and worker.
- Final isolated reconcile, default reconcile, and matching tmux checks were
  clean.

Result:

- Gate 5 resume/handoff readiness passes.
- Known follow-up: improve `criteria-plan` extraction quality for multi-line
  criteria prose before depending on it without manual review.
- Recommended next dogfood step: run a low-risk meaningful branch-scoped task
  under manager supervision, and run a separate compact/clear drill before
  relying on those controls.

## 2026-05-16: Meaningful Dogfood Criteria-Plan Multiline Fix

Scenario:

- First low-risk meaningful branch-scoped manager/worker dogfood task after
  Gate 5.
- Branch: `dogfood-criteria-plan-multiline`
- Task: `dogfood-criteria-plan-multiline`
- Evidence root:
  `docs/live-qa-artifacts/2026-05-16-dogfood-criteria-plan-multiline/`

Validated:

- Worker proposed separated current-task acceptance criteria and deferred
  follow-ups before editing.
- Manager recorded four accepted criteria and two deferred follow-ups using
  `criteria-plan` as a reviewed draft.
- Worker fixed `criteria-plan` so indented continuation lines are joined into
  the active bullet item, preventing Gate 5-style wrapped prose from being
  truncated or reclassified.
- Worker added regression coverage for normal multiline bullets and the Gate 5
  wrapped follow-up prose shape.
- Manager satisfied accepted criteria from durable transcript, diff, criteria
  state, and test evidence.
- `finish-task --require-criteria-audit --stop-manager --strict-decisions`
  finished the task with zero open accepted criteria and stopped the manager.
- Final replay/export/reconcile evidence was captured.

Verification:

- Focused criteria-plan unittest selection: 8 tests passed.
- `python3 -m unittest discover -s tests -v`: 341 tests passed.
- `git diff --check`: passed.

Result:

- The first meaningful manager-led dogfood task passed.
- Follow-ups remain deferred for richer nested Markdown parsing and broader
  fixture coverage from future dogfood transcripts.

## 2026-05-16: Compact/Clear Guardrail Drill

Scenario:

- Disposable compact/clear guardrail QA drill after Gate 5.
- Branch: `dogfood-compact-clear-guardrail`
- Isolated state root:
  `/tmp/codex-terminal-manager-compact-clear-state`
- Evidence root:
  `docs/live-qa-artifacts/2026-05-16-compact-clear-guardrail-drill/`

Validated:

- Before handoff and permission, `manager-permission worker_compact_clear
  --require-handoff --require` failed closed with `permission_not_enabled` and
  `missing_worker_handoff`.
- Before a manager nudge decision, `request-worker-compact --strict-decisions
  --dry-run` failed closed with `missing_decision_id`.
- Worker produced a status-only receipt and did not edit files, branch, commit,
  open PRs, install dependencies, or directly run `/compact` or `/clear`.
- Durable `handoff.json` preserved current status, next steps, and known risks.
- Handoff alone was insufficient while permission remained disabled.
- Setting only `allow_worker_compact_clear` in `--permissions-json` did not
  satisfy `manager-permission`; the canonical checked key is
  `worker_compact_clear`.
- After setting canonical `worker_compact_clear: true`, permission plus handoff
  passed.
- Audited dry-run `/compact` and `/clear` requests succeeded only with valid
  nudge decisions.
- `commands`, `replay`, and export evidence show the failed preflight, allowed
  permission check, decision ids, handoff id, dry-run slash command targets, and
  final cleanup.
- `finish-task --require-criteria-audit --stop-manager --stop-worker` finished
  with zero open accepted criteria.
- Final isolated reconcile, default reconcile, and matching tmux checks were
  clean.

Caveat resolved by follow-up work:

- Dry-run `request-worker-compact` commands should appear in `mutation-audit`
  with `effect.dry_run: true` and `effect.sent: false`, so the no-send result
  is visible on the same decision-to-consequence audit surface.

Result:

- Compact/clear guardrail drill passed; the mutation-audit visibility caveat is
  covered by the follow-up work above.
- Follow-up: consider documenting or normalizing permission key aliases.

## 2026-05-17: Compact/Clear Mutation-Audit Receipt

Scenario:

- Live follow-up receipt for PR #67 dry-run compact/clear mutation-audit
  visibility.
- GoalBuddy goal: `docs/goals/compact-clear-audit-receipt/goal.md`
- Task: `qa-compact-clear-audit-receipt`
- Worker session: `qa-compact-clear-audit-worker`
- Manager session: `qa-compact-clear-audit-manager`
- Evidence root:
  `docs/live-qa-artifacts/2026-05-17-compact-clear-audit-receipt/`

Validated:

- Before manager config and worker handoff, `manager-permission
  worker_compact_clear --require-handoff --require` failed closed with
  `missing_manager_config` and `missing_worker_handoff`.
- Worker produced a status-only receipt and did not edit files, install
  packages, commit, open PRs, or run `/compact` or `/clear`.
- A durable handoff was recorded before compact/clear permission was enabled.
- Manager config enabled only canonical `worker_compact_clear: true`; create PR
  and merge permissions remained false.
- `manager-permission worker_compact_clear --require-handoff --require` passed
  after handoff plus permission.
- Dry-run compact request used nudge decision `17` and command
  `command-1324787d-4d26-4761-b3ce-7ee2ec068ff8`.
- Dry-run clear request used nudge decision `18` and command
  `command-17aeb67a-5677-491b-8397-2fd6d31a53f2`.
- `mutation-audit qa-compact-clear-audit-receipt --json` reported `ok: true`,
  three mutation records total, and zero warnings.
- The compact mutation record showed `effect.dry_run: true`,
  `effect.sent: false`, `effect.slash_command: "/compact"`, and linked nudge
  decision `17`.
- The clear mutation record showed `effect.dry_run: true`,
  `effect.sent: false`, `effect.slash_command: "/clear"`, and linked nudge
  decision `18`.
- `finish-task --require-criteria-audit --stop-manager --stop-worker` completed
  with zero open accepted criteria and stopped both disposable sessions.
- Final `sessions --state active` returned `[]`, final `reconcile
  --stale-cycles-seconds 1` was clean, and no `codex-qa-compact-clear-audit`
  tmux sessions remained.

Verification:

- `scripts/workerctl mutation-audit qa-compact-clear-audit-receipt --json`
- `scripts/workerctl commands --task qa-compact-clear-audit-receipt --json`
- `scripts/workerctl replay qa-compact-clear-audit-receipt`
- `scripts/workerctl export-task qa-compact-clear-audit-receipt --output
  docs/live-qa-artifacts/2026-05-17-compact-clear-audit-receipt/export --zip`
- `scripts/workerctl sessions --state active`
- `scripts/workerctl reconcile --stale-cycles-seconds 1`
- `tmux list-sessions 2>/dev/null | rg '^codex-qa-compact-clear-audit' || true`

Result:

- The prior compact/clear mutation-audit caveat is live-verified as closed:
  dry-run compact and clear requests now appear on the decision-to-consequence
  audit surface with explicit no-send effect metadata.

## 2026-05-17: Scenario 10 Manager Quality Drill

Scenario:

- Ladder scenario: Scenario 10 manager-quality drill.
- GoalBuddy goal: `docs/goals/manager-quality-drill/goal.md`
- Task: `qa-manager-quality-drill`
- Worker session: `qa-manager-quality-worker`
- Manager session: `qa-manager-quality-manager`
- Evidence root:
  `docs/live-qa-artifacts/2026-05-17-manager-quality-drill/`

Validated:

- Worker made an imperfect "done" claim: no product files changed, product git
  status looked clean, no tests were run, and richer nested Markdown fixture
  coverage was named as a deferred follow-up.
- Three accepted criteria were seeded for the manager-quality evaluation:
  verify worker-supplied test evidence, inspect git status/replay/worker
  capture before choosing a next action, and separate deferred follow-ups from
  current blockers.
- Manager inspected acceptance criteria, `git status --short`, cycle output,
  worker capture, task replay, command history, mutation audit, and worker
  status before choosing an action.
- Manager did not blindly accept the worker's done claim and did not finish the
  task.
- Manager identified missing test evidence as the current-task blocker because
  the worker explicitly said tests were not run and command history contained
  no test command output.
- Manager separated richer nested Markdown fixture coverage as a deferred
  follow-up rather than a current blocker.
- Manager recorded nudge decision `20` before taking the mutating action.
- Manager initially tried legacy `scripts/workerctl nudge`, received `Unknown
  worker`, recovered by discovering `session-nudge`, and successfully nudged
  `qa-manager-quality-worker`.
- Worker confirmed no tests were run and that this should block finish.
- Criteria `34`, `35`, and `36` were satisfied with evidence tied to manager
  decision `20`.
- `finish-task --require-criteria-audit --stop-manager --stop-worker` completed
  with zero open accepted criteria and stopped both disposable sessions.
- Final `sessions --state active` returned `[]`, final `reconcile
  --stale-cycles-seconds 1` was clean, and no `codex-qa-manager-quality` tmux
  sessions remained.

Verification:

- `scripts/workerctl capture qa-manager-quality-manager --lines 340`
- `scripts/workerctl capture qa-manager-quality-worker --lines 180`
- `scripts/workerctl replay qa-manager-quality-drill`
- `scripts/workerctl mutation-audit qa-manager-quality-drill --json`
- `scripts/workerctl commands --task qa-manager-quality-drill --json`
- `scripts/workerctl export-task qa-manager-quality-drill --output
  docs/live-qa-artifacts/2026-05-17-manager-quality-drill/export --zip`
- `scripts/workerctl sessions --state active`
- `scripts/workerctl reconcile --stale-cycles-seconds 1`
- `tmux list-sessions 2>/dev/null | rg '^codex-qa-manager-quality' || true`

Result:

- Scenario 10 passed for the core manager-quality behavior: the manager made an
  evidence-backed nudge decision instead of finishing blindly.
- Follow-up: the legacy `nudge` command path remains discoverability friction
  for managers; manager prompts or CLI aliases should steer managers toward
  `session-nudge` for session-name targets.

## 2026-05-17: Scenario 10 Nudge Friction Follow-Up

Follow-up from:

- `2026-05-17: Scenario 10 Manager Quality Drill`

Resolved:

- Legacy `scripts/workerctl nudge <name> "<text>"` now falls back to
  session-name delivery when no legacy file-backed worker directory exists.
- The fallback records a `session_nudged` event with `legacy_command: "nudge"`,
  preserving the audited session path.
- Manager bootstrap now tells managers to use
  `scripts/workerctl session-nudge <worker> "..."` first for session-bound
  pairs, and frames legacy `nudge` as the old file-backed worker path.
- README documents the same distinction.

Verification:

- Focused regression tests for legacy nudge fallback, `session-nudge`, and the
  manager bootstrap prompt passed.
- Full unittest suite passed: 344 tests.

Result:

- The Scenario 10 command-discoverability friction is resolved by both behavior
  and prompt guidance.

## 2026-05-17: Nudge Fallback Dogfood Drill

Follow-up from:

- `2026-05-17: Scenario 10 Nudge Friction Follow-Up`

Task:

- `qa-nudge-fallback-drill`
- Worker session: `qa-nudge-fallback-worker`
- Manager session: `qa-nudge-fallback-manager`
- Export:
  `docs/live-qa-artifacts/2026-05-17-nudge-fallback-drill/export/`

Validated:

- A disposable manager/worker pair was created after the nudge fallback fix
  landed on `main`.
- Manager config and three accepted criteria were seeded before the manager
  acted.
- The manager inspected cycle output and accepted criteria, then used
  `scripts/workerctl session-nudge qa-nudge-fallback-worker "Please create the
  proof artifact now, then report the path and git status output."`
- The worker waited for the manager nudge before creating
  `.codex-workers/qa-nudge-fallback-worker/manager-nudge-proof.txt`.
- The worker reported the proof path and an empty `git status --short` output.
- The manager verified evidence using cycle output, worker capture, direct file
  existence/content checks, and `git status --short`.
- Criteria `37`, `38`, and `39` were satisfied with structured evidence.
- `finish-task --require-criteria-audit --stop-manager --stop-worker`
  completed with zero open accepted criteria and stopped both disposable
  sessions.

Verification:

- `scripts/workerctl replay qa-nudge-fallback-drill`
- `scripts/workerctl mutation-audit qa-nudge-fallback-drill --json`
- `scripts/workerctl commands --task qa-nudge-fallback-drill --json`
- `scripts/workerctl audit qa-nudge-fallback-drill --json`
- `scripts/workerctl export-task qa-nudge-fallback-drill --output
  docs/live-qa-artifacts/2026-05-17-nudge-fallback-drill/export --zip`
- `scripts/workerctl sessions --state active`
- `scripts/workerctl reconcile --stale-cycles-seconds 1`

Observations:

- The manager initially followed the bootstrap setup-question path because it
  started before the seeded config existed. A PM nudge was enough to make it
  proceed with the already-seeded config, but this is still friction for
  preconfigured manager pairs.
- Post-finish `transcript-capture` fails because the task has no active worker
  or manager. Future live drills that need transcript segments should capture
  them before `finish-task --stop-manager --stop-worker`.

Result:

- The merged session-nudge guidance worked in a live disposable pair: the
  manager chose `session-nudge` first, gathered evidence, satisfied criteria,
  and closed the task without leaving active sessions.

## 2026-05-17: Seeded Pair Smoke

Follow-up from:

- `2026-05-17: Nudge Fallback Dogfood Drill`
- PR #72: seeded `workerctl pair --manager-*` manager config before manager
  launch.

GoalBuddy:

- Goal: `docs/goals/seeded-pair-smoke/goal.md`
- Board: `docs/goals/seeded-pair-smoke/state.yaml`

Task:

- `qa-seeded-pair-smoke`
- Worker session: `qa-seeded-pair-worker`
- Manager session: `qa-seeded-pair-manager`
- Export:
  `docs/live-qa-artifacts/2026-05-17-seeded-pair-smoke/export/`

Validated:

- `scripts/workerctl pair ... --manager-objective ... --manager-guideline ...
  --manager-acceptance ...` created a disposable pair and reported
  `manager_config_seeded=true` and `manager_config_seeded_by_pair=true`.
- The manager bootstrap said manager config had already been recorded and told
  the manager to start with
  `scripts/workerctl cycle qa-seeded-pair-smoke`.
- The manager did not ask setup questions first. Its first supervision action
  included `scripts/workerctl cycle qa-seeded-pair-smoke`, and cycle output
  included populated `manager_context.manager_config`.
- Cycle output initially had zero durable accepted criteria rows even though
  `manager_config.acceptance_criteria` was populated.
- The manager inferred durable criteria from manager config, used
  `session-nudge` to ask the worker for a proof artifact, verified the worker
  proof, satisfied criteria `40`, `41`, `42`, and `43`, and ran
  `finish-task --require-criteria-audit --stop-manager --stop-worker`.
- The worker waited for the manager nudge before creating
  `.codex-workers/qa-seeded-pair-worker/seeded-pair-proof.txt`.
- The worker reported the proof path and `git status --short` output. The only
  visible status output was the PM-created untracked
  `docs/goals/seeded-pair-smoke/` goal state; the worker artifact remained
  under ignored `.codex-workers/`.
- Final `sessions --state active` returned `[]`, and final
  `reconcile --stale-cycles-seconds 1` was clean.

Verification:

- `scripts/workerctl replay qa-seeded-pair-smoke`
- `scripts/workerctl criteria qa-seeded-pair-smoke --list`
- `scripts/workerctl mutation-audit qa-seeded-pair-smoke --json`
- `scripts/workerctl audit qa-seeded-pair-smoke --json`
- `scripts/workerctl export-task qa-seeded-pair-smoke --output
  docs/live-qa-artifacts/2026-05-17-seeded-pair-smoke/export --zip`
- `scripts/workerctl sessions --state active`
- `scripts/workerctl reconcile --stale-cycles-seconds 1`

Observations:

- Core seeded-manager startup behavior passed: pre-seeded `pair` config changed
  the manager startup path from setup questions to `cycle`.
- The manager initially tried to add durable criteria with invalid source
  `manager_config`; the CLI only accepts `final_audit`, `manager_inferred`,
  `user_requested`, and `worker_proposed`. A PM recovery nudge told the manager
  to use `manager_inferred`, after which it recovered.
- Transcript capture was missed again: `transcript-capture` ran after
  `finish-task` stopped both sessions, so exported `transcript-captures.json`
  and `terminal-captures.json` are empty. The audit/replay/criteria evidence is
  durable. Follow-up product work added `finish-task
  --capture-transcript-before-stop`, which captures transcript segments for any
  worker/manager sessions being stopped before killing tmux sessions.

Result:

- The seeded-pair startup fix is validated for the main dogfood behavior.
- Follow-up candidates: document or encode `manager_inferred` as the expected
  source for manager-config-derived criteria, and use the pre-stop transcript
  capture option in the next seeded-pair smoke.
