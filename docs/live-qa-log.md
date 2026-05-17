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
