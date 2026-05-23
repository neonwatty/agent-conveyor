# T001 Scout Receipt: Continuation Reviewer Isolation Map

Result: done

## Current Execution Path

`workerctl continuation-reviewer` is implemented in `workerctl/commands.py`.

Relevant source surfaces:
- `_validate_continuation_review_payload` validates reviewer/manager session separation and requires `manager_rollout_access=false`.
- `_continuation_reviewer_context` builds the restricted stdin context. It includes task metadata, paired continuation proposals, acceptance criteria, manager config summary, git diff metadata, recent PR metadata, and constraints.
- `command_continuation_reviewer` runs the reviewer command with:
  - `subprocess.run(reviewer_command, cwd=str(PROJECT_ROOT), input=json.dumps(context), capture_output=True, text=True, timeout=args.timeout)`
  - no sandbox wrapper
  - normal project cwd
  - inherited process environment
  - normal filesystem access
- `_reviewer_failure_payload` converts runner failures/timeouts/invalid output into `agreement=divergent`, `verdict=stop`.
- `_record_continuation_review` persists the review and emits structured redacted telemetry.

Current docs:
- `README.md` describes the reviewer as independent restricted-context review and explicitly says it is not a hard process or filesystem sandbox.

Current tests:
- `PairCommandTests.test_continuation_reviewer_runner_records_isolated_review` proves restricted stdin context and telemetry redaction, not hard filesystem/process isolation.
- `PairCommandTests.test_continuation_reviewer_runner_failure_records_stop` proves reviewer command failures produce stop verdicts.
- `PairCommandTests.test_continuation_subagent_failure_records_stop_without_silent_approval` proves manually recorded subagent failure cannot silently approve.

## Existing Guarantees

Already present:
- Worker proposal must be submitted before manager proposal.
- Manager cannot read worker payload before submitting its own proposal.
- Reviewer must have a distinct reviewer session id.
- Reviewer metadata must record `manager_rollout_access=false`.
- Reviewer stdin context omits manager rollout/session artifacts.
- Reviewer failure, timeout, or invalid JSON routes to `verdict=stop`.
- Continuation-review telemetry is structured and does not include raw proposal/rationale/addendum/stdout/stderr content.

Not yet present:
- Any enforced boundary preventing a reviewer subprocess from opening files by absolute path.
- Any enforced environment stripping.
- Any enforced cwd separation.
- Any denied access test for bound manager/worker rollout artifacts or the workerctl DB.

## Concrete Leak Paths

- `cwd=str(PROJECT_ROOT)` lets reviewer code discover repository files and relative paths.
- Inherited environment can leak operator-local variables and tool configuration.
- Normal filesystem access lets reviewer code read:
  - bound manager `sessions.codex_session_path`
  - bound worker `sessions.codex_session_path`
  - `.codex-workers/workerctl.db` or the explicit `--path` database
  - any repo-local artifacts, unless separately denied
- Captured stdout/stderr are truncated into internal `command_result`; failure payload currently stores stderr under `subagent_run.stderr`, though telemetry does not expose it.
- Dry-run intentionally prints allowed context and reviewer command; it should stay diagnostic and not be treated as isolated execution.

## Platform / CI Constraints

- CI runs deterministic tests on `macos-latest` in `.github/workflows/test.yml`.
- Local platform is macOS/Darwin and `/usr/bin/sandbox-exec` is present.
- Probe result: `sandbox-exec` can enforce file denial when profile paths use realpaths (`/private/var/...` rather than `/var/...`).
- Probe result: `sandbox-exec -p '(version 1)(deny default)' /bin/echo hi` blocks execution, proving enforcement is active.
- Probe result: `(allow default)(deny file-read* (subpath "<realpath>"))` denies reading a specific temp file while still allowing normal process startup.

## Candidate Isolation Mechanisms

1. macOS `sandbox-exec` targeted deny profile
   - Enforceability: real filesystem denial for configured paths.
   - CI feasibility: high, because repo CI runs on `macos-latest`.
   - Blast radius: low if applied only to `continuation-reviewer`.
   - Compatibility: preserves arbitrary reviewer command execution as long as command dependencies remain readable.
   - Limitation: macOS-specific. It should fail closed or require explicit platform support when unavailable.
   - Good fit for #130 acceptance criteria if denied paths include bound manager/worker rollout files and the workerctl DB.

2. Sanitized cwd/env/tempdir only
   - Enforceability: weak. Absolute paths remain readable.
   - CI feasibility: high.
   - Blast radius: low.
   - Limitation: does not satisfy hard isolation by itself.
   - Good as defense-in-depth only.

3. Python-only monkeypatch / wrapper command
   - Enforceability: weak against arbitrary reviewer commands and subprocesses.
   - CI feasibility: high.
   - Limitation: not a process/filesystem boundary.
   - Not enough for #130.

4. chroot/container
   - Enforceability: strong.
   - CI feasibility: poor without privileges/container setup.
   - Blast radius: high.
   - Not a good first slice for this repo.

## Recommended Worker Slice

Implement macOS `sandbox-exec` enforcement for `continuation-reviewer`.

Suggested behavior:
- Resolve the active binding for the task.
- Fetch bound worker and manager session rows.
- Build a denied-path list:
  - manager `codex_session_path`
  - worker `codex_session_path`
  - active workerctl DB path, when known
  - optionally `.codex-workers` under repo root
- Convert denied paths to realpaths before writing the sandbox profile.
- Run reviewer command through `/usr/bin/sandbox-exec -f <temporary-profile> -- <reviewer-command...>`.
- Use a temporary isolated cwd for the reviewer process unless a command-specific cwd is later approved.
- Pass a sanitized environment with only minimal variables required to find executables, e.g. `PATH`, `HOME` only if needed, and locale variables.
- Record `subagent_run.sandbox` metadata such as:
  - `enabled: true`
  - `engine: "sandbox-exec"`
  - `denied_path_count`
  - `cwd`
  - `env_keys`
- Preserve failure-to-stop behavior when:
  - `sandbox-exec` is missing
  - profile creation fails
  - reviewer command exits non-zero due to denied access
  - reviewer output is invalid JSON

Suggested allowed files:
- `workerctl/commands.py`
- `workerctl/cli.py`
- `tests/test_workerctl.py`
- `README.md`
- `docs/goals/continuation-reviewer-hard-isolation/notes`

Suggested tests:
- Existing continuation-reviewer success/failure tests remain green.
- New test creates bound worker/manager rollout files with secret content and a reviewer that tries to open the manager rollout by absolute path; sandbox denial must force `verdict=stop` and must not leak the secret.
- New test verifies allowed stdin context still works under sandbox.
- New test verifies missing sandbox engine or sandbox setup failure routes to `verdict=stop`, not proceed.
- Telemetry assertions should continue proving raw payloads/stdout/stderr/secrets are not emitted.

Suggested stop conditions:
- `sandbox-exec` is not available in CI and no equivalent enforced boundary exists.
- Denial tests require broad platform-specific test skips that make the acceptance evidence indirect.
- The implementation must expose raw rollout paths/secrets in telemetry or public output.
- The reviewer command can still read denied manager/session artifacts by absolute path in tests.
