# T003 Worker Receipt - Continuation Reviewer Hard Isolation

## Result

Done.

## Implementation

- Added a `continuation-reviewer` execution wrapper that resolves the active task binding, reads bound worker/manager session rows, and builds a deny list from:
  - bound worker `codex_session_path`
  - bound manager `codex_session_path`
  - active workerctl DB path plus SQLite `-wal` and `-shm` companion paths
- Converts denied paths through `os.path.realpath(...)` before writing the sandbox profile.
- Runs reviewer commands through `/usr/bin/sandbox-exec -f <profile>` when available, from an isolated temporary cwd and with a stripped environment.
- Records compact sandbox metadata in `subagent_run.sandbox`:
  - `enabled`
  - `engine`
  - `profile`
  - `denied_path_count`
  - optional `setup_error`
- Redacts failure stdout/stderr from persisted failure metadata with boolean `stdout_redacted` / `stderr_redacted` markers.
- Redacts raw reviewer command arguments from `runner`; only the executable label and argument count are persisted.
- Preserves existing failure-to-stop routing for command failures, invalid JSON, timeout, missing active binding, and missing sandbox engine.
- Updated README guarantees and limitations.

## Files Changed

- `workerctl/commands.py`
- `tests/test_workerctl.py`
- `README.md`

## Verification

Passed:

- `python3 -m unittest tests.test_workerctl.PairCommandTests.test_continuation_reviewer_runner_records_isolated_review tests.test_workerctl.PairCommandTests.test_continuation_reviewer_runner_failure_records_stop tests.test_workerctl.PairCommandTests.test_continuation_reviewer_runner_sandbox_denies_bound_artifacts tests.test_workerctl.PairCommandTests.test_continuation_subagent_failure_records_stop_without_silent_approval -v`
- `python3 -m unittest tests.test_workerctl -v`
- `python3 -m py_compile workerctl/*.py`
- `git diff --check`
- `./scripts/rc-check`

## Evidence

- Focused sandbox test proves reviewer code cannot read the bound manager rollout, bound worker rollout, or active workerctl DB by absolute path; all three reads are denied and the review persists as `verdict=stop`.
- Existing success-path test still records a valid isolated review under sandbox execution.
- Existing failure-path test still records `verdict=stop`, operator routing, failed status, return code, and redacted stderr marker.
- Telemetry assertions continue to prove raw continuation payload/rationale strings are absent from `continuation_review_recorded` telemetry.

## Residual Risk

- This implementation is intentionally macOS-specific via `sandbox-exec`, matching current CI and T002's approved minimal slice. On machines without `sandbox-exec`, reviewer execution fails closed to `verdict=stop`.
