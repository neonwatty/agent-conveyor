# Codex + Chrome QA: Managed Ralph Loop

Use this task to test a repeated manager-led delivery loop across worker
completion, what-remains probing, PR creation, CI monitoring/fixing, green
merge, audited handoff, worker context clear, and same-prompt replay.

Shared protocol: [shared-codex-chrome-protocol.md](shared-codex-chrome-protocol.md)

## Scenario

- `workerctl qa-plan ralph-loop`
- Target repo: a disposable repo with real or simulated CI.
- Seed prompt: supplied by the operator and reused exactly for every iteration.
- Default max iterations: `2`.
- Required manager permissions: `repo.open_pr`, `repo.merge_green_pr`, and
  `worker_compact_clear`.
- Dispatch role: mechanical routing/execution only. The manager decides PR
  readiness, CI-fix routing, merge readiness, and whether another iteration is
  useful.
- Correlation strategy: use stable `ralph-iter-*` ids in manager decision
  payloads, epilogues, handoff payloads, command receipts, audit/replay output,
  and telemetry summaries where those markers are emitted.

## Start

Pick a disposable target repo and seed prompt. Then print the canonical CLI
checklist:

```bash
scripts/workerctl qa-plan ralph-loop
```

Start Dispatch if it is not already active:

```bash
scripts/workerctl dispatch --watch --dispatcher-id qa-ralph-loop
```

Record the exact seed prompt hash before iteration 1:

```bash
SEED_PROMPT_SHA256="$(printf '%s' "$SEED_PROMPT" | shasum -a 256 | awk '{print $1}')"
```

Create the first managed pair with the seed prompt:

```bash
scripts/workerctl pair \
  --task qa-ralph-loop-iter-1 \
  --worker-name qa-ralph-worker-1 \
  --manager-name qa-ralph-manager \
  --cwd "$TARGET_REPO" \
  --task-goal "Managed Ralph loop iteration 1" \
  --task-summary "PR/CI/merge/context-clear QA" \
  --task-prompt "$SEED_PROMPT" \
  --accept-trust
```

Use `--accept-trust` only for a disposable repo you intentionally trust. Without
it, a fresh Codex session can pause at the workspace trust prompt before
worker/manager registration completes.

The seed prompt should get the worker through implementation, local
verification, branch evidence, and a receipt. It should not ask the worker to
open or merge a PR by itself; PR creation is a manager-routed action after the
`repo.open_pr` permission and PR-readiness decision are recorded.

## Required Loop

Run at least two iterations. Each iteration must include:

- worker completion consumed by a manager cycle
- a manager what-remains or next-useful-slice probe after completion
- accepted criteria closure with verification evidence
- PR action gated by `repo.open_pr`
- CI monitoring, with one iteration exercising a failed or simulated-failed CI
  path and a manager-routed fix
- green merge gated by `repo.merge_green_pr`
- handoff before any worker clear
- context clear gated by `worker_compact_clear`

Iteration 2 must replay the same seed prompt after the worker context clear
receipt. The standard smoke uses a fresh worker for iteration 2, so it proves
fresh-worker isolation plus the audited clear receipt, not same-session clear
semantics.

## Liveness Receipts

At each PR, CI-fix, merge, handoff, and clear checkpoint, capture both the
task-scoped worker/manager liveness view and the latest dispatch heartbeat:

```bash
scripts/workerctl telemetry task qa-ralph-loop-iter-1 --json
scripts/workerctl telemetry --event-type dispatch_watch_heartbeat --newest --limit 1 --json
```

Preserve the `worker_alive`, `manager_alive`, latest-cycle, and dispatch
heartbeat fields with the same `ralph-iter-*` correlation marker used for that
phase. This is the audit link between the manager dispatcher, worker dispatcher,
and the worker/manager sessions.

## Correlation Markers

Use these marker names consistently so replay, audit, command receipts, PR
receipts, handoffs, and clear receipts can be connected after the run:

- `ralph-iter-1-pr`: PR-readiness decision, PR action, separate PR URL
  evidence, and manager consumption
- `ralph-iter-1-ci`: CI monitor command, CI result, and manager CI decision
- `ralph-iter-1-ci-fix`: forced or simulated CI failure, CI-fix nudge, worker
  fix receipt, and updated PR
- `ralph-iter-1-merge`: green-CI merge permission check, manager merge
  decision, and merge receipt
- `ralph-iter-1-clear`: handoff, `compact-worker --clear` request, and worker
  clear receipt
- `ralph-iter-2-replay`: same seed prompt replay, fresh-worker isolation proof,
  and iteration 2 first completion
- `ralph-loop-max-block`: max-iteration refusal drill, manager continuation
  request, blocked Dispatch attempt, dashboard row, and empty worker inbox proof

When a command does not accept `--correlation-id`, include the marker in
`--payload-json` under `ralph_loop.correlation_id`.

## Max-Iteration Refusal Drill

Run this negative browser QA case in a disposable bound task to prove Dispatch
cuts off an invalid manager continuation before worker delivery. The fixture
uses `max_iterations=1` and `current_iteration=1`, then asks for iteration 2.

Create a Ralph-loop run record:

```bash
RALPH_LOOP_RUN_ID="$(scripts/workerctl runs \
  --create qa-ralph-loop-guardrail \
  --name qa-ralph-loop-max-block \
  --purpose ralph_loop \
  --metadata-json '{"kind":"ralph_loop","max_iterations":1,"current_iteration":1,"cleanup_policy":"clear","stop_conditions":["max_iterations"],"seed_prompt_sha256":"<seed-sha256>"}' \
  --path "$WORKERCTL_DB" | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')"
```

Record the manager request for one more iteration:

```bash
MANAGER_DECISION_ID="$(scripts/workerctl record-decision qa-ralph-loop-guardrail nudge \
  --reason "Manager requests iteration 2 for max-iteration refusal QA." \
  --payload-json "{\"ralph_loop_run_id\":\"$RALPH_LOOP_RUN_ID\",\"requested_iteration\":2,\"correlation_id\":\"ralph-loop-max-block\"}" \
  --path "$WORKERCTL_DB" | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')"
```

Queue and dispatch the continuation request:

```bash
scripts/workerctl enqueue-continue-iteration qa-ralph-loop-guardrail \
  --loop-run "$RALPH_LOOP_RUN_ID" \
  --requested-iteration 2 \
  --manager-decision-id "$MANAGER_DECISION_ID" \
  --correlation-id ralph-loop-max-block \
  --message "Run iteration 2." \
  --json \
  --path "$WORKERCTL_DB"

scripts/workerctl dispatch \
  --once \
  --type continue_iteration \
  --dispatcher-id qa-ralph-loop \
  --json \
  --path "$WORKERCTL_DB"
```

Required dispatch result fields:

- `state=blocked`
- `reason=max_iterations_reached`
- `delivered=false`
- `target_worker_notified=false`
- `current_iteration=1`
- `max_iterations=1`
- `requested_iteration=2`
- no routed notification id

Open the dashboard for the bound task and verify the Dispatch panel shows
`continue_iteration`, `max_iterations_reached`, `iteration 1/1`,
`0 notifications`, `Inbox 0`, and `Pull inbox 0` for
`ralph-loop-max-block`.

Then verify the non-delivery evidence from the CLI:

```bash
scripts/workerctl replay qa-ralph-loop-guardrail
scripts/workerctl audit qa-ralph-loop-guardrail --json --path "$WORKERCTL_DB"
scripts/workerctl commands --task qa-ralph-loop-guardrail --attempts --json --path "$WORKERCTL_DB"
scripts/workerctl worker-inbox qa-ralph-loop-guardrail --json --path "$WORKERCTL_DB"
```

The manager-visible refusal receipt must appear in command output, replay, or
audit. The worker inbox must remain empty for the blocked continuation.

## Permission Checks

Before enabling permissions, verify the manager permission gates fail closed:

```bash
scripts/workerctl manager-permission qa-ralph-loop-iter-1 repo.open_pr --require
scripts/workerctl manager-permission qa-ralph-loop-iter-1 repo.merge_green_pr --require
scripts/workerctl manager-permission qa-ralph-loop-iter-1 worker_compact_clear --require --require-handoff
```

Then enable the allowed run explicitly:

```bash
scripts/workerctl manager-config qa-ralph-loop-iter-1 \
  --allow-pr \
  --allow-merge-green \
  --allow-worker-compact-clear \
  --epilogue draft-pr \
  --epilogue record-handoff \
  --tool verification.run_tests \
  --tool context.fetch_prs
```

## Decision Receipts

Record manager decisions with the iteration marker in structured payloads:

```bash
scripts/workerctl record-decision qa-ralph-loop-iter-1 inspect \
  --reason "Iteration 1 is PR-ready after criteria and verification evidence." \
  --payload-json "{\"ralph_loop\":{\"iteration\":1,\"phase\":\"pr\",\"correlation_id\":\"ralph-iter-1-pr\",\"seed_prompt_sha256\":\"$SEED_PROMPT_SHA256\"}}"

scripts/workerctl epilogue qa-ralph-loop-iter-1 \
  --step draft-pr \
  --correlation-id ralph-iter-1-pr
```

The `draft-pr` epilogue is a PR-readiness checkpoint. Record the actual PR URL
separately, for example as accepted criterion evidence:

```bash
PR_URL_CRITERION_ID="$(scripts/workerctl criteria qa-ralph-loop-iter-1 \
  --add \
  --criterion "Iteration 1 PR URL is recorded" \
  --source manager_inferred \
  --status accepted | python3 -c 'import json,sys; print(json.load(sys.stdin)["affected_criterion"]["id"])')"

scripts/workerctl criteria qa-ralph-loop-iter-1 \
  --satisfy "$PR_URL_CRITERION_ID" \
  --evidence-json "{\"correlation_id\":\"ralph-iter-1-pr\",\"pr_url\":\"<url>\"}"
```

Route the PR action through the manager-to-worker channel after the readiness
decision:

```bash
scripts/workerctl session-nudge qa-ralph-worker-1 \
  "correlation_id=ralph-iter-1-pr; open the PR now, then report the PR URL and evidence."
```

For the forced or simulated CI failure path:

```bash
scripts/workerctl record-decision qa-ralph-loop-iter-1 nudge \
  --reason "CI failed; route a focused CI-fix retry to the worker." \
  --payload-json "{\"ralph_loop\":{\"iteration\":1,\"phase\":\"ci_fix\",\"correlation_id\":\"ralph-iter-1-ci-fix\",\"seed_prompt_sha256\":\"$SEED_PROMPT_SHA256\"}}"
```

Then route the retry with `session-nudge`, not the legacy task-scoped `nudge`
path:

```bash
scripts/workerctl session-nudge qa-ralph-worker-1 \
  "correlation_id=ralph-iter-1-ci-fix; inspect CI, push a fix, and report the fresh CI URL."
```

For the green merge decision:

```bash
scripts/workerctl record-decision qa-ralph-loop-iter-1 inspect \
  --reason "CI is green and repo.merge_green_pr permission is present." \
  --payload-json "{\"ralph_loop\":{\"iteration\":1,\"phase\":\"merge\",\"correlation_id\":\"ralph-iter-1-merge\",\"seed_prompt_sha256\":\"$SEED_PROMPT_SHA256\"}}"
```

Before running any merge command, verify the disposable target has required
checks or branch protection configured, or explicitly verify all required jobs
are green:

```bash
gh pr checks "$PR_NUMBER" --repo "$TARGET_REPO_SLUG" --required
```

Do not treat `gh pr merge --auto` as a green gate by itself. On an unprotected
repo with no required checks, GitHub can merge immediately.

## Finish Gates

`finish-task --require-criteria-audit --require-epilogue` directly gates
accepted criteria and configured epilogues. It does not inspect CI or merge
systems by itself, so the run must represent PR URL, CI result, merge result,
handoff, and clear proof as accepted criteria with evidence or as explicit
decision, handoff, command, or evidence-template receipts before final finish.
Before those accepted criteria or epilogues are complete, finish must fail:

```bash
scripts/workerctl finish-task qa-ralph-loop-iter-1 \
  --reason "Premature Ralph loop finish should fail" \
  --require-criteria-audit \
  --require-epilogue
```

Only finish after all accepted criteria are satisfied, the configured epilogues
are complete, and the required PR/CI, merge, handoff, and clear evidence exists
in the run receipts.

## Clear And Replay

Record the handoff:

```bash
scripts/workerctl handoff qa-ralph-loop-iter-1 \
  --summary "Iteration 1 merged; replay same seed prompt after clear." \
  --next-step "Start iteration 2 after audited clear in fresh-worker isolation." \
  --payload-json "{\"iteration\":1,\"pr\":\"<url>\",\"ci\":\"green\",\"merge\":\"merged\",\"clear_correlation_id\":\"ralph-iter-1-clear\",\"seed_prompt_sha256\":\"$SEED_PROMPT_SHA256\",\"correlation_ids\":[\"ralph-iter-1-pr\",\"ralph-iter-1-ci\",\"ralph-iter-1-ci-fix\",\"ralph-iter-1-merge\",\"ralph-iter-1-clear\"]}"
```

Clear through the audited path:

```bash
scripts/workerctl compact-worker qa-ralph-loop-iter-1 \
  --clear \
  --reason "Clear worker context between Ralph loop iterations; correlation_id=ralph-iter-1-clear" \
  --message "correlation_id=ralph-iter-1-clear; clear worker context between Ralph loop iterations after saved handoff"
```

Start iteration 2 with a fresh task, worker, and manager name and the exact same
seed prompt. Include `--accept-trust` again for trusted disposable repos. Capture
the initial pane/transcript and confirm it does not reference stale iteration 1
chat state. Pair this with the iteration 1 clear command receipt; the standard
smoke proves fresh-worker isolation after audited clear, not same-session clear
semantics.

## Evidence Bundle

For each iteration, capture:

```bash
scripts/workerctl replay "$TASK"
scripts/workerctl audit "$TASK" --json
scripts/workerctl commands --task "$TASK" --json
scripts/workerctl telemetry --task "$TASK" --json
scripts/workerctl telemetry --task "$TASK" --summary --json
scripts/workerctl export-task "$TASK" --zip --include-transcripts
```

Required evidence:

- replay and audit for both iterations
- per-checkpoint liveness receipts for PR, CI-fix, merge, handoff, and clear
- telemetry summary for PR, CI monitor/fix, merge, handoff, and clear routing
- marker lookups in audit, replay, commands, decision payloads, epilogue
  payloads, handoff payloads, and command receipts
- PR URLs
- CI result and CI-fix retry evidence
- merge result
- worker clear receipt
- proof that iteration 2 used the same seed prompt in fresh-worker isolation
  after the audited clear receipt

Use this per-iteration evidence shape in the final report:

```json
{
  "iteration": 1,
  "seed_prompt_sha256": "<sha256 of exact seed prompt>",
  "manager_cycle_ids": [],
  "worker_completion_event_ids": [],
  "manager_decision_ids": {
    "pr_ready": null,
    "ci_fix": null,
    "merge_green": null,
    "continue_or_stop": null
  },
  "dispatch_correlation_ids": [
    "ralph-iter-1-pr",
    "ralph-iter-1-ci",
    "ralph-iter-1-ci-fix",
    "ralph-iter-1-merge",
    "ralph-iter-1-clear"
  ],
  "pr_url": "<url>",
  "ci": {
    "provider": "<github-actions|simulated>",
    "initial_result": "<green|failed|simulated_failed>",
    "fix_result": "<green|not_needed>"
  },
  "merge": {
    "permitted": false,
    "result": "<merged|not_merged>"
  },
  "handoff_id": null,
  "clear_receipt": {
    "command_id": null,
    "correlation_id": "ralph-iter-1-clear"
  }
}
```

## Chrome Checks

- Dispatch banner shows active.
- Relationship state is visible and is not `none`.
- Each worker completion routes as `worker_task_complete`.
- Manager cycles consume worker completions before decisions.
- PR, CI, merge, handoff, and clear transitions appear in the Dispatch
  conversation, dashboard evidence, or audit output.
- Iteration 2 appears as a fresh managed task after the clear receipt.
- The max-iteration refusal drill shows `max_iterations_reached`, iteration
  `1/1`, `0 notifications`, `Inbox 0`, and `Pull inbox 0`.
- Task state reaches `done` only after criteria and epilogue gates are closed.

## Cleanup

Clean up disposable sessions, target repo branches, and lab processes according
to the operator cleanup policy. Then run:

```bash
scripts/workerctl reconcile --stale-cycles-seconds 1
git status --short --branch
```

Report using [evidence-template.md](evidence-template.md).
