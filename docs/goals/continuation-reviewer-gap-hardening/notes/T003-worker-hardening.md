# T003 Worker Receipt - Continuation Reviewer Gap Hardening

## Result

Done.

## Changed Files

- `workerctl/commands.py`
- `tests/test_workerctl.py`

## Summary

- Fixed reviewer automation failure routing so a failed reviewer run forces operator routing even when `nudge_on_completion="auto-proceed"`.
- Added telemetry attribute `reviewer_failure_routing_forced` for the forced-routing path.
- Added direct test helpers for continuation-reviewer setup and same-process command invocation.
- Added tests for:
  - failed reviewer command under `auto-proceed`;
  - missing `sandbox-exec` fail-closed behavior;
  - invalid JSON stdout fail-closed behavior;
  - timeout fail-closed behavior;
  - temporary cwd and stripped environment proof;
  - DB `-wal` and `-shm` sidecar denial proof in addition to manager/worker rollout and main DB denial.

## Verification

Passed:

- `python3 -m unittest tests.test_workerctl.PairCommandTests -v`
- `python3 -m unittest tests.test_workerctl -v`
- `python3 -m py_compile workerctl/*.py`
- `git diff --check`
- `./scripts/rc-check`

## Evidence

- `PairCommandTests` now has 42 passing tests.
- Full `tests.test_workerctl` now has 441 passing tests.
- The new `auto-proceed` test asserts `operator_routing_required=true`, warning telemetry, and `reviewer_failure_routing_forced=true`.
- Failure-path tests assert failed status and stop verdicts without leaking raw stderr/stdout.
- Isolation-proof tests assert temp cwd/stripped env and denial of rollout, main DB, WAL, and SHM reads.

## Out Of Scope

Broader `.codex-workers` transcript/capture/task artifact denial remains out of scope per T002 and should be tracked separately during PM issue hygiene.
