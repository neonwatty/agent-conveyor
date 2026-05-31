# Codex QA: General Loop Templates

Use this QA scenario to prove a named loop template can create a generic policy
run, Dispatch can block a manager-requested continuation before worker delivery
when required evidence is missing, and a fresh retry can reach the worker inbox
after evidence is recorded.

## Scenario

- Template: `visual_diff_loop`
- Task: `qa-general-loop-template`
- Default max iterations: `4`
- Required evidence before iteration 2: `reference_artifact`,
  `candidate_screenshot`, `visual_diff_report`, `diff_below_threshold`,
  `adversarial_check`
- Dispatcher role: mechanical routing and policy enforcement only
- Manager role: decide whether another visual pass is useful and record the
  evidence receipts
- Worker role: implement or inspect the UI, produce screenshots or HTML, and
  report artifact paths

## Setup

```bash
QA_TMPDIR="$(mktemp -d -t workerctl-loop-template.XXXXXX)"
export WORKERCTL_DB="$QA_TMPDIR/workerctl.db"
export WORKER_ROLLOUT="$QA_TMPDIR/rollout-worker.jsonl"
export MANAGER_ROLLOUT="$QA_TMPDIR/rollout-manager.jsonl"

python3 - <<'PY'
import json
import os
from pathlib import Path

fixtures = {
    "WORKER_ROLLOUT": "qa-loop-worker-session",
    "MANAGER_ROLLOUT": "qa-loop-manager-session",
}
for env_name, session_id in fixtures.items():
    Path(os.environ[env_name]).write_text(
        json.dumps({
            "type": "session_meta",
            "payload": {
                "id": session_id,
                "cwd": os.getcwd(),
                "originator": "codex-tui",
            },
        }) + "\n"
    )
PY

scripts/workerctl tasks --create qa-general-loop-template --goal "QA generic loop templates with visual-diff evidence." --path "$WORKERCTL_DB"
scripts/workerctl register-worker --name qa-loop-worker --pid $$ --codex-session "$WORKER_ROLLOUT" --cwd "$PWD" --path "$WORKERCTL_DB"
scripts/workerctl register-manager --name qa-loop-manager --pid $$ --codex-session "$MANAGER_ROLLOUT" --cwd "$PWD" --path "$WORKERCTL_DB"
scripts/workerctl bind --task qa-general-loop-template --worker qa-loop-worker --manager qa-loop-manager --path "$WORKERCTL_DB"
scripts/workerctl loop-templates --list --json
scripts/workerctl loop-templates --show visual_diff_loop --json
```

Acceptance criteria:

- `loop-templates --list` includes `visual_diff_loop`, `test_coverage_loop`,
  `pr_ci_merge_loop`, `build_then_clear`, and `compact_then_continue`.
- `loop-templates --show visual_diff_loop` shows the five required evidence
  fields, including `adversarial_check`, artifact requirements, recommended
  tools, cleanup policy, tags, and stop conditions.
- The quality templates `visual_diff_loop`, `test_coverage_loop`, and
  `pr_ci_merge_loop` expose `artifact_requirements["adversarial_check"]` with
  required `failure_mode`, `check`, and `result` fields, while
  `build_then_clear` and `compact_then_continue` do not require it.
- Worker and manager registration succeed without relying on `lsof` discovery
  because the commands pass explicit `--codex-session` rollout fixture paths.

## Template-Backed Run Creation

Create the template-backed run:

```bash
RUN_ID="$(scripts/workerctl loop-templates --create-run qa-general-loop-template \
  --template visual_diff_loop \
  --name qa-visual-template-run \
  --max-iterations 4 \
  --current-iteration 1 \
  --seed-prompt-sha256 visual-template-seed \
  --json \
  --path "$WORKERCTL_DB" | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')"
```

Acceptance criteria:

- The created run has `purpose=ralph_loop`.
- The metadata has `template=visual_diff_loop`, `preset=visual_diff_loop`,
  `max_iterations=4`, `current_iteration=1`, and `cleanup_policy=compact`.
- The metadata includes `required_before_continue` with
  `reference_artifact`, `candidate_screenshot`, `visual_diff_report`, and
  `diff_below_threshold`, and `adversarial_check`.

## Missing Evidence Block

Queue a manager continuation before visual evidence exists:

```bash
DECISION_ID="$(scripts/workerctl record-decision qa-general-loop-template nudge \
  --reason "Manager requests visual iteration 2 before visual evidence exists." \
  --payload-json "{\"loop_run_id\":\"$RUN_ID\",\"requested_iteration\":2,\"template\":\"visual_diff_loop\",\"correlation_id\":\"visual-loop-missing\"}" \
  --path "$WORKERCTL_DB" | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')"

scripts/workerctl enqueue-continue-iteration qa-general-loop-template \
  --loop-run "$RUN_ID" \
  --requested-iteration 2 \
  --manager-decision-id "$DECISION_ID" \
  --correlation-id visual-loop-missing \
  --message "Run visual iteration 2." \
  --json \
  --path "$WORKERCTL_DB"

scripts/workerctl dispatch --once --type continue_iteration --dispatcher-id qa-loop-template --json --path "$WORKERCTL_DB"
scripts/workerctl worker-inbox qa-general-loop-template --json --path "$WORKERCTL_DB"
```

Acceptance criteria:

- Dispatch result includes `state=blocked`.
- Dispatch result includes `reason=missing_required_evidence`.
- Dispatch result includes all five missing evidence names in order.
- Dispatch result includes `delivered=false` and `target_worker_notified=false`.
- `scripts/workerctl worker-inbox qa-general-loop-template --json --path "$WORKERCTL_DB"`
  returns no items.
- Dashboard Dispatch panel shows the correlation `visual-loop-missing`,
  `0 notifications`, `Inbox 0`, and `Pull inbox 0`.

## Allowed Retry After Evidence

Record visual evidence as satisfied criteria:

```bash
scripts/workerctl loop-evidence add qa-general-loop-template \
  --loop-run "$RUN_ID" \
  --iteration 1 \
  --evidence-type reference_artifact \
  --artifact-path /tmp/reference.png \
  --correlation-id visual-loop-reference \
  --path "$WORKERCTL_DB"

scripts/workerctl loop-evidence add qa-general-loop-template \
  --loop-run "$RUN_ID" \
  --iteration 1 \
  --evidence-type candidate_screenshot \
  --artifact-path /tmp/candidate.png \
  --metadata-json "{\"viewport\":\"1440x900\"}" \
  --correlation-id visual-loop-candidate \
  --path "$WORKERCTL_DB"

scripts/workerctl loop-evidence visual-diff qa-general-loop-template \
  --loop-run "$RUN_ID" \
  --iteration 1 \
  --reference /tmp/reference.png \
  --candidate /tmp/candidate.png \
  --threshold 0.02 \
  --diff-output /tmp/visual-diff.png \
  --report-output /tmp/visual-diff.json \
  --correlation-id visual-loop-report \
  --path "$WORKERCTL_DB"

scripts/workerctl loop-evidence adversarial-check qa-general-loop-template \
  --loop-run "$RUN_ID" \
  --iteration 1 \
  --failure-mode "visual pass still hides a regression after diff artifacts are present" \
  --check "inspect visual diff report and candidate screenshot" \
  --result "report and screenshot match the accepted threshold with no unresolved blocker" \
  --correlation-id visual-loop-adversarial \
  --path "$WORKERCTL_DB"
```

Queue and dispatch a fresh retry:

```bash
scripts/workerctl enqueue-continue-iteration qa-general-loop-template \
  --loop-run "$RUN_ID" \
  --requested-iteration 2 \
  --correlation-id visual-loop-allowed \
  --message "Run visual iteration 2 after evidence receipts." \
  --json \
  --path "$WORKERCTL_DB"

scripts/workerctl dispatch --once --type continue_iteration --dispatcher-id qa-loop-template --json --path "$WORKERCTL_DB"
scripts/workerctl worker-inbox qa-general-loop-template --consume-next --wait --timeout 2 --json --path "$WORKERCTL_DB"
scripts/workerctl telemetry --task qa-general-loop-template --event-type dispatch_inbox_consumed --json --path "$WORKERCTL_DB"
```

Acceptance criteria:

- Dispatch result includes `state=pull_required` for a non-tmux worker.
- `loop-evidence visual-diff` records `visual_diff_report` and marks
  `diff_below_threshold` satisfied only when the computed
  `diff_score <= threshold`.
- `loop-evidence adversarial-check` records `adversarial_check` with
  `failure_mode`, `check`, and `result` metadata before the retry is allowed.
- Routed notification has `signal_type=continue_iteration`.
- Worker inbox consumption returns the visual iteration message.
- Telemetry includes `dispatch_inbox_consumed`.
- Replay and audit connect `visual-loop-allowed` to the command attempt, routed
  notification, worker inbox item, and consumption event.

## Max Iteration Cutoff

Create a second run at its max:

```bash
MAX_RUN_ID="$(scripts/workerctl loop-templates --create-run qa-general-loop-template \
  --template visual_diff_loop \
  --name qa-visual-max-run \
  --max-iterations 1 \
  --current-iteration 1 \
  --json \
  --path "$WORKERCTL_DB" | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')"

scripts/workerctl enqueue-continue-iteration qa-general-loop-template \
  --loop-run "$MAX_RUN_ID" \
  --requested-iteration 2 \
  --correlation-id visual-loop-max-block \
  --message "Run visual iteration 2." \
  --json \
  --path "$WORKERCTL_DB"

scripts/workerctl dispatch --once --type continue_iteration --dispatcher-id qa-loop-template --json --path "$WORKERCTL_DB"
scripts/workerctl worker-inbox qa-general-loop-template --json --path "$WORKERCTL_DB"
```

Acceptance criteria:

- Dispatch result includes `state=blocked`.
- Dispatch result includes `reason=max_iterations_reached`.
- Dispatch result includes `delivered=false` and `target_worker_notified=false`.
- Worker inbox receives no item for `visual-loop-max-block`.

## Export Evidence

Export the task evidence for review:

```bash
scripts/workerctl replay qa-general-loop-template --json --path "$WORKERCTL_DB" > /tmp/qa-general-loop-template-replay.json
scripts/workerctl telemetry --task qa-general-loop-template --json --path "$WORKERCTL_DB" > /tmp/qa-general-loop-template-telemetry.json
scripts/workerctl export-task qa-general-loop-template --zip --path "$WORKERCTL_DB"
```

Acceptance criteria:

- Replay includes the blocked `visual-loop-missing` attempt, the allowed
  `visual-loop-allowed` attempt, and the max cutoff `visual-loop-max-block`
  attempt.
- Telemetry includes the `dispatch_inbox_consumed` event from the consumed
  worker inbox item.
- The export bundle includes replay, telemetry, criteria evidence, command
  attempts, and routed notification evidence for the visual-diff drill.
