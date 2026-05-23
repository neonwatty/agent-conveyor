# T001 Scout Receipt - Gap Validation

## Result

Done.

## Gap Matrix

| Gap | Status | Evidence |
| --- | --- | --- |
| Reviewer automation failure can avoid operator routing under `auto-proceed`. | Confirmed | `_record_continuation_review` computes `operator_routing_required = agreement == "divergent" and nudge_mode != "auto-proceed"` in `workerctl/commands.py`. `_reviewer_failure_payload` produces `agreement="divergent"` and `verdict="stop"`, but no field distinguishes automation failure from a normal divergent review at routing time. Existing failure test uses `ask-operator`, not `auto-proceed`. |
| Missing sandbox setup fail-closed test. | Confirmed | `_run_continuation_reviewer_command` returns a failed command result when `shutil.which("sandbox-exec")` is missing, but no `PairCommandTests` test patches or exercises that branch. |
| Missing invalid JSON failure test. | Confirmed | `command_continuation_reviewer` parses `json.loads(command_result["stdout"])` and routes JSON errors through `_reviewer_failure_payload`; current tests do not cover invalid stdout. |
| Missing timeout failure test. | Confirmed | `_run_continuation_reviewer_command` catches `subprocess.TimeoutExpired` and returns an error; current tests do not cover reviewer timeout. |
| Temporary cwd and stripped environment are claimed but unproven. | Confirmed | `_run_continuation_reviewer_command` runs from `TemporaryDirectory(...)` and passes `_continuation_reviewer_env()`, but current success-path test only checks allowed stdin context and sandbox metadata. |
| DB sidecar denial is implemented but unproven. | Confirmed | `_continuation_reviewer_denied_paths` denies DB, `-wal`, and `-shm`; the sandbox denial test only attempts the main DB path plus worker/manager rollout files. |
| Broader `.codex-workers` artifacts may be in "session artifacts" scope. | Ambiguous / scope decision required | Current denial covers bound `codex_session_path` files and DB sidecars, not arbitrary `.codex-workers` transcripts, captures, or task state. README documents the narrower rollout/database guarantee. Whether to expand is a product/security scope choice, not a source contradiction. |

## Existing Covered Behavior

- `test_continuation_reviewer_runner_records_isolated_review` proves a normal reviewer command succeeds under sandbox execution and records sandbox metadata.
- `test_continuation_reviewer_runner_failure_records_stop` proves a nonzero reviewer command with `ask-operator` records `agreement=divergent`, `verdict=stop`, `operator_routing_required=true`, failed status, return code, and stderr redaction.
- `test_continuation_reviewer_runner_sandbox_denies_bound_artifacts` proves absolute reads of bound manager rollout, bound worker rollout, and main DB are denied and do not leak the seeded secrets.
- README distinguishes metadata/context isolation from macOS `sandbox-exec` denial of bound rollout/database reads.

## Recommended Grouping

Largest safe useful Worker slice:

1. Fix automation-failure routing so reviewer runner failures always require operator routing, including `nudge_on_completion="auto-proceed"`.
2. Add focused failure-path tests for:
   - failed reviewer under `auto-proceed`;
   - unavailable sandbox engine / setup failure;
   - invalid JSON stdout;
   - timeout.
3. Add proof tests for:
   - temp cwd and stripped env;
   - DB `-wal` and `-shm` sidecar denial.

Broader `.codex-workers` artifact denial should be a Judge decision. Scout recommends treating it as out of scope for the immediate behavioral/QA hardening slice unless Judge finds issue #130 or docs require more than the current rollout/database guarantee. If out of scope, create a follow-up issue for "general reviewer containment" only if the project wants broader filesystem hardening.

## Stop Conditions For Worker

- Stop if a proposed fix requires changing unrelated dispatch/dashboard behavior.
- Stop if failure paths would expose raw stdout, stderr, rollout content, DB content, prompts, transcripts, or secrets in review output or telemetry.
- Stop if sandbox setup failure cannot be tested deterministically without platform-specific flakiness.
- Stop before broadening denied paths beyond bound rollouts and DB sidecars unless Judge explicitly approves that scope.
