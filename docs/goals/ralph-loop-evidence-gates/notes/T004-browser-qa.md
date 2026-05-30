# T004 Browser QA Receipt

## Result

Done.

Ran a Playwright browser walkthrough against a local dashboard using a disposable workerctl database.

## Fixture

- DB: `/tmp/workerctl-ralph-loop-evidence-qa.db`
- Task: `qa-ralph-loop-evidence-gate`
- Worker: `qa-ralph-worker-no-tmux`
- Manager: `qa-ralph-manager-no-tmux`
- Loop policy: `max_iterations=3`, `current_iteration=1`, `required_before_continue=["ci_green"]`
- First manager request: `requested_iteration=2`, no CI-green evidence
- First correlation id: `ralph-loop-missing-ci`
- Evidence receipt: satisfied criterion with `evidence_type=ci_green`, `iteration=1`, `ralph_loop_run_id=<run-id>`, `status=green`, `correlation_id=ralph-loop-ci-green`
- Retry correlation id: `ralph-loop-ci-allowed`

## Blocked Dispatch Result

First dispatch returned:

- `state=blocked`
- `reason=missing_ci_green_evidence`
- `missing_evidence=["ci_green"]`
- `delivered=false`
- `target_worker_notified=false`
- `current_iteration=1`
- `max_iterations=3`
- `requested_iteration=2`
- `notification_id=null`
- `side_effect_started=false`
- `side_effect_completed=false`

## Allowed Retry Result

After the CI-green criterion evidence was recorded, the fresh retry dispatch returned:

- `state=pull_required`
- `delivery_mode=pull_required`
- `notification_id=1`
- `signal_type=continue_iteration` in routed notification evidence
- worker inbox contained `Run iteration 2 after CI green.`

## Browser Assertions

Opened `http://127.0.0.1:8799/` and asserted the dashboard contained:

- `continue_iteration`
- `missing_ci_green_evidence`
- `missing ci_green`
- `iteration 1/3`
- `requested 2`
- `target_worker_notified=false`
- `ralph-loop-missing-ci`
- `ralph-loop-ci-allowed`
- `1 notification`
- `pull_required to qa-ralph-worker-no-tmux`
- `Run iteration 2 after CI green.`
- `Inbox 1`
- `Pull inbox 1`

## Audit / Inbox / Replay Evidence

`workerctl audit qa-ralph-loop-evidence-gate --json --path /tmp/workerctl-ralph-loop-evidence-qa.db` showed:

- first `continue_iteration` command result `state=blocked`
- first command result `reason=missing_ci_green_evidence`
- first command result `missing_evidence=["ci_green"]`
- first correlation chain `ralph-loop-missing-ci` had no notification ids
- satisfied criterion evidence recorded `evidence_type=ci_green`
- second `continue_iteration` command result `state=pull_required`
- second correlation chain `ralph-loop-ci-allowed` had routed notification id `1`

`workerctl worker-inbox qa-ralph-loop-evidence-gate --json --path /tmp/workerctl-ralph-loop-evidence-qa.db` showed:

- one delivered item after the allowed retry
- `signal_type=continue_iteration`
- message `Run iteration 2 after CI green.`

`workerctl replay qa-ralph-loop-evidence-gate --json --path /tmp/workerctl-ralph-loop-evidence-qa.db` showed:

- blocked dispatch attempt with missing evidence
- satisfied CI-green criterion receipt
- allowed dispatch attempt and routed notification

The local dashboard server was stopped after the browser walkthrough.
