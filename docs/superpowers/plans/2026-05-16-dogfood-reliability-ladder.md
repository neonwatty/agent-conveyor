# Dogfood Reliability Ladder

Date: 2026-05-16

## Purpose

Before using `codex-terminal-manager` on important project work, run a staged
dogfood ladder that validates the manager loop, guardrails, failure recovery,
and replayability on tasks where failure is cheap.

The app is currently ready for supervised manual dogfooding, but not yet for
blind unattended project management. These scenarios are intended to move it
toward higher confidence without risking valuable work that would be painful to
recover from.

The plan is shaped so it can drive future `/goal` and GoalBuddy execution. Each
scenario has an objective, required evidence, acceptance criteria, and stop
conditions. A GoalBuddy board created from this plan should treat each scenario
as a bounded Worker or Judge task with a durable receipt.

## Product Thesis Under Test

The ladder should prove more than "workerctl commands work." It should prove the
manager workflow that motivates the app:

- A manager can observe a worker whose task cannot be fully planned up front.
- A manager can nudge the worker at the right time without taking over the work.
- Useful acceptance criteria can emerge progressively from worker discoveries,
  not only from the initial user prompt.
- The manager can separate current-task blockers from deferred follow-up ideas.
- The manager can refuse premature "done" claims until there is evidence.
- Manager decisions, nudges, criteria changes, recovery actions, and finish
  decisions are durable enough to replay and audit later.

## Readiness Baseline

Run and record this baseline before any scenario:

```bash
scripts/workerctl doctor
scripts/workerctl db-doctor
scripts/workerctl sessions --state active
scripts/workerctl reconcile --stale-cycles-seconds 1
tmux list-sessions 2>/dev/null || true
git status --short --branch
python3 -m unittest discover -s tests -v
```

Current observed baseline:

- `workerctl doctor` passes for `tmux`, `codex`, tmux version, Codex version,
  target cwd, and state root.
- `workerctl sessions --state active` returns no active sessions.
- `workerctl reconcile --stale-cycles-seconds 1` reports no dead PID sessions,
  dangling bindings, or stuck tasks.
- The dependency-free unit suite passes.
- The intended baseline is a clean `main` branch. At the time this plan was
  drafted, this plan file itself was an untracked change and should be committed
  or explicitly accounted for before live QA starts.

Known caveats:

- The manager is still an LLM following a tool protocol, not a daemon with every
  policy decision mechanically enforced.
- Emergent criteria are functional, and the first read-only `criteria-plan`
  helper exists to reduce manual prose-to-command extraction. It still requires
  manager review before any suggested criteria commands are run.
- The tmux error path has a recorded live QA pass; the emergent-criteria path
  still needs a complete recorded real-pair QA pass.
- The test suite currently passes with Python `ResourceWarning` noise for
  unclosed SQLite connections.
- Real dogfood remains supervised only: no overnight unattended manager runs, no
  auto-merge, no destructive commands, and no important work without a recovery
  branch or checkpoint.

## Required Evidence Bundle

Every scenario should write or reference an evidence bundle. Use a path like:

```text
docs/live-qa-artifacts/YYYY-MM-DD-<scenario-slug>/
```

Minimum evidence:

- `commands.log`: exact commands run, in order.
- `preflight.txt`: readiness baseline output.
- `postflight.txt`: cleanup invariant output.
- `cycle-*.json`: raw `workerctl cycle` JSON outputs.
- `criteria-*.json` or `criteria-*.txt`: criteria state before and after
  mutations.
- `replay.txt` or `replay.json`: replay output after the scenario.
- `export/`: `workerctl export-task` output when a task exists.
- `git-status-before.txt` and `git-status-after.txt`.
- `tmux-before.txt` and `tmux-after.txt`.
- `verdict.md`: pass/fail, findings, fixes needed, and whether the scenario
  unlocks the next promotion gate.

When a scenario involves a manager decision, record the relevant decision id,
criterion id, nudge event, mutation audit entry, or replay line that proves it.

## Global Stop Conditions

Stop the current scenario immediately and record a failed receipt if any of
these occur:

- `git status --short` shows unexpected tracked changes.
- `workerctl cycle` emits malformed JSON.
- `workerctl cycle` omits `manager_context`, liveness, or pane signal fields.
- Pane capture is degraded without an expected and documented reason.
- A mutating command exits nonzero but audit/replay later implies success.
- A task reaches finish while accepted criteria remain open and audited finish
  was required.
- Cleanup leaves matching tmux sessions, active test sessions, dangling
  bindings, dead PID sessions, or stuck tasks.
- The manager loops with repeated generic nudges instead of making a concrete
  wait, nudge, interrupt, clarify, defer, or finish decision.
- A scenario requires destructive or high-risk action not explicitly authorized
  in `manager-config`.

## Reusable Postflight Invariants

Run after every scenario:

```bash
scripts/workerctl sessions --state active
tmux list-sessions 2>/dev/null || true
scripts/workerctl reconcile --stale-cycles-seconds 1
git status --short --branch
```

Acceptance criteria:

- No active sessions remain unless the scenario explicitly keeps a named pair
  alive for the next scenario.
- No scenario-prefixed tmux sessions remain after cleanup.
- `reconcile` reports no dangling bindings, dead PID sessions, or stuck tasks.
- Git status matches the scenario expectation: clean for status-only tests,
  expected tracked diff only for disposable edit tests.

## Scenario 1: Status-Only Pair QA

Objective:

Verify that a real worker/manager pair can start, cycle, nudge, and clean up
without tracked-file edits.

Source:

```bash
scripts/workerctl qa-plan emergent-criteria
```

Run only the status-only portions first if we want the smallest possible live
test.

Acceptance criteria:

- `workerctl pair` starts both sessions and binds them to one task.
- First `workerctl cycle <task>` returns parseable JSON with:
  - `worker_alive == true`
  - `manager_alive == true`
  - `pane_signal` present
  - `manager_context` present
  - `manager_context.acceptance_criteria` present
- The manager sends at least one nudge through the audited path.
- Replay or audit shows the nudge without claiming unrelated success.
- Cleanup satisfies all reusable postflight invariants.
- `git status --short --branch` remains clean except for pre-existing approved
  planning-doc changes.

Stop conditions:

- The worker edits tracked files.
- Either session fails to start or bind.
- `cycle` cannot capture enough state for a manager decision.

GoalBuddy task shape:

- Type: Worker.
- Allowed files: evidence bundle and `docs/live-qa-log.md` only.
- Verify: postflight invariants plus replay/audit receipt.

## Scenario 2: Emergent Criteria Negotiation QA

Objective:

Validate the highest-value product behavior: criteria are discovered during
supervision, recorded as accepted or deferred, audited before finish, and
visible in replay/export.

Initial run:

Have the worker inspect docs/help and propose must-have current-task criteria
versus deferred follow-up criteria.

Manager-led variant:

The manager session, not the human operator, should run `cycle`, notice
`criteria_negotiation.needed`, ask the worker for criteria, decide which
criteria are current-task must-haves, defer follow-ups, and attempt audited
finish only after proof exists.

Progressive-disclosure variant:

Start with incomplete criteria. Let the worker discover an additional edge case
mid-task. The manager should add or revise criteria after that discovery.

Acceptance criteria:

- First `cycle` shows `manager_context.criteria_negotiation.needed == true`
  with reason `no_criteria`.
- The manager asks the worker for criteria when negotiation is needed.
- At least one worker-proposed must-have is recorded with status `accepted`.
- At least one follow-up is recorded with status `deferred` and a rationale.
- A later `cycle` shows accepted criteria in `open` and deferred criteria in
  `deferred`.
- After active criteria exist, `criteria_negotiation.needed == false`.
- Premature `finish-task --require-criteria-audit` exits nonzero while accepted
  criteria are open.
- Each satisfied criterion has proof text and structured evidence JSON.
- `criteria --list` shows zero open accepted criteria before final finish.
- `replay` shows `acceptance_criterion_added` and
  `acceptance_criterion_updated` transitions in chronological order.
- `export-task` writes `acceptance-criteria.json`, and `manifest.json` lists it.
- Final `finish-task --require-criteria-audit --stop-manager --stop-worker`
  reports both sessions stopped.

Stop conditions:

- The manager records vague criteria that cannot be verified.
- The manager accepts follow-up ideas as current-task blockers without a reason.
- The manager finishes despite open accepted criteria.
- Replay/export omit criteria transitions or evidence.

GoalBuddy task shape:

- Type: Worker for live execution, followed by Judge for receipt review.
- Worker allowed files: evidence bundle and `docs/live-qa-log.md`.
- Judge expected output: pass/fail, missing evidence, and whether Gate 2 is
  unlocked.

## Scenario 3: Adversarial Manager Judgment QA

Objective:

Test whether the manager can handle weak, premature, or overbroad worker output
instead of blindly accepting it.

Worker behaviors to induce:

- Claims "done" with vague proof.
- Proposes only broad or unverifiable criteria.
- Mixes must-have criteria with follow-up polish.
- Omits verification commands.
- Reports a discovered edge case without saying whether it blocks the current
  task.

Acceptance criteria:

- The manager asks a clarifying question or requests proof instead of finishing.
- Broad items are rejected or deferred with rationale.
- Current-task blockers are recorded as accepted criteria.
- Missing verification becomes either an accepted criterion or an explicit
  deferred follow-up with rationale.
- The manager records a decision before any finish, interrupt, compact, or clear
  action.
- Replay/audit makes the manager's reasoning and action sequence clear.

Stop conditions:

- The manager treats "done" as sufficient without criteria, tests, git state, or
  replay/capture evidence.
- The manager creates unbounded criteria that cannot be satisfied in the current
  task.

GoalBuddy task shape:

- Type: Judge or Worker+Judge depending on whether this is replay-based or live.
- Expected output: manager-quality rubric score and concrete product findings.

## Scenario 4: Disposable Edit Task

Objective:

Use a throwaway repo or disposable branch to prove the manager can supervise
actual edits, verification, and evidence without auto-merging or hiding drift.

Example task shapes:

- Add one CLI help line.
- Add one README paragraph.
- Add one small unit test in a toy file.

Acceptance criteria:

- The task runs in a disposable branch or throwaway repo.
- The manager initializes `manager-config` with explicit objective,
  non-goals, references, acceptance criteria, and permissions.
- The worker reports changed files and verification commands.
- The manager compares worker proof against accepted criteria.
- The manager notices missing tests, unclear proof, or unexpected diff.
- The manager does not merge automatically unless `manager-config` explicitly
  allows it and the user has approved.
- Replay/export preserve task evidence and final decision.
- Postflight git state contains only the expected disposable diff or is cleaned
  up intentionally.

Stop conditions:

- The worker touches files outside the disposable scope.
- The manager approves completion without inspecting diff and verification.
- The manager attempts merge or destructive git action without permission.

GoalBuddy task shape:

- Type: Worker.
- Allowed files: disposable target files plus evidence bundle.
- Verify: target-specific test command, `git diff --check`, replay/export check.

## Scenario 5: Intentional Blocker Task

Objective:

Verify that the worker and manager handle blocked work honestly rather than
pretending completion or looping indefinitely.

Example blockers:

- Ask the worker to run a nonexistent test command.
- Ask the worker to inspect a file that does not exist.
- Ask the worker to use a dependency that is unavailable.

Acceptance criteria:

- The worker reports a blocked state or the manager infers one from evidence.
- The manager identifies the blocker in a recorded decision or nudge rationale.
- The manager asks a clarifying or narrowing question when appropriate.
- The manager does not repeat more than one generic nudge after the blocker is
  known.
- Replay shows the blocker, manager response, and final blocked or narrowed
  state.

Stop conditions:

- The manager continues nudging without changing strategy.
- The worker claims completion after a failed prerequisite and the manager
  accepts it.

GoalBuddy task shape:

- Type: Worker for live test, Judge for blocker-response assessment.
- Expected output: blocker classification, manager decision, replay evidence.

## Scenario 6: Long-Running Or Quiet Task Simulation

Objective:

Make liveness and nudge timing measurable, not vibes-based.

Use controlled worker commands or prompts that create:

- Sparse but legitimate output.
- Frequent progress output.
- A stuck busy-wait pattern.

Acceptance criteria:

- Evidence records cycle interval, `staleness_seconds`, recent event count,
  `pane_signal.degraded`, and any notable pane pattern.
- With recent progress, the manager waits and records why.
- After a defensible threshold, the manager sends a specific status nudge rather
  than a generic one.
- `cycle --busy-wait-seconds` changes the classification in the expected
  direction.
- Interrupt is used only when wait/nudge criteria are exhausted and a decision
  is recorded.

Stop conditions:

- Legitimate quiet work is interrupted too early.
- The manager sends repeated generic nudges.
- The scenario cannot distinguish quiet progress from stuck state in evidence.

GoalBuddy task shape:

- Type: Worker.
- Verify: captured cycle JSONs demonstrating threshold behavior.

## Scenario 7: Failure Recovery Drill

Objective:

Verify that killed sessions, stale bindings, and partial lifecycle failures are
reported, recoverable, and not recorded as successful work.

Use isolated `WORKERCTL_STATE_ROOT` for destructive or synthetic variants.

Failure cases:

- Kill the worker tmux session mid-task.
- Kill the manager tmux session mid-task.
- Simulate missing or permission-denied tmux.
- Simulate stale tmux session name or pane mismatch.
- Exercise pair partial failure where worker creation succeeds but manager spawn
  or bind fails.
- Exercise malformed, missing, truncated, or shrinking rollout JSONL.

Acceptance criteria:

- `workerctl cycle` reports dead or degraded worker/manager state correctly.
- `workerctl reconcile` detects drift.
- `workerctl reconcile --apply` cleans stale state when applied.
- Replay/export still explain what happened.
- Failed mutating actions do not record fake success events.
- Partial pair failures either clean up automatically or produce a precise
  recovery path.

Stop conditions:

- A failed command creates a misleading success audit event.
- Reconcile cannot explain or clean the stale state.
- Failure injection contaminates the default live state root.

GoalBuddy task shape:

- Type: Worker.
- Allowed files: evidence bundle and live QA log.
- Verify: isolated state root cleanup plus default state root postflight.

## Scenario 8: Guardrail Drill

Objective:

Attempt actions that should fail closed and prove the error path is actionable
and auditable.

Examples:

- Compact or clear without manager permission.
- Compact or clear without a worker handoff.
- Finish with open accepted criteria.
- Deregister a bound active session.
- Open a second terminal window without `--force`.
- Interrupt or finish without a recorded manager decision where policy requires
  one.

Acceptance criteria:

- Dangerous or lifecycle-changing commands require explicit setup.
- Error messages name the missing permission, handoff, criterion, binding, or
  state requirement.
- The audit trail records attempted failures accurately and does not imply
  success.
- `mutation-audit` links risky successful actions to manager decisions when
  applicable.

Stop conditions:

- Any dangerous command succeeds without the required setup.
- Any failed guardrail command leaves active-session, binding, or audit drift.

GoalBuddy task shape:

- Type: Worker for command execution, Judge for guardrail review.
- Verify: stderr/stdout receipts, audit, mutation audit, postflight invariants.

## Scenario 9: Resume And Handoff Dogfood

Objective:

Validate the long-running workflow where management survives compaction,
handoff, or resumed supervision.

Acceptance criteria:

- A worker handoff is recorded with current status, next steps, and known risks.
- The manager can use `replay`, `export-task`, `handoff`, and criteria state to
  resume without relying on live chat memory.
- If compact/clear is used, manager permission and worker handoff requirements
  are satisfied first.
- After resume, the manager can identify the next action and any open criteria.
- Replay/export explain the handoff and resumed decision sequence.

Stop conditions:

- Resume depends on unstored chat context.
- Compact/clear occurs without permission or handoff.
- Open criteria or blockers disappear across handoff.

GoalBuddy task shape:

- Type: Worker followed by Judge.
- Expected Judge output: whether durable state was enough to resume safely.

## Scenario 10: Manager Quality Drill

Objective:

Give the manager a real but small worker output and evaluate whether it chooses
the next action well.

Acceptance criteria:

- The manager does not blindly accept the worker's "done" claim.
- The manager checks criteria, tests, git status, replay, and capture evidence.
- The manager separates follow-ups from current-task blockers.
- The manager records decisions before mutating actions where appropriate.
- The manager chooses one of: wait, nudge, interrupt, ask user, defer follow-up,
  add criterion, satisfy criterion, or finish, with a clear reason.

Stop conditions:

- The manager cannot name the evidence behind its next action.
- The manager chooses a mutating action without checking permission and current
  task state.

GoalBuddy task shape:

- Type: Judge.
- Expected output: manager decision quality score, missing evidence, and next
  improvement task if quality is insufficient.

## Promotion Gates

Gate 1: Status-only readiness

- Scenario 1 passes.
- Evidence bundle and `docs/live-qa-log.md` entry exist.
- Postflight invariants pass.

Gate 2: Emergent criteria readiness

- Scenario 2 passes with a real manager-led run.
- Criteria transitions are visible in replay/export.
- A Judge or PM receipt says the manager handled current-task versus deferred
  criteria correctly.

Gate 3: Disposable edit readiness

- Scenario 4 passes on a throwaway repo or branch.
- The manager catches or explicitly rules out missing proof.
- No merge or destructive action occurs without permission.

Gate 4: Recovery readiness

- Scenarios 5, 7, and 8 pass.
- Failure drills use isolated state roots where appropriate.
- No fake success events appear in audit or replay.

Gate 5: Meaningful supervised dogfood

- Gates 1 through 4 pass.
- Scenario 9 passes or is intentionally deferred with rationale.
- The `criteria-plan` helper is implemented or the manual criteria extraction
  risk is explicitly accepted.

Only after Gate 5 should the app be used on meaningful branch-scoped tasks.
Even then, require human review before merge and avoid unattended overnight
management.

## Implementation Backlog For Plan Reliability

These are likely development tasks that can be driven by `/goal` or GoalBuddy:

1. Add `criteria-plan` as a read-only helper that converts worker prose into
   proposed `criteria` commands without mutating DB state. ✅
2. Add a `qa-run` or script harness for at least `emergent-criteria` that writes
   structured check results to an artifact directory.
3. Add JSON output modes where missing for replay, criteria list, export
   manifest checks, and mutation audit checks.
4. Add reusable preflight/postflight invariant commands or a `qa-doctor`
   wrapper.
5. Add stricter replay/export assertions for acceptance criteria transitions and
   manager context.
6. Fix SQLite `ResourceWarning` noise so lifecycle warnings do not mask session
   manager bugs.

## Recommended Next Steps

1. Commit this revised plan so the readiness baseline can return to a clean
   `main`.
2. Implement or finish the planned `criteria-plan` helper if we want to reduce
   manager judgment before heavier dogfood.
3. Run Scenario 1 and the deterministic portion of Scenario 2, recording the
   evidence bundle and a `docs/live-qa-log.md` entry.
4. Run the manager-led Scenario 2 variant with a real pair.
5. Fix findings before moving to disposable edit work.

For GoalBuddy execution, seed the first tranche as:

- Scout: map exact commands and missing JSON modes needed for Scenario 1 and
  Scenario 2 assertions.
- Judge: decide whether `criteria-plan` or real-pair QA should come first.
- Worker: implement the first safe helper or run the first scenario, bounded to
  the relevant files and evidence directories.
- Judge: audit whether the promotion gate is actually unlocked.
