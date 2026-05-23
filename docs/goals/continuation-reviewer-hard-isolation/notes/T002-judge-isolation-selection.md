# T002 Judge Receipt: Isolation Boundary Selection

Decision: approved

Chosen mechanism: macOS `sandbox-exec` targeted filesystem denial plus sanitized reviewer cwd/env.

Rationale:
- The Scout evidence shows the current reviewer process is a normal subprocess with project cwd and inherited environment; that is insufficient for #130.
- `sandbox-exec` is present locally and CI runs on `macos-latest`, so the mechanism is deterministic enough for direct tests.
- Targeted denial of bound worker/manager rollout files and the workerctl DB gives a real enforced filesystem boundary without refactoring command execution broadly.
- Sanitized cwd/env are useful defense-in-depth but are not counted as the hard boundary by themselves.

Approved Worker objective:
Implement hard-isolated `continuation-reviewer` execution by wrapping reviewer commands with a macOS `sandbox-exec` profile that denies direct filesystem reads of bound worker/manager rollout artifacts and the workerctl DB, while preserving restricted stdin context, telemetry redaction, and failure-to-stop behavior.

Allowed files:
- `workerctl/commands.py`
- `workerctl/cli.py`
- `tests/test_workerctl.py`
- `README.md`
- `docs/goals/continuation-reviewer-hard-isolation/notes`

Required behavior:
- Resolve active task binding and bound session rows.
- Build denied paths from worker/manager `codex_session_path` and active DB path when known.
- Convert denied paths to realpaths before writing the sandbox profile.
- Run reviewer command through `/usr/bin/sandbox-exec -f <profile>`.
- Use a temporary isolated cwd and sanitized environment for the reviewer command.
- Record compact sandbox metadata in `subagent_run`, without raw paths or secrets in telemetry.
- Fail closed to `verdict=stop` when sandbox setup/execution fails.

Verification:
- `python3 -m unittest tests.test_workerctl.PairCommandTests.test_continuation_reviewer_runner_records_isolated_review tests.test_workerctl.PairCommandTests.test_continuation_reviewer_runner_failure_records_stop tests.test_workerctl.PairCommandTests.test_continuation_subagent_failure_records_stop_without_silent_approval -v`
- Add direct denial coverage for manager/worker rollout files and DB access.
- `python3 -m unittest tests.test_workerctl -v`
- `python3 -m py_compile workerctl/*.py`
- `git diff --check`

Stop if:
- `sandbox-exec` cannot be exercised in deterministic tests.
- Denied manager/worker rollout files can still be read by absolute path.
- Reviewer failures no longer produce `verdict=stop`.
- Telemetry or public output leaks raw rollout content, prompt/transcript content, stdout/stderr, or manager-private content.
- Implementation requires files outside the approved set.
