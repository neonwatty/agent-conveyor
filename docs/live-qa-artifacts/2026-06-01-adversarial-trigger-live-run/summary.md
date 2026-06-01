# Adversarial Trigger Live Run

Date: 2026-06-01
Branch: `codex/conveyor-receipt-live-run`
Base merge: `37c3a16f9380b49730bf8f68a0c0c4067262530f`

## Result

Pass, with one follow-up finding.

## Disposable Inputs

- `WORKERCTL_DB`: `/var/folders/wt/nn4g5swd3gd139y9r6yw6x_80000gn/T/workerctl-adversarial-live.XXXXXX.sqlite.oRMCYwjaaQ`
- Synthetic rollout file: `/var/folders/wt/nn4g5swd3gd139y9r6yw6x_80000gn/T/rollout-adversarial-live.XXXXXX.jsonl.Nzm3doJtNw`
- No tracked-file edits were produced by the disposable live run.

## Proof Summary

- Loop gate trigger passed: `runs --list --task qa-trigger-loop` exposed a `ralph_loop` policy whose `metadata.required_before_continue` includes `adversarial_check`.
- Iteration gate trigger passed: Dispatch blocked `continue_iteration` before proof with `state=blocked`, `delivered=false`, `target_worker_notified=false`, and `missing_evidence=[adversarial_check]`.
- Blocked continuation left the worker inbox empty.
- After `loop-evidence adversarial-check`, a fresh retry delivered through the no-tmux mailbox path with `state=pull_required`.
- Finish gate trigger passed on an unbound disposable task: `finish-task --require-adversarial-proof` failed closed before structured proof and succeeded after proof.
- Worker-directed proof trigger passed: a mailbox nudge delivered the `failure_mode`, `check`, `result` response contract, and manager-recorded evidence persisted with `source=worker_proposed`.
- Manager-created adversarial criteria trigger passed: a `manager_inferred` accepted criterion was satisfied only with structured adversarial evidence after negative receipt checks.
- Replay, audit, commands with attempts, worker inbox, and export-task commands ran for the iteration gate task.

## Live Run IDs

- Loop policy run: `run-79e1f5c1-972d-4a84-b1c5-c86037fbca79`
- Iteration gate run: `run-903252d1-ee03-4b27-b25d-ca8f97db1085`
- Finish gate run: `run-5ae3dafb-d038-4c93-8b28-8abf5230bef1`
- Worker-directed run: `run-ad892933-896c-472b-891f-9036d2d55c34`
- Manager-created criterion id: `4`

## Follow-Up Finding

Bound no-tmux managers can receive dispatcher mailbox work, but `finish-task` still verifies the bound manager through tmux identity and fails with `tmux_session_missing`. The finish-gate drill therefore used an unbound disposable task for this slice. The next prompt-contract or Codex-app-manager slice should decide whether `finish-task` should accept first-class Codex-app manager identity for bound no-tmux managers.
